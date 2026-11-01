export type Language = 'python' | 'typescript'
export type SymbolKind = 'file' | 'function' | 'method' | 'class' | 'interface' | 'test'
export type ChangeType = 'added' | 'modified' | 'deleted' | 'signature' | 'renamed' | 'module'
export type EdgeType = 'contains' | 'imports' | 'calls'
export type ResolutionStatus = 'resolved' | 'inferred' | 'unresolved'

export interface SourceFile {
  path: string
  language: Language
  source: string
}

export interface Revision {
  sha: string
  files: SourceFile[]
}

export interface DemoRepository {
  owner: string
  name: string
  pullRequest: {
    number: number
    title: string
    author: string
    baseRef: string
    headRef: string
  }
  base: Revision
  head: Revision
}

export interface SymbolRecord {
  id: string
  path: string
  name: string
  qualifiedName: string
  kind: SymbolKind
  startLine: number
  endLine: number
  language: Language
  exported: boolean
  source: string
  signature: string
  resolutionStatus: ResolutionStatus
  /** Declared parameters for functions and methods, in order. */
  params?: Parameter[]
  /** Python decorator expressions without the `@`, e.g. `staticmethod`, `functools.cache`. */
  decorators?: string[]
}

export interface Parameter {
  name: string
  kind: 'positional-only' | 'positional' | 'keyword-only' | 'var-positional' | 'var-keyword'
  required: boolean
}

/** What a call site passes, enough to check it against a parameter list without type information. */
export interface CallShape {
  positional: number
  keywords: string[]
  /** `*args`, `**kwargs`, or `...spread` make the argument count unknowable statically. */
  spread: boolean
  /** `none`: plain or module-attribute call; `bound`: obj.m() / self.m(); `unbound`: Class.m(). */
  receiver: 'none' | 'bound' | 'unbound'
}

export interface EdgeRecord {
  id: string
  source: string
  target: string
  type: EdgeType
  evidencePath: string
  evidenceLine: number
  extractionMethod: string
  resolutionStatus: ResolutionStatus
  evidenceRevision?: 'base' | 'head'
  call?: CallShape
}

export interface UnresolvedRelationship {
  path: string
  line: number
  expression: string
  reason: string
}

/** One imported name in one file, and the declaration it resolves to (if any). */
export interface ImportBinding {
  path: string
  line: number
  local: string
  exported: string
  /** Module file the import names; empty when the module itself is missing. */
  module: string
  resolvedId?: string
}

export interface ParseResult {
  symbols: SymbolRecord[]
  edges: EdgeRecord[]
  unresolved: UnresolvedRelationship[]
  imports: ImportBinding[]
}

export type Severity = 'high' | 'medium' | 'low'

export interface ReviewLocation {
  path: string
  line: number
  revision: 'base' | 'head'
  symbolId?: string
  symbol?: string
}

export interface ReviewFinding {
  id: string
  ruleId: string
  severity: Severity
  /** `rule` findings come from deterministic checks; `model` findings from the optional local LLM. */
  source: 'rule' | 'model'
  /** `confirmed`: every link is a resolved edge; `inferred`: a link was matched by name only. */
  confidence: 'confirmed' | 'inferred' | 'model'
  message: string
  changed: ReviewLocation
  affected: ReviewLocation
  /** Edge ids that connect the change to the affected location. */
  evidence: string[]
}

export interface ChangeRecord {
  symbolId: string
  changeType: ChangeType
  /** For renames: the base-revision symbol this one replaces. */
  previousId?: string
  base?: SymbolRecord
  head?: SymbolRecord
}

export interface EvidencePath {
  nodeIds: string[]
  edgeIds: string[]
}

export interface ImpactFinding {
  symbol: SymbolRecord
  impactType: 'direct' | 'transitive'
  distance: number
  score: number
  rank: number
  path: EvidencePath
  reasons: string[]
}

export interface TestRecommendation {
  test: SymbolRecord
  score: number
  rank: number
  path: EvidencePath
  reasons: string[]
  limitation: string
  /** How the test is connected to the change, strongest first. */
  connection: 'changed' | 'call-path' | 'file-import'
}

export interface AnalysisResult {
  symbols: SymbolRecord[]
  edges: EdgeRecord[]
  changes: ChangeRecord[]
  findings: ImpactFinding[]
  tests: TestRecommendation[]
  unresolved: UnresolvedRelationship[]
  review: ReviewFinding[]
  graphSymbolIds: string[]
  stats: {
    parsedFiles: number
    changedFiles: number
    changedSymbols: number
    impactedSymbols: number
    recommendedTests: number
    unresolved: number
    durationMs: number
    totalTests: number
    callEdges: number
    inferredCallEdges: number
  }
  settings: {
    maxDepth: number
    depthLimited: boolean
    algorithmVersion: string
    parserVersion: string
  }
  limitations: string[]
}

export interface ParserOptions {
  wasmBasePath: string
}
