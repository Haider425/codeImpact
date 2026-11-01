import type {
  CallerImpact,
  CallShape,
  ChangeKind,
  ChangeRecord,
  EdgeRecord,
  Parameter,
  ParseResult,
  ReviewFinding,
  ReviewLocation,
  Severity,
  SourceFile,
  SymbolRecord,
} from './types'

export const RULES = {
  missingArgument: 'signature/missing-argument',
  tooManyArguments: 'signature/too-many-arguments',
  unknownKeyword: 'signature/unknown-keyword',
  reorderedParameters: 'signature/reordered-parameters',
  removedSymbol: 'reference/removed-symbol',
  renamedSymbol: 'reference/renamed-symbol',
  brokenImport: 'reference/broken-import',
  unupdatedCaller: 'impact/unupdated-caller',
} as const

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 }

/** Decorators known to keep the wrapped function's call signature. Anything else might change it. */
const SIGNATURE_PRESERVING_DECORATORS = new Set([
  'staticmethod', 'classmethod', 'property', 'abstractmethod', 'abc.abstractmethod', 'override', 'typing.override',
  'cache', 'functools.cache', 'lru_cache', 'functools.lru_cache', 'cached_property', 'functools.cached_property',
  'typing.final', 'final', 'deprecated', 'typing_extensions.deprecated', 'warnings.deprecated',
])

export interface ReviewInput {
  base: ParseResult
  head: ParseResult
  changes: ChangeRecord[]
  /** Merged edges as produced by the engine, tagged with `evidenceRevision`. */
  edges: EdgeRecord[]
  headFiles: SourceFile[]
  /** Paths whose content differs between base and head. */
  changedPaths: Set<string>
}

interface Problem { ruleId: string; detail: string }

/** Inferred links and signature-altering decorators can only ever produce low-severity findings. */
function severity(wanted: Severity, confirmed: boolean): Severity {
  return confirmed ? wanted : 'low'
}

function signatureIsReliable(symbol: SymbolRecord) {
  return (symbol.decorators ?? []).every((decorator) => SIGNATURE_PRESERVING_DECORATORS.has(decorator))
}

/** Parameters a caller must supply, after accounting for an implicit `self`/`cls`. */
function callableParams(target: SymbolRecord, call: CallShape): Parameter[] | undefined {
  if (!target.params) return undefined
  if (target.language !== 'python' || target.kind !== 'method') return target.params
  const decorators = target.decorators ?? []
  if (decorators.includes('staticmethod')) return target.params
  if (decorators.includes('classmethod') || call.receiver !== 'unbound') return target.params.slice(1)
  return target.params
}

const positionalSlots = (params: Parameter[]) => params.filter((p) => p.kind === 'positional' || p.kind === 'positional-only')

/** Check one call site against one parameter list. Spread arguments make the call unverifiable. */
export function checkCall(call: CallShape, params: Parameter[]): Problem[] {
  if (call.spread) return []
  const slots = positionalSlots(params)
  const acceptsVarPositional = params.some((p) => p.kind === 'var-positional')
  const acceptsVarKeyword = params.some((p) => p.kind === 'var-keyword')
  const problems: Problem[] = []

  if (call.positional > slots.length && !acceptsVarPositional) {
    problems.push({ ruleId: RULES.tooManyArguments, detail: `passes ${call.positional} positional argument${call.positional === 1 ? '' : 's'} but it now accepts ${slots.length}` })
  }
  const filled = new Set(slots.slice(0, call.positional).map((p) => p.name))
  for (const keyword of call.keywords) {
    const param = params.find((p) => p.name === keyword && (p.kind === 'positional' || p.kind === 'keyword-only'))
    if (param) filled.add(keyword)
    else if (!acceptsVarKeyword) problems.push({ ruleId: RULES.unknownKeyword, detail: `passes keyword \`${keyword}\`, which is no longer a parameter` })
  }
  const missing = params.filter((p) => p.required && p.kind !== 'var-positional' && p.kind !== 'var-keyword' && !filled.has(p.name))
  if (missing.length > 0) {
    problems.push({ ruleId: RULES.missingArgument, detail: `does not pass required parameter${missing.length === 1 ? '' : 's'} ${missing.map((p) => `\`${p.name}\``).join(', ')}` })
  }
  return problems
}

function renamedParameter(keyword: string, before: Parameter[], after: Parameter[]) {
  const index = before.findIndex((p) => p.name === keyword)
  const replacement = index >= 0 ? after[index] : undefined
  return replacement && !before.some((p) => p.name === replacement.name) ? replacement.name : undefined
}

function location(symbol: SymbolRecord, revision: 'base' | 'head', line = symbol.startLine): ReviewLocation {
  return { path: symbol.path, line, revision, symbolId: symbol.id, symbol: symbol.qualifiedName }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** First line inside `scope` that still calls `name`, or undefined if the reference was removed. */
function referenceLine(scope: SymbolRecord, file: SourceFile | undefined, name: string, viaMember: boolean) {
  const pattern = new RegExp(`${viaMember ? '\\.' : '(?<![\\w])'}${escapeRegExp(name)}\\s*\\(`)
  const lines = scope.kind === 'file' ? (file?.source ?? '').split('\n') : scope.source.split('\n')
  const offset = scope.kind === 'file' ? 1 : scope.startLine
  const index = lines.findIndex((text) => pattern.test(text))
  return index >= 0 ? offset + index : undefined
}

export interface ChangeClassification {
  kinds: ChangeKind[]
  newRaises: string[]
  returnType?: { from?: string; to?: string }
  defaults: { name: string; from?: string; to?: string }[]
  types: { name: string; from?: string; to?: string }[]
}

/** Describe what changed in a function's observable contract, from parsed structure rather than text diffs. */
export function classifyChange(before: SymbolRecord, after: SymbolRecord): ChangeClassification {
  const kinds: ChangeKind[] = []
  const oldBehavior = before.behavior ?? { returns: [], raises: [] }
  const newBehavior = after.behavior ?? { returns: [], raises: [] }
  const result: ChangeClassification = { kinds, newRaises: [], defaults: [], types: [] }

  if (oldBehavior.returns.join('\n') !== newBehavior.returns.join('\n')) kinds.push('return-value')
  if (oldBehavior.returnType !== newBehavior.returnType) {
    kinds.push('return-type')
    result.returnType = { from: oldBehavior.returnType, to: newBehavior.returnType }
  }
  result.newRaises = newBehavior.raises.filter((type) => type !== '<re-raise>' && !oldBehavior.raises.includes(type))
  if (result.newRaises.length > 0) kinds.push('raises')

  const oldParams = new Map((before.params ?? []).map((param) => [param.name, param]))
  for (const param of after.params ?? []) {
    const old = oldParams.get(param.name)
    if (!old) continue
    if (old.default !== param.default) result.defaults.push({ name: param.name, from: old.default, to: param.default })
    if (old.type !== param.type) result.types.push({ name: param.name, from: old.type, to: param.type })
  }
  if (result.defaults.length > 0) kinds.push('defaults')
  if (result.types.length > 0) kinds.push('param-types')
  const shape = (params: Parameter[] = []) => params.map((p) => `${p.name}:${p.kind}:${p.required}`).join(',')
  if (shape(before.params) !== shape(after.params)) kinds.push('parameters')
  if (kinds.length === 0) kinds.push('internals')
  return result
}

function describeKinds(classification: ChangeClassification) {
  const labels: Record<ChangeKind, string> = {
    'return-value': 'return value',
    'return-type': `return type ${classification.returnType?.from ?? 'unannotated'} → ${classification.returnType?.to ?? 'unannotated'}`,
    raises: `now raises ${classification.newRaises.map((type) => `\`${type}\``).join(', ')}`,
    defaults: `default of ${classification.defaults.map((d) => `\`${d.name}\``).join(', ')}`,
    'param-types': `type of ${classification.types.map((t) => `\`${t.name}\``).join(', ')}`,
    parameters: 'parameter list',
    internals: 'internals only',
  }
  return classification.kinds.map((kind) => labels[kind]).join(', ')
}

function catches(caught: string[] | null, type: string) {
  if (!caught) return false
  const short = type.split('.').pop()
  return caught.some((name) => name === '*' || name === type || name.split('.').pop() === short)
}

/** Why this call site is exposed to the change, or an empty list when its usage does not touch what changed. */
export function callerExposure(classification: ChangeClassification, after: SymbolRecord, call: CallShape): string[] {
  const reasons: string[] = []
  const kinds = new Set(classification.kinds)
  if ((kinds.has('return-value') || kinds.has('return-type')) && call.resultUsed) {
    reasons.push(kinds.has('return-type')
      ? `uses the return value, whose type changed (${classification.returnType?.from ?? 'unannotated'} → ${classification.returnType?.to ?? 'unannotated'})`
      : 'uses the return value, and the returned expression changed')
  }
  const uncaught = classification.newRaises.filter((type) => !catches(call.caught, type))
  if (uncaught.length > 0) {
    reasons.push(`${call.caught ? 'has a try block that' : 'is not inside a try block, so it'} does not catch ${uncaught.map((type) => `\`${type}\``).join(', ')}`)
  }
  const params = callableParams(after, call) ?? []
  const passes = (name: string) => {
    const index = positionalSlots(params).findIndex((param) => param.name === name)
    return (index >= 0 && index < call.positional) || call.keywords.includes(name)
  }
  if (!call.spread) {
    for (const change of classification.defaults) {
      if (!passes(change.name)) reasons.push(`relies on the default of \`${change.name}\` (${change.from ?? 'none'} → ${change.to ?? 'none'})`)
    }
    for (const change of classification.types) {
      if (passes(change.name)) reasons.push(`passes \`${change.name}\`, whose type changed (${change.from ?? 'untyped'} → ${change.to ?? 'untyped'})`)
    }
  }
  return reasons
}

export function reviewContracts(input: ReviewInput): ReviewFinding[] {
  const headSymbols = new Map(input.head.symbols.map((symbol) => [symbol.id, symbol]))
  const baseSymbols = new Map(input.base.symbols.map((symbol) => [symbol.id, symbol]))
  const headFiles = new Map(input.headFiles.map((file) => [file.path, file]))
  const changedIds = new Set(input.changes.flatMap((change) => [change.symbolId, ...(change.previousId ? [change.previousId] : [])]))
  const headCalls = input.edges.filter((edge) => edge.type === 'calls' && edge.evidenceRevision !== 'base')
  const findings: ReviewFinding[] = []
  const flaggedEdges = new Set<string>()

  const add = (finding: Omit<ReviewFinding, 'id' | 'source'>) => {
    findings.push({
      ...finding,
      source: 'rule',
      id: `${finding.ruleId}:${finding.changed.symbolId ?? finding.changed.path}:${finding.affected.path}:${finding.affected.line}`,
    })
  }

  for (const change of input.changes) {
    const before = change.base
    const after = change.head

    // Signature contracts: callers whose call matched the old parameters but not the new ones.
    if (before && after && before.params && after.params && (after.kind === 'function' || after.kind === 'method')) {
      for (const edge of headCalls.filter((candidate) => candidate.target === after.id && candidate.call)) {
        const call = edge.call!
        const caller = headSymbols.get(edge.source)
        const newParams = callableParams(after, call)
        const oldParams = callableParams(before, call)
        if (!caller || !newParams || !oldParams) continue
        if (checkCall(call, oldParams).length > 0) continue // Already incompatible before this PR; not caused by it.
        const confirmed = edge.resolutionStatus === 'resolved' && signatureIsReliable(after) && signatureIsReliable(before)
        const problems = checkCall(call, newParams)

        for (const problem of problems) {
          let detail = problem.detail
          if (problem.ruleId === RULES.unknownKeyword) {
            const keyword = detail.match(/`([^`]+)`/)?.[1] ?? ''
            const renamed = renamedParameter(keyword, oldParams, newParams)
            if (renamed) detail = `passes keyword \`${keyword}\`, which was renamed to \`${renamed}\``
          }
          add({
            ruleId: problem.ruleId,
            severity: severity('high', confirmed),
            confidence: confirmed ? 'confirmed' : 'inferred',
            message: `\`${caller.qualifiedName}\` calls \`${after.qualifiedName}\` and ${detail}.`,
            changed: location(after, 'head'),
            affected: { path: edge.evidencePath, line: edge.evidenceLine, revision: 'head', symbolId: caller.id, symbol: caller.qualifiedName },
            evidence: [edge.id],
          })
          flaggedEdges.add(edge.id)
        }

        // Same parameter names in a new order: positional callers that were not touched now bind differently.
        const oldOrder = positionalSlots(oldParams).map((p) => p.name)
        const newOrder = positionalSlots(newParams).map((p) => p.name)
        const firstMoved = oldOrder.findIndex((name, index) => newOrder[index] !== name)
        const sameNames = oldOrder.length === newOrder.length && [...oldOrder].sort().join() === [...newOrder].sort().join()
        if (problems.length === 0 && sameNames && firstMoved >= 0 && call.positional > firstMoved && !changedIds.has(caller.id)) {
          add({
            ruleId: RULES.reorderedParameters,
            severity: severity('high', confirmed),
            confidence: confirmed ? 'confirmed' : 'inferred',
            message: `\`${caller.qualifiedName}\` passes positional arguments to \`${after.qualifiedName}\`, whose parameters were reordered from (${oldOrder.join(', ')}) to (${newOrder.join(', ')}); the caller was not updated.`,
            changed: location(after, 'head'),
            affected: { path: edge.evidencePath, line: edge.evidenceLine, revision: 'head', symbolId: caller.id, symbol: caller.qualifiedName },
            evidence: [edge.id],
          })
          flaggedEdges.add(edge.id)
        }
      }
    }

    // Removed or renamed symbols that surviving code still calls or imports.
    if (change.changeType === 'deleted' || change.changeType === 'renamed') {
      const oldId = change.changeType === 'renamed' ? change.previousId! : change.symbolId
      const old = before ?? baseSymbols.get(oldId)
      if (!old) continue
      const ruleId = change.changeType === 'renamed' ? RULES.renamedSymbol : RULES.removedSymbol
      const what = change.changeType === 'renamed' ? `was renamed to \`${after?.qualifiedName}\`` : 'was removed'
      const changedLocation = change.changeType === 'renamed' && after ? location(after, 'head') : location(old, 'base')

      const reported = new Set<string>()
      for (const edge of input.edges.filter((candidate) => candidate.type === 'calls' && candidate.target === oldId && candidate.evidenceRevision === 'base')) {
        const caller = headSymbols.get(edge.source)
        if (!caller || reported.has(caller.id)) continue
        // A resolved head call from the same caller to a same-named symbol means the caller was repointed (e.g. a moved function).
        if (headCalls.some((candidate) => candidate.source === caller.id && headSymbols.get(candidate.target)?.name === old.name)) continue
        const viaMember = old.kind === 'method'
        const line = referenceLine(caller, headFiles.get(caller.path), old.name, viaMember)
        if (line === undefined) continue
        reported.add(caller.id)
        const lookalikes = input.head.symbols.some((symbol) => symbol.name === old.name && (symbol.kind === 'method' || symbol.kind === 'function'))
        const confirmed = edge.resolutionStatus === 'resolved' && !lookalikes
        add({
          ruleId,
          severity: severity('high', confirmed),
          confidence: confirmed ? 'confirmed' : 'inferred',
          message: `\`${old.qualifiedName}\` ${what}, but \`${caller.qualifiedName}\` still calls \`${old.name}\`.`,
          changed: changedLocation,
          affected: { path: caller.path, line, revision: 'head', symbolId: caller.id, symbol: caller.qualifiedName },
          evidence: [edge.id],
        })
      }

      const baseImports = new Map(input.base.imports.filter((binding) => binding.resolvedId === oldId).map((binding) => [`${binding.path}\0${binding.local}\0${binding.exported}`, binding]))
      for (const binding of input.head.imports) {
        if (binding.resolvedId || !baseImports.has(`${binding.path}\0${binding.local}\0${binding.exported}`)) continue
        const language = headFiles.get(binding.path)?.language
        add({
          ruleId: RULES.brokenImport,
          severity: 'high',
          confidence: 'confirmed',
          message: `\`${old.qualifiedName}\` ${what}, but ${binding.path} still imports \`${binding.exported}\`${language === 'python' ? ' — this raises ImportError when the module loads' : ' — this no longer compiles'}.`,
          changed: changedLocation,
          affected: { path: binding.path, line: binding.line, revision: 'head', symbol: binding.local },
          evidence: [],
        })
      }
    }
  }

  // Behaviour changes that reach callers the PR did not touch: one finding per changed function.
  for (const change of input.changes) {
    const before = change.base
    const after = change.head
    if (!before || !after || !(change.changeType === 'modified' || change.changeType === 'signature')) continue
    if (after.kind !== 'function' && after.kind !== 'method') continue
    const classification = classifyChange(before, after)
    const callers: CallerImpact[] = []
    for (const edge of headCalls.filter((candidate) => candidate.target === after.id && !flaggedEdges.has(candidate.id))) {
      const caller = headSymbols.get(edge.source)
      if (!caller || caller.kind === 'test' || caller.kind === 'file' || input.changedPaths.has(caller.path)) continue
      if (callers.some((existing) => existing.location.symbolId === caller.id)) continue
      if (findings.some((finding) => finding.affected.symbolId === caller.id && finding.changed.symbolId === after.id)) continue
      const reasons = edge.call ? callerExposure(classification, after, edge.call) : []
      callers.push({
        location: { path: edge.evidencePath, line: edge.evidenceLine, revision: 'head', symbolId: caller.id, symbol: caller.qualifiedName },
        affected: reasons.length > 0,
        reasons,
        confirmed: edge.resolutionStatus === 'resolved',
        edgeId: edge.id,
      })
    }
    if (callers.length === 0) continue

    // Affected callers first, confirmed before inferred, then by location.
    callers.sort((a, b) => Number(b.affected) - Number(a.affected) || Number(b.confirmed) - Number(a.confirmed)
      || a.location.path.localeCompare(b.location.path) || a.location.line - b.location.line)
    const escalated = callers.some((caller) => caller.affected && caller.confirmed)
    const affected = callers.filter((caller) => caller.affected)
    const name = `\`${after.qualifiedName}\``
    const callerList = (items: CallerImpact[]) => items.map((caller) => `\`${caller.location.symbol}\``).join(', ')
    const message = classification.kinds.includes('internals')
      ? `${name} changed internally only (no return, raise, default, or type changes detected). ${callers.length} caller${callers.length === 1 ? '' : 's'} outside this PR: ${callerList(callers)}.`
      : affected.length > 0
        ? `${name} changed (${describeKinds(classification)}). ${affected.length} of ${callers.length} caller${callers.length === 1 ? '' : 's'} outside this PR look affected: ${affected.map((caller) => `\`${caller.location.symbol}\` ${caller.reasons.join(' and ')}`).join('; ')}.`
        : `${name} changed (${describeKinds(classification)}), but none of its ${callers.length} caller${callers.length === 1 ? '' : 's'} outside this PR use it in a way that change affects: ${callerList(callers)}.`
    const primary = callers[0]
    add({
      ruleId: RULES.unupdatedCaller,
      severity: escalated ? 'medium' : 'low',
      confidence: callers.every((caller) => caller.confirmed) ? 'confirmed' : 'inferred',
      message,
      changed: location(after, 'head'),
      affected: primary.location,
      evidence: callers.map((caller) => caller.edgeId),
      details: { changeKinds: classification.kinds, callers },
    })
  }

  const unique = [...new Map(findings.map((finding) => [finding.id, finding])).values()]
  return unique.sort((a, b) => (
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || a.ruleId.localeCompare(b.ruleId)
    || a.affected.path.localeCompare(b.affected.path)
    || a.affected.line - b.affected.line
  ))
}
