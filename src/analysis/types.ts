export type Language = 'python' | 'typescript'
export type SymbolKind = 'file' | 'function' | 'method' | 'class' | 'interface' | 'test'
export type ChangeType = 'added' | 'modified' | 'deleted' | 'signature'
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
}

export interface UnresolvedRelationship {
  path: string
  line: number
  expression: string
  reason: string
}

export interface ParseResult {
  symbols: SymbolRecord[]
  edges: EdgeRecord[]
  unresolved: UnresolvedRelationship[]
}

export interface ChangeRecord {
  symbolId: string
  changeType: ChangeType
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
}

export interface AnalysisResult {
  symbols: SymbolRecord[]
  edges: EdgeRecord[]
  changes: ChangeRecord[]
  findings: ImpactFinding[]
  tests: TestRecommendation[]
  unresolved: UnresolvedRelationship[]
  graphSymbolIds: string[]
  stats: {
    parsedFiles: number
    changedFiles: number
    changedSymbols: number
    impactedSymbols: number
    recommendedTests: number
    unresolved: number
    durationMs: number
  }
  limitations: string[]
}

export interface ParserOptions {
  wasmBasePath: string
}
