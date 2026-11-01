import type {
  CallShape,
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

  // Behaviour changes that reach callers the PR did not touch.
  for (const change of input.changes) {
    const after = change.head
    if (!after || !(change.changeType === 'modified' || change.changeType === 'signature')) continue
    if (after.kind !== 'function' && after.kind !== 'method') continue
    const seen = new Set<string>()
    for (const edge of headCalls.filter((candidate) => candidate.target === after.id && !flaggedEdges.has(candidate.id))) {
      const caller = headSymbols.get(edge.source)
      if (!caller || caller.kind === 'test' || caller.kind === 'file' || seen.has(caller.id)) continue
      if (input.changedPaths.has(caller.path)) continue
      if (findings.some((finding) => finding.affected.symbolId === caller.id && finding.changed.symbolId === after.id)) continue
      seen.add(caller.id)
      const confirmed = edge.resolutionStatus === 'resolved'
      add({
        ruleId: RULES.unupdatedCaller,
        severity: severity('medium', confirmed),
        confidence: confirmed ? 'confirmed' : 'inferred',
        message: `\`${caller.qualifiedName}\` calls \`${after.qualifiedName}\`, whose ${change.changeType === 'signature' ? 'signature' : 'body'} changed, but ${caller.path} is not part of this PR. Check that it does not rely on the old behaviour.`,
        changed: location(after, 'head'),
        affected: { path: edge.evidencePath, line: edge.evidenceLine, revision: 'head', symbolId: caller.id, symbol: caller.qualifiedName },
        evidence: [edge.id],
      })
    }
  }

  const unique = [...new Map(findings.map((finding) => [finding.id, finding])).values()]
  return unique.sort((a, b) => (
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || a.ruleId.localeCompare(b.ruleId)
    || a.affected.path.localeCompare(b.affected.path)
    || a.affected.line - b.affected.line
  ))
}
