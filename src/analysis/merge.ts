import type { EdgeRecord, ReviewFinding, ReviewLocation, Severity } from './types'

/** Every finding that points at one affected location, with the strongest severity among them. */
export interface FindingGroup {
  id: string
  severity: Severity
  affected: ReviewLocation
  /** Distinct changed locations behind this group's evidence. */
  changed: ReviewLocation[]
  /** Evidence items, strongest first. */
  findings: ReviewFinding[]
  sources: ReviewFinding['source'][]
}

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
const SOURCE_RANK: Record<ReviewFinding['source'], number> = { rule: 0, typecheck: 1, 'test-run': 2 }

const locationKey = (location: ReviewLocation) => `${location.revision}:${location.path}:${location.line}`

/**
 * Merge findings that land on the same affected location. A failing test points at the test file, so it
 * joins the finding whose affected caller lies on that test's dependency path, when there is one.
 */
export function groupFindings(findings: ReviewFinding[], edges: Pick<EdgeRecord, 'id' | 'source' | 'target' | 'evidencePath' | 'evidenceLine'>[] = []): FindingGroup[] {
  const edgesById = new Map(edges.map((edge) => [edge.id, edge]))
  const groups = new Map<string, FindingGroup>()
  const add = (key: string, finding: ReviewFinding) => {
    const group = groups.get(key)
    if (!group) {
      groups.set(key, { id: `group:${key}`, severity: finding.severity, affected: finding.affected, changed: [], findings: [finding], sources: [] })
      return
    }
    group.findings.push(finding)
    // Prefer an affected location that names its symbol; type-checker findings only carry path and line.
    if (!group.affected.symbolId && finding.affected.symbolId) group.affected = finding.affected
  }

  const bySeverity = [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || SOURCE_RANK[a.source] - SOURCE_RANK[b.source])
  for (const finding of bySeverity.filter((candidate) => candidate.source !== 'test-run')) add(locationKey(finding.affected), finding)

  for (const test of bySeverity.filter((candidate) => candidate.source === 'test-run')) {
    const pathEdges = test.evidence.map((id) => edgesById.get(id)).filter((edge): edge is NonNullable<typeof edge> => Boolean(edge))
    const nodes = new Set(pathEdges.flatMap((edge) => [edge.source, edge.target]))
    const sites = new Set(pathEdges.map((edge) => `${edge.evidencePath}:${edge.evidenceLine}`))
    const target = [...groups.values()]
      .filter((group) => group.findings.some((finding) => finding.source !== 'test-run'))
      .filter((group) => (group.affected.symbolId && nodes.has(group.affected.symbolId)) || sites.has(`${group.affected.path}:${group.affected.line}`))
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])[0]
    if (target) add([...groups.entries()].find(([, group]) => group === target)![0], test)
    else add(locationKey(test.affected), test)
  }

  for (const group of groups.values()) {
    group.findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || SOURCE_RANK[a.source] - SOURCE_RANK[b.source])
    group.severity = group.findings[0].severity
    group.changed = [...new Map(group.findings.map((finding) => [locationKey(finding.changed), finding.changed])).values()]
    group.sources = [...new Set(group.findings.map((finding) => finding.source))].sort((a, b) => SOURCE_RANK[a] - SOURCE_RANK[b])
  }
  return [...groups.values()].sort((a, b) => (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || a.affected.path.localeCompare(b.affected.path)
    || a.affected.line - b.affected.line
  ))
}
