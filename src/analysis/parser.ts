import Parser from 'web-tree-sitter'

type SyntaxNode = Parser.SyntaxNode
import type {
  EdgeRecord,
  Language as SourceLanguage,
  ParseResult,
  ParserOptions,
  Revision,
  SourceFile,
  SymbolKind,
  SymbolRecord,
  UnresolvedRelationship,
} from './types'

let initPromise: Promise<void> | undefined
const languageCache = new Map<string, Promise<Parser.Language>>()

function idFor(path: string, qualifiedName: string, kind: SymbolKind) {
  return `${path}::${qualifiedName}::${kind}`
}

function line(node: SyntaxNode) {
  return node.startPosition.row + 1
}

function text(node: SyntaxNode, source: string) {
  return source.slice(node.startIndex, node.endIndex)
}

function descendants(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = []
  const visit = (current: SyntaxNode) => {
    result.push(current)
    current.children.forEach(visit)
  }
  visit(node)
  return result
}

function loadLanguage(language: SourceLanguage, base: string) {
  const key = `${base}/${language}`
  if (!languageCache.has(key)) {
    const grammar = language === 'python' ? 'tree-sitter-python.wasm' : 'tree-sitter-typescript.wasm'
    languageCache.set(key, Parser.Language.load(`${base}/${grammar}`))
  }
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

function declaration(
  node: SyntaxNode,
  file: SourceFile,
  name: string,
  kind: SymbolKind,
  qualifiedName: string,
): SymbolRecord {
  const source = text(node, file.source)
  const body = node.childForFieldName('body')
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

function collectDeclarations(root: SyntaxNode, file: SourceFile) {
  const symbols: SymbolRecord[] = [
    {
      id: idFor(file.path, file.path, 'file'),
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

  const visit = (node: SyntaxNode, className = '') => {
    let nextClass = className
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
    } else if (node.type === 'variable_declarator') {
      const value = node.childForFieldName('value')
      if (value?.type === 'arrow_function' || value?.type === 'function_expression') {
        nameNode = node.childForFieldName('name')
        kind = className ? 'method' : 'function'
      }
    }

    if (nameNode && kind) {
      const name = text(nameNode, file.source)
      const qualifiedName = className ? `${className}.${name}` : name
      const isPythonTest = file.language === 'python' && /(^|\/)test[^/]*\.py$/.test(file.path) && name.startsWith('test_')
      const actualKind: SymbolKind = isPythonTest ? 'test' : kind
      symbols.push(declaration(node, file, name, actualKind, qualifiedName))
      if (kind === 'class') nextClass = qualifiedName
    }

    if ((node.type === 'call' || node.type === 'call_expression') && file.path.includes('test')) {
      const fn = node.childForFieldName('function')
      const fnName = fn ? text(fn, file.source) : ''
      if ((fnName === 'it' || fnName === 'test') && node.childForFieldName('arguments')) {
        const args = node.childForFieldName('arguments')!
        const label = text(args, file.source).match(/["'`]([^"'`]+)["'`]/)?.[1] ?? `test at line ${line(node)}`
        symbols.push(declaration(node, file, label, 'test', label))
      }
    }

    node.children.forEach((child) => visit(child, nextClass))
  }

  visit(root)
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

function resolveImport(file: SourceFile, specifier: string, files: SourceFile[]) {
  let candidate: string
  if (specifier.startsWith('.')) {
    const directory = file.path.split('/').slice(0, -1).join('/')
    candidate = normalizePath(`${directory}/${specifier}`)
  } else {
    candidate = specifier.replaceAll('.', '/')
  }
  const possibilities = [candidate, `${candidate}.ts`, `${candidate}.py`, `${candidate}/index.ts`, `${candidate}/__init__.py`]
  return files.find((candidateFile) => possibilities.includes(candidateFile.path))
}

function importSpecifiers(root: SyntaxNode, file: SourceFile) {
  const specs: { specifier: string; node: SyntaxNode }[] = []
  descendants(root).forEach((node) => {
    if (node.type === 'import_statement') {
      const statement = text(node, file.source)
      const fromMatch = statement.match(/from\s+["']([^"']+)["']/)
      if (fromMatch) specs.push({ specifier: fromMatch[1], node })
      else if (file.language === 'python') {
        const match = statement.match(/import\s+([\w.]+)/)
        if (match) specs.push({ specifier: match[1], node })
      }
    } else if (node.type === 'import_from_statement') {
      const module = node.childForFieldName('module_name')
      if (module) specs.push({ specifier: text(module, file.source), node })
    }
  })
  return specs
}

function directImportBindings(node: SyntaxNode, file: SourceFile) {
  const statement = text(node, file.source)
  const imported = file.language === 'typescript'
    ? statement.match(/import\s*\{([\s\S]*?)\}\s*from\s*["']/)?.[1]
    : statement.match(/^\s*from\s+[\w.]+\s+import\s+(.+)$/m)?.[1]
  if (!imported) return []
  return imported
    .replace(/[()]/g, '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry && entry !== '*')
    .map((entry) => {
      const [exported, local] = entry.split(/\s+as\s+/)
      return { local: (local ?? exported).trim(), exported: exported.trim() }
    })
}

const ignoredCalls = new Set([
  'assert', 'expect', 'it', 'test', 'describe', 'sum', 'min', 'max', 'len', 'print', 'str',
  'toBe', 'toContain', 'toEqual', 'toFixed', 'format', 'getattr', 'setattr', 'require',
])

function callName(node: SyntaxNode, source: string) {
  const fn = node.childForFieldName('function')
  if (!fn) return undefined
  if (fn.type === 'identifier') return text(fn, source)
  if (fn.type === 'attribute') {
    const attribute = fn.childForFieldName('attribute')
    return attribute ? text(attribute, source) : undefined
  }
  if (fn.type === 'member_expression') {
    const property = fn.childForFieldName('property')
    return property ? text(property, source) : undefined
  }
  return undefined
}

function enclosingSymbol(node: SyntaxNode, symbols: SymbolRecord[]) {
  return symbols
    .filter((symbol) => !['file', 'class', 'interface'].includes(symbol.kind))
    .filter((symbol) => symbol.startLine <= line(node) && symbol.endLine >= node.endPosition.row + 1)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0]
}

function parseFile(root: SyntaxNode, file: SourceFile, files: SourceFile[], revisionSymbols: SymbolRecord[]): ParseResult {
  const symbols = collectDeclarations(root, file)
  const edges: EdgeRecord[] = []
  const unresolved: UnresolvedRelationship[] = []
  const fileSymbol = symbols[0]
  const importedBindings = new Map<string, { path: string; exported: string }[]>()

  symbols.slice(1).forEach((symbol) => {
    edges.push({
      id: `contains:${file.path}:${symbol.id}`,
      source: fileSymbol.id,
      target: symbol.id,
      type: 'contains',
      evidencePath: file.path,
      evidenceLine: symbol.startLine,
      extractionMethod: 'tree-sitter containment',
      resolutionStatus: 'resolved',
    })
  })

  importSpecifiers(root, file).forEach(({ specifier, node }) => {
    const target = resolveImport(file, specifier, files)
    if (target) {
      directImportBindings(node, file).forEach((binding) => {
        const bindings = importedBindings.get(binding.local) ?? []
        bindings.push({ path: target.path, exported: binding.exported })
        importedBindings.set(binding.local, bindings)
      })
      edges.push({
        id: `imports:${file.path}:${target.path}:${line(node)}`,
        source: fileSymbol.id,
        target: idFor(target.path, target.path, 'file'),
        type: 'imports',
        evidencePath: file.path,
        evidenceLine: line(node),
        extractionMethod: 'static import resolution',
        resolutionStatus: 'resolved',
      })
    } else {
      unresolved.push({ path: file.path, line: line(node), expression: specifier, reason: 'Import target is outside the supplied revision or could not be resolved.' })
    }
  })

  descendants(root).forEach((node) => {
    if (node.type !== 'call' && node.type !== 'call_expression') return
    const name = callName(node, file.source)
    const expression = text(node.childForFieldName('function') ?? node, file.source)
    if (!name) {
      unresolved.push({ path: file.path, line: line(node), expression, reason: 'Dynamic call target cannot be resolved safely from syntax alone.' })
      return
    }
    if (ignoredCalls.has(name)) return

    const allCandidates = symbolsInRevision(revisionSymbols, name)
    const localCandidates = allCandidates.filter((candidate) => candidate.path === file.path)
    const importedCandidates = (importedBindings.get(name) ?? []).flatMap((binding) => (
      revisionSymbols.filter((candidate) => (
        candidate.path === binding.path
        && candidate.name === binding.exported
        && (candidate.language === 'python' || candidate.exported)
      ))
    ))
    const candidates = localCandidates.length > 0
      ? localCandidates
      : [...new Map(importedCandidates.map((candidate) => [candidate.id, candidate])).values()]
    if (candidates.length !== 1) {
      unresolved.push({
        path: file.path,
        line: line(node),
        expression,
        reason: candidates.length > 1
          ? 'Call name is ambiguous within this file and its direct named imports.'
          : allCandidates.length > 0
            ? 'Matching symbols exist but are not declared locally or imported by name.'
            : 'No matching symbol was found in the supplied revision.',
      })
      return
    }

    const sourceSymbol = enclosingSymbol(node, symbols) ?? fileSymbol
    const targetSymbol = candidates[0]
    if (sourceSymbol.id === targetSymbol.id) return
    edges.push({
      id: `calls:${sourceSymbol.id}:${targetSymbol.id}:${line(node)}`,
      source: sourceSymbol.id,
      target: targetSymbol.id,
      type: 'calls',
      evidencePath: file.path,
      evidenceLine: line(node),
      extractionMethod: 'tree-sitter call expression + unique-name resolution',
      resolutionStatus: 'resolved',
    })
  })

  descendants(root).forEach((node) => {
    if (node.type === 'ERROR' || node.isMissing()) {
      unresolved.push({ path: file.path, line: line(node), expression: text(node, file.source).slice(0, 100), reason: 'The parser reported incomplete or invalid syntax.' })
    }
  })

  return { symbols, edges, unresolved }
}

function symbolsInRevision(symbols: SymbolRecord[], name: string) {
  return symbols.filter((symbol) => symbol.name === name && !['file', 'class', 'interface'].includes(symbol.kind))
}

export async function parseRevision(revision: Revision, options: ParserOptions): Promise<ParseResult> {
  await initialize(options)
  const parser = new Parser()
  const result: ParseResult = { symbols: [], edges: [], unresolved: [] }
  try {
    const trees: { file: SourceFile; root: SyntaxNode }[] = []
    for (const file of revision.files) {
      const language = await loadLanguage(file.language, options.wasmBasePath)
      parser.setLanguage(language)
      const tree = parser.parse(file.source)
      trees.push({ file, root: tree.rootNode })
      result.symbols.push(...collectDeclarations(tree.rootNode, file))
    }

    for (const { file, root } of trees) {
      const parsed = parseFile(root, file, revision.files, result.symbols)
      result.edges.push(...parsed.edges)
      result.unresolved.push(...parsed.unresolved)
    }
    trees.forEach(({ root }) => root.tree.delete())
  } finally {
    parser.delete()
  }

  result.symbols.sort((a, b) => a.id.localeCompare(b.id))
  result.edges.sort((a, b) => a.id.localeCompare(b.id))
  result.unresolved.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  return result
}
