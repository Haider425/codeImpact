import Parser from 'web-tree-sitter'

type SyntaxNode = Parser.SyntaxNode
import type {
  EdgeRecord,
  ParseResult,
  ParserOptions,
  Revision,
  SourceFile,
  SymbolKind,
  SymbolRecord,
  UnresolvedRelationship,
} from './types'

export const PARSER_VERSION = 'ts-parser/2'

let initPromise: Promise<void> | undefined
const languageCache = new Map<string, Promise<Parser.Language>>()

type Grammar = 'python' | 'typescript' | 'tsx'

function idFor(path: string, qualifiedName: string, kind: SymbolKind) {
  return `${path}::${qualifiedName}::${kind}`
}

export function fileSymbolId(path: string) {
  return idFor(path, path, 'file')
}

function line(node: SyntaxNode) {
  return node.startPosition.row + 1
}

function text(node: SyntaxNode, source: string) {
  return source.slice(node.startIndex, node.endIndex)
}

function descendants(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = []
  const stack = [node]
  while (stack.length > 0) {
    const current = stack.pop()!
    result.push(current)
    for (let index = current.childCount - 1; index >= 0; index -= 1) stack.push(current.child(index)!)
  }
  return result
}

function grammarFor(file: SourceFile): Grammar {
  if (file.language === 'python') return 'python'
  return file.path.endsWith('.tsx') ? 'tsx' : 'typescript'
}

function loadLanguage(grammar: Grammar, base: string) {
  const key = `${base}/${grammar}`
  if (!languageCache.has(key)) languageCache.set(key, Parser.Language.load(`${base}/tree-sitter-${grammar}.wasm`))
  return languageCache.get(key)!
}

async function initialize(options: ParserOptions) {
  if (!initPromise) {
    initPromise = Parser.init({
      locateFile: () => `${options.wasmBasePath}/tree-sitter.wasm`,
    })
  }
  await initPromise
}

export function isTestFile(file: Pick<SourceFile, 'path' | 'language'>) {
  if (file.language === 'python') return /(^|\/)(test[^/]*|[^/]*_test)\.py$/.test(file.path)
  return /\.(test|spec)\.tsx?$/.test(file.path) || /(^|\/)(__tests__|tests?)\//.test(file.path)
}

/** Python decorators belong to the function they decorate, so a changed decorator changes the symbol. */
function rangeNode(node: SyntaxNode) {
  return node.parent?.type === 'decorated_definition' ? node.parent : node
}

function isOverloadStub(node: SyntaxNode, source: string) {
  const decorated = node.parent?.type === 'decorated_definition' ? node.parent : null
  return Boolean(decorated?.namedChildren.some((child) => child.type === 'decorator' && /(^|\.)overload\s*$/.test(text(child, source).replace(/^@/, ''))))
}

function declaration(
  definition: SyntaxNode,
  file: SourceFile,
  name: string,
  kind: SymbolKind,
  qualifiedName: string,
): SymbolRecord {
  const node = rangeNode(definition)
  const source = text(node, file.source)
  const body = definition.childForFieldName('body')
  const signature = source.slice(0, body ? body.startIndex - node.startIndex : Math.min(source.length, 160)).trim()
  return {
    id: idFor(file.path, qualifiedName, kind),
    path: file.path,
    name,
    qualifiedName,
    kind,
    startLine: line(node),
    endLine: node.endPosition.row + 1,
    language: file.language,
    exported: file.language === 'python' ? !name.startsWith('_') : /^\s*export\s/.test(source) || node.parent?.type === 'export_statement',
    source,
    signature,
    resolutionStatus: 'resolved',
  }
}

const testCallees = new Set(['it', 'test'])
const suiteCallees = new Set(['describe', 'suite'])

function testCallLabel(node: SyntaxNode, source: string) {
  const args = node.childForFieldName('arguments')
  const first = args?.namedChildren[0]
  if (!first || !['string', 'template_string'].includes(first.type)) return undefined
  return text(first, source).slice(1, -1)
}

function calleeRoot(node: SyntaxNode, source: string) {
  const fn = node.childForFieldName('function')
  if (!fn) return ''
  if (fn.type === 'identifier') return text(fn, source)
  // it.only(...), test.each(...)(...), describe.skip(...)
  if (fn.type === 'member_expression') return text(fn.childForFieldName('object') ?? fn, source)
  if (fn.type === 'call_expression') return calleeRoot(fn, source)
  return ''
}

export function collectDeclarations(root: SyntaxNode, file: SourceFile) {
  const symbols: SymbolRecord[] = [
    {
      id: fileSymbolId(file.path),
      path: file.path,
      name: file.path.split('/').pop() ?? file.path,
      qualifiedName: file.path,
      kind: 'file',
      startLine: 1,
      endLine: file.source.split('\n').length,
      language: file.language,
      exported: false,
      source: '',
      signature: '',
      resolutionStatus: 'resolved',
    },
  ]
  const occurrences = new Map<string, number>()
  const testFile = isTestFile(file)

  const push = (symbol: SymbolRecord) => {
    // Two `it("same label")` blocks would otherwise collide. Use an ordinal rather than a line number
    // so unrelated edits above the symbol do not change its identity.
    const count = (occurrences.get(symbol.id) ?? 0) + 1
    occurrences.set(symbol.id, count)
    if (count > 1) {
      symbol.qualifiedName = `${symbol.qualifiedName}#${count}`
      symbol.id = idFor(symbol.path, symbol.qualifiedName, symbol.kind)
    }
    symbols.push(symbol)
  }

  const visit = (node: SyntaxNode, className: string, suite: string, inFunction: boolean) => {
    let nextClass = className
    let nextSuite = suite
    let nextInFunction = inFunction
    let nameNode: SyntaxNode | null = null
    let kind: SymbolKind | undefined

    if (node.type === 'function_definition' || node.type === 'function_declaration') {
      nameNode = node.childForFieldName('name')
      kind = className ? 'method' : 'function'
    } else if (node.type === 'method_definition') {
      nameNode = node.childForFieldName('name')
      kind = 'method'
    } else if (node.type === 'class_definition' || node.type === 'class_declaration') {
      nameNode = node.childForFieldName('name')
      kind = 'class'
    } else if (node.type === 'interface_declaration') {
      nameNode = node.childForFieldName('name')
      kind = 'interface'
    } else if (node.type === 'variable_declarator' && !inFunction) {
      const value = node.childForFieldName('value')
      if (value?.type === 'arrow_function' || value?.type === 'function_expression' || value?.type === 'function') {
        nameNode = node.childForFieldName('name')
        kind = 'function'
      }
    }

    // Nested helper functions are folded into their enclosing symbol so call edges stay at the
    // granularity developers navigate by.
    if (nameNode && kind && kind !== 'class' && isOverloadStub(node, file.source)) {
      // `@overload` signatures are type-checker stubs; the implementation that follows is the symbol.
      nextInFunction = true
    } else if (nameNode && kind && !(inFunction && kind !== 'class')) {
      const name = text(nameNode, file.source)
      const qualifiedName = className ? `${className}.${name}` : name
      const isPythonTest = file.language === 'python' && testFile && name.startsWith('test')
        && (kind === 'function' || (kind === 'method' && /(^|\.)Test/.test(className)))
      const actualKind: SymbolKind = isPythonTest ? 'test' : kind
      push(declaration(node, file, name, actualKind, qualifiedName))
      if (kind === 'class') nextClass = qualifiedName
      else nextInFunction = true
    }

    if (testFile && file.language === 'typescript' && node.type === 'call_expression') {
      const root = calleeRoot(node, file.source)
      const label = testCallLabel(node, file.source)
      if (label !== undefined && testCallees.has(root)) {
        const qualifiedName = suite ? `${suite} > ${label}` : label
        push(declaration(node, file, label, 'test', qualifiedName))
        nextInFunction = true
      } else if (label !== undefined && suiteCallees.has(root)) {
        nextSuite = suite ? `${suite} > ${label}` : label
      }
    }

    for (const child of node.children) visit(child, nextClass, nextSuite, nextInFunction)
  }

  visit(root, '', '', false)
  return symbols
}

function normalizePath(path: string) {
  const parts: string[] = []
  path.split('/').forEach((part) => {
    if (!part || part === '.') return
    if (part === '..') parts.pop()
    else parts.push(part)
  })
  return parts.join('/')
}

function dirname(path: string) {
  return path.split('/').slice(0, -1).join('/')
}

// `tests/` is a root because pytest's rootdir/conftest handling commonly puts it on sys.path.
const PYTHON_ROOTS = ['', 'src/', 'lib/', 'tests/', 'test/']

class ModuleResolver {
  private readonly paths: Set<string>
  private readonly pythonPackages = new Set<string>()

  constructor(files: SourceFile[]) {
    this.paths = new Set(files.map((file) => file.path))
    for (const path of this.paths) {
      for (const root of PYTHON_ROOTS) {
        if (!path.startsWith(root)) continue
        const top = path.slice(root.length).split('/')[0]
        this.pythonPackages.add(top.replace(/\.py$/, ''))
      }
    }
  }

  private first(candidates: string[]) {
    return candidates.find((candidate) => this.paths.has(candidate))
  }

  pythonModule(file: SourceFile, specifier: string) {
    const dots = specifier.match(/^\.*/)![0].length
    const dotted = specifier.slice(dots).replaceAll('.', '/')
    if (dots > 0) {
      let directory = dirname(file.path)
      for (let level = 1; level < dots; level += 1) directory = dirname(directory)
      const candidate = normalizePath(`${directory}/${dotted}`)
      return this.first([`${candidate}.py`, `${candidate}/__init__.py`])
    }
    for (const root of PYTHON_ROOTS) {
      const found = this.first([`${root}${dotted}.py`, `${root}${dotted}/__init__.py`])
      if (found) return found
    }
    // Sibling-module imports in script-style layouts (tests/ importing tests/helpers.py).
    const sibling = normalizePath(`${dirname(file.path)}/${dotted}`)
    return this.first([`${sibling}.py`, `${sibling}/__init__.py`])
  }

  /** True when an absolute import names one of the repository's own top-level packages. */
  isInternalPython(specifier: string) {
    const top = specifier.split('.')[0]
    return !top || this.pythonPackages.has(top)
  }

  pythonSubmodule(modulePath: string, name: string) {
    if (!modulePath.endsWith('__init__.py')) return undefined
    const directory = dirname(modulePath)
    return this.first([`${directory}/${name}.py`, `${directory}/${name}/__init__.py`])
  }

  typescriptModule(file: SourceFile, specifier: string) {
    if (!specifier.startsWith('.')) return undefined
    const candidate = normalizePath(`${dirname(file.path)}/${specifier}`)
    const stem = candidate.replace(/\.(js|jsx|mjs)$/, '')
    return this.first([
      candidate, `${stem}.ts`, `${stem}.tsx`, `${stem}.d.ts`, `${stem}/index.ts`, `${stem}/index.tsx`,
    ])
  }
}

interface NameBinding { path: string; exported: string; line: number }

/** What a module makes visible to importers, beyond its own top-level declarations. */
interface ModuleScope {
  file: SourceFile
  root: SyntaxNode
  symbols: SymbolRecord[]
  topLevel: Map<string, SymbolRecord>
  names: Map<string, NameBinding>
  modules: Map<string, string>
  starExports: string[]
  defaultExport?: string
  unresolvedImports: UnresolvedRelationship[]
  importEdges: EdgeRecord[]
}

function stringValue(node: SyntaxNode | null, source: string) {
  if (!node) return undefined
  return text(node, source).replace(/^["'`]|["'`]$/g, '')
}

function collectPythonImports(scope: ModuleScope, resolver: ModuleResolver) {
  const { file, root } = scope
  const importEdge = (target: string, node: SyntaxNode) => {
    scope.importEdges.push({
      id: `imports:${file.path}:${target}:${line(node)}`,
      source: fileSymbolId(file.path),
      target: fileSymbolId(target),
      type: 'imports',
      evidencePath: file.path,
      evidenceLine: line(node),
      extractionMethod: 'static import resolution',
      resolutionStatus: 'resolved',
    })
  }
  const unresolved = (node: SyntaxNode, expression: string) => {
    scope.unresolvedImports.push({ path: file.path, line: line(node), expression, reason: 'Import target is outside the supplied revision or could not be resolved.' })
  }

  for (const node of descendants(root)) {
    if (node.type === 'import_statement') {
      for (const child of node.namedChildren) {
        const dotted = child.type === 'aliased_import' ? child.childForFieldName('name') : child
        const alias = child.type === 'aliased_import' ? child.childForFieldName('alias') : null
        if (!dotted) continue
        const specifier = text(dotted, file.source)
        const target = resolver.pythonModule(file, specifier)
        if (!target) continue // Standard library and third-party imports are expected to be absent.
        scope.modules.set(alias ? text(alias, file.source) : specifier, target)
        importEdge(target, node)
      }
    } else if (node.type === 'import_from_statement') {
      const moduleNode = node.childForFieldName('module_name')
      if (!moduleNode) continue
      const specifier = text(moduleNode, file.source)
      const target = resolver.pythonModule(file, specifier)
      if (!target) {
        if (!resolver.isInternalPython(specifier)) continue
        // An internal module that no longer resolves (deleted or moved). Keep the names bound so
        // calls through them surface as unresolved instead of silently looking external.
        unresolved(node, specifier)
        for (const child of node.namedChildren) {
          if (child.startIndex === moduleNode.startIndex) continue
          const nameNode = child.type === 'aliased_import' ? child.childForFieldName('name') : child
          const alias = child.type === 'aliased_import' ? child.childForFieldName('alias') : null
          if (nameNode?.type !== 'dotted_name') continue
          scope.names.set(alias ? text(alias, file.source) : text(nameNode, file.source), { path: '', exported: text(nameNode, file.source), line: line(node) })
        }
        continue
      }
      importEdge(target, node)
      for (const child of node.namedChildren) {
        if (child.startIndex === moduleNode.startIndex) continue
        if (child.type === 'wildcard_import') {
          scope.starExports.push(target)
          continue
        }
        const nameNode = child.type === 'aliased_import' ? child.childForFieldName('name') : child
        const alias = child.type === 'aliased_import' ? child.childForFieldName('alias') : null
        if (!nameNode || nameNode.type !== 'dotted_name') continue
        const exported = text(nameNode, file.source)
        const local = alias ? text(alias, file.source) : exported
        const submodule = resolver.pythonSubmodule(target, exported)
        if (submodule) {
          scope.modules.set(local, submodule)
          importEdge(submodule, node)
        } else {
          scope.names.set(local, { path: target, exported, line: line(node) })
        }
      }
    }
  }
}

function collectTypescriptImports(scope: ModuleScope, resolver: ModuleResolver) {
  const { file, root } = scope
  for (const node of root.namedChildren) {
    const isImport = node.type === 'import_statement'
    const isReexport = node.type === 'export_statement' && node.childForFieldName('source')
    if (node.type === 'export_statement' && !isReexport) {
      const statement = text(node, file.source)
      const declaration = node.childForFieldName('declaration')
      const value = node.childForFieldName('value')
      if (/^export\s+default\b/.test(statement)) {
        const named = declaration?.childForFieldName('name') ?? (value?.type === 'identifier' ? value : null)
        if (named) scope.defaultExport = text(named, file.source)
      }
      continue
    }
    if (!isImport && !isReexport) continue

    const specifier = stringValue(node.childForFieldName('source'), file.source)
    if (!specifier) continue
    const target = resolver.typescriptModule(file, specifier)
    if (!target) {
      if (specifier.startsWith('.')) {
        scope.unresolvedImports.push({ path: file.path, line: line(node), expression: specifier, reason: 'Import target is outside the supplied revision or could not be resolved.' })
      }
      continue
    }
    scope.importEdges.push({
      id: `imports:${file.path}:${target}:${line(node)}`,
      source: fileSymbolId(file.path),
      target: fileSymbolId(target),
      type: 'imports',
      evidencePath: file.path,
      evidenceLine: line(node),
      extractionMethod: 'static import resolution',
      resolutionStatus: 'resolved',
    })

    for (const child of descendants(node)) {
      if (child.type === 'import_specifier' || child.type === 'export_specifier') {
        const name = child.childForFieldName('name')
        const alias = child.childForFieldName('alias')
        if (!name) continue
        const exported = text(name, file.source)
        const local = alias ? text(alias, file.source) : exported
        scope.names.set(local, { path: target, exported, line: line(node) })
      } else if (child.type === 'namespace_import' || child.type === 'namespace_export') {
        const identifier = child.namedChildren.find((candidate) => candidate.type === 'identifier')
        if (identifier) scope.modules.set(text(identifier, file.source), target)
      } else if (child.type === 'import_clause') {
        const defaultName = child.namedChildren.find((candidate) => candidate.type === 'identifier')
        if (defaultName) scope.names.set(text(defaultName, file.source), { path: target, exported: 'default', line: line(node) })
      }
    }
    if (isReexport && /^export\s*\*\s*from/.test(text(node, file.source))) scope.starExports.push(target)
  }
}

const ignoredCalls = new Set([
  'assert', 'expect', 'it', 'test', 'describe', 'sum', 'min', 'max', 'len', 'print', 'str',
  'toBe', 'toContain', 'toEqual', 'toFixed', 'format', 'getattr', 'setattr', 'require',
  'super', 'isinstance', 'hasattr', 'range', 'list', 'dict', 'set', 'tuple', 'int', 'float', 'bool',
])

const selfNames = new Set(['self', 'cls', 'this'])
const MAX_POLYMORPHIC_CANDIDATES = 3
const callableKinds = new Set<SymbolKind>(['function', 'method', 'class'])

type Resolution =
  | { kind: 'resolved' | 'inferred'; targets: SymbolRecord[]; method: string }
  | { kind: 'unresolved'; reason: string }
  | { kind: 'ignore' }

class RevisionIndex {
  readonly scopes = new Map<string, ModuleScope>()
  private readonly byName = new Map<string, SymbolRecord[]>()

  constructor(scopes: ModuleScope[]) {
    for (const scope of scopes) {
      this.scopes.set(scope.file.path, scope)
      for (const symbol of scope.symbols) {
        if (!callableKinds.has(symbol.kind)) continue
        const list = this.byName.get(symbol.name) ?? []
        list.push(symbol)
        this.byName.set(symbol.name, list)
      }
    }
  }

  named(name: string) {
    return this.byName.get(name) ?? []
  }

  /** Follow `from .x import y` / `export { y } from './x'` chains to the declaring module. */
  resolveExport(path: string, name: string, depth = 0): SymbolRecord | undefined {
    const scope = this.scopes.get(path)
    if (!scope || depth > 6) return undefined
    if (name === 'default' && scope.defaultExport) return this.resolveExport(path, scope.defaultExport, depth + 1)
    const declared = scope.topLevel.get(name)
    if (declared) return declared
    const binding = scope.names.get(name)
    if (binding) return this.resolveExport(binding.path, binding.exported, depth + 1)
    const viaStar = [...new Set(scope.starExports)]
      .map((target) => this.resolveExport(target, name, depth + 1))
      .filter((symbol): symbol is SymbolRecord => Boolean(symbol))
    return viaStar.length === 1 ? viaStar[0] : undefined
  }

  method(classSymbol: SymbolRecord, name: string) {
    const scope = this.scopes.get(classSymbol.path)
    return scope?.symbols.find((symbol) => symbol.qualifiedName === `${classSymbol.qualifiedName}.${name}` && symbol.kind !== 'class')
  }

  constructorOf(classSymbol: SymbolRecord) {
    return this.method(classSymbol, classSymbol.language === 'python' ? '__init__' : 'constructor')
  }
}

function enclosingSymbol(node: SyntaxNode, symbols: SymbolRecord[]) {
  const start = line(node)
  const end = node.endPosition.row + 1
  let best: SymbolRecord | undefined
  for (const symbol of symbols) {
    if (symbol.kind === 'file' || symbol.kind === 'class' || symbol.kind === 'interface') continue
    if (symbol.startLine > start || symbol.endLine < end) continue
    if (!best || symbol.endLine - symbol.startLine < best.endLine - best.startLine) best = symbol
  }
  return best
}

function enclosingClass(caller: SymbolRecord | undefined, scope: ModuleScope) {
  if (!caller || !caller.qualifiedName.includes('.')) return undefined
  const className = caller.qualifiedName.split('.').slice(0, -1).join('.')
  return scope.symbols.find((symbol) => symbol.kind === 'class' && symbol.qualifiedName === className)
}

function withConstructor(index: RevisionIndex, symbol: SymbolRecord) {
  if (symbol.kind !== 'class') return [symbol]
  const constructor = index.constructorOf(symbol)
  return constructor ? [symbol, constructor] : [symbol]
}

function resolveIdentifier(name: string, scope: ModuleScope, index: RevisionIndex): Resolution {
  const local = scope.topLevel.get(name)
  if (local && local.kind !== 'test') return { kind: 'resolved', targets: withConstructor(index, local), method: 'local declaration' }
  const binding = scope.names.get(name)
  if (binding) {
    const target = index.resolveExport(binding.path, binding.exported)
    if (target) return { kind: 'resolved', targets: withConstructor(index, target), method: 'named import' }
    return { kind: 'unresolved', reason: 'Imported name could not be traced to a declaration in the supplied revision.' }
  }
  if (index.named(name).length > 0) {
    return { kind: 'unresolved', reason: 'Matching symbols exist but are not declared locally or imported by name.' }
  }
  return { kind: 'ignore' }
}

function resolveMember(objectNode: SyntaxNode, attribute: string, caller: SymbolRecord | undefined, scope: ModuleScope, index: RevisionIndex): Resolution {
  const objectText = text(objectNode, scope.file.source)
  const candidatesExist = index.named(attribute).some((symbol) => symbol.kind === 'method' || symbol.kind === 'function')

  if (selfNames.has(objectText) || objectNode.type === 'this') {
    const owner = enclosingClass(caller, scope)
    const method = owner && index.method(owner, attribute)
    if (method) return { kind: 'resolved', targets: [method], method: 'self/this member lookup' }
    return candidatesExist
      ? { kind: 'unresolved', reason: 'Method is not declared on the enclosing class; it may be inherited or assigned dynamically.' }
      : { kind: 'ignore' }
  }

  const modulePath = scope.modules.get(objectText)
  if (modulePath) {
    const target = index.resolveExport(modulePath, attribute)
    if (target) return { kind: 'resolved', targets: withConstructor(index, target), method: 'module attribute' }
    return candidatesExist
      ? { kind: 'unresolved', reason: 'Module attribute could not be traced to a declaration.' }
      : { kind: 'ignore' }
  }

  if (objectNode.type === 'identifier') {
    const classSymbol = resolveIdentifier(objectText, scope, index)
    if (classSymbol.kind === 'resolved' && classSymbol.targets[0].kind === 'class') {
      const method = index.method(classSymbol.targets[0], attribute)
      if (method) return { kind: 'resolved', targets: [method], method: 'class member lookup' }
    }
  }

  if (!candidatesExist) return { kind: 'ignore' }

  // Receiver type is unknown. Accept a single method with this name among the modules this file
  // can see, and label the edge as inferred rather than confirmed.
  const visible = new Set([scope.file.path, ...scope.modules.values(), ...[...scope.names.values()].map((binding) => binding.path)])
  for (const binding of scope.names.values()) {
    const target = index.resolveExport(binding.path, binding.exported)
    if (target) visible.add(target.path)
  }
  const candidates = index.named(attribute).filter((symbol) => symbol.kind === 'method' && visible.has(symbol.path))
  if (candidates.length === 1) return { kind: 'inferred', targets: candidates, method: 'unique visible method name' }
  // A handful of same-named methods is usually an override family (Signer.unsign / TimestampSigner.unsign).
  // Link each one as inferred instead of dropping the call.
  if (candidates.length > 1 && candidates.length <= MAX_POLYMORPHIC_CANDIDATES) {
    return { kind: 'inferred', targets: candidates, method: `one of ${candidates.length} visible methods with this name` }
  }
  return {
    kind: 'unresolved',
    reason: candidates.length > 1
      ? `Receiver type is unknown and ${candidates.length} visible methods share this name.`
      : 'Receiver type is unknown and no visible module declares a method with this name.',
  }
}

function linkCalls(scope: ModuleScope, index: RevisionIndex) {
  const { file, root, symbols } = scope
  const edges: EdgeRecord[] = []
  const unresolved: UnresolvedRelationship[] = []
  const fileSymbol = symbols[0]

  for (const node of descendants(root)) {
    let calleeNode: SyntaxNode | null = null
    if (node.type === 'call' || node.type === 'call_expression') calleeNode = node.childForFieldName('function')
    else if (node.type === 'new_expression') calleeNode = node.childForFieldName('constructor')
    else continue
    if (!calleeNode) continue

    const expression = text(calleeNode, file.source)
    const caller = enclosingSymbol(node, symbols)
    let resolution: Resolution
    if (calleeNode.type === 'identifier') {
      resolution = ignoredCalls.has(expression) ? { kind: 'ignore' } : resolveIdentifier(expression, scope, index)
    } else if (calleeNode.type === 'attribute' || calleeNode.type === 'member_expression') {
      const objectNode = calleeNode.childForFieldName('object')
      const attributeNode = calleeNode.childForFieldName(calleeNode.type === 'attribute' ? 'attribute' : 'property')
      const attribute = attributeNode ? text(attributeNode, file.source) : ''
      resolution = !objectNode || !attribute || ignoredCalls.has(attribute)
        ? { kind: 'ignore' }
        : resolveMember(objectNode, attribute, caller, scope, index)
    } else {
      resolution = { kind: 'unresolved', reason: 'Dynamic call target cannot be resolved safely from syntax alone.' }
    }

    if (resolution.kind === 'ignore') continue
    if (resolution.kind === 'unresolved') {
      unresolved.push({ path: file.path, line: line(node), expression: expression.slice(0, 120), reason: resolution.reason })
      continue
    }

    const sourceSymbol = caller ?? fileSymbol
    for (const target of resolution.targets) {
      if (sourceSymbol.id === target.id) continue
      edges.push({
        id: `calls:${sourceSymbol.id}:${target.id}:${line(node)}`,
        source: sourceSymbol.id,
        target: target.id,
        type: 'calls',
        evidencePath: file.path,
        evidenceLine: line(node),
        extractionMethod: `tree-sitter call expression + ${resolution.method}`,
        resolutionStatus: resolution.kind,
      })
    }
  }

  for (const node of descendants(root)) {
    if (node.type === 'ERROR' || node.isMissing()) {
      unresolved.push({ path: file.path, line: line(node), expression: text(node, file.source).slice(0, 100), reason: 'The parser reported incomplete or invalid syntax.' })
    }
  }

  return { edges, unresolved }
}

function containsEdges(symbols: SymbolRecord[]) {
  const [fileSymbol, ...members] = symbols
  return members.map((symbol): EdgeRecord => ({
    id: `contains:${fileSymbol.path}:${symbol.id}`,
    source: fileSymbol.id,
    target: symbol.id,
    type: 'contains',
    evidencePath: fileSymbol.path,
    evidenceLine: symbol.startLine,
    extractionMethod: 'tree-sitter containment',
    resolutionStatus: 'resolved',
  }))
}

export async function parseRevision(revision: Revision, options: ParserOptions): Promise<ParseResult> {
  await initialize(options)
  const parser = new Parser()
  const resolver = new ModuleResolver(revision.files)
  const result: ParseResult = { symbols: [], edges: [], unresolved: [] }
  const scopes: ModuleScope[] = []
  try {
    for (const file of revision.files) {
      parser.setLanguage(await loadLanguage(grammarFor(file), options.wasmBasePath))
      const root = parser.parse(file.source).rootNode
      const symbols = collectDeclarations(root, file)
      const topLevel = new Map(symbols
        .filter((symbol) => symbol.kind !== 'file' && symbol.qualifiedName === symbol.name)
        .map((symbol) => [symbol.name, symbol]))
      const scope: ModuleScope = {
        file, root, symbols, topLevel,
        names: new Map(), modules: new Map(), starExports: [], unresolvedImports: [], importEdges: [],
      }
      if (file.language === 'python') collectPythonImports(scope, resolver)
      else collectTypescriptImports(scope, resolver)
      scopes.push(scope)
    }

    const index = new RevisionIndex(scopes)
    for (const scope of scopes) {
      const linked = linkCalls(scope, index)
      result.symbols.push(...scope.symbols)
      result.edges.push(...containsEdges(scope.symbols), ...scope.importEdges, ...linked.edges)
      result.unresolved.push(...scope.unresolvedImports, ...linked.unresolved)
    }
  } finally {
    scopes.forEach((scope) => scope.root.tree.delete())
    parser.delete()
  }

  const uniqueEdges = new Map(result.edges.map((edge) => [edge.id, edge]))
  result.edges = [...uniqueEdges.values()]
  result.symbols.sort((a, b) => a.id.localeCompare(b.id))
  result.edges.sort((a, b) => a.id.localeCompare(b.id))
  result.unresolved.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.expression.localeCompare(b.expression))
  return result
}
