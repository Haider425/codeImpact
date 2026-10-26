import { useMemo, useState } from 'react'
import dagre from '@dagrejs/dagre'
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
} from '@xyflow/react'
import type { Edge, Node, NodeProps } from '@xyflow/react'
import { FlaskConical, GitCommitHorizontal } from 'lucide-react'
import type { AnalysisResult, SymbolRecord } from '@/analysis/types'
import '@xyflow/react/dist/style.css'

type NodeData = {
  symbol: SymbolRecord
  role: 'changed' | 'direct' | 'transitive' | 'test'
  distance?: number
} & Record<string, unknown>
type ImpactFlowNode = Node<NodeData, 'impact'>

const nodeTypes = {
  impact: ({ data, selected }: NodeProps<ImpactFlowNode>) => (
    <div className={`impact-node impact-node--${data.role} ${selected ? 'is-selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node-shape" aria-hidden="true">
        {data.role === 'test' ? <FlaskConical size={15} /> : data.role === 'changed' ? <GitCommitHorizontal size={16} /> : <span />}
      </div>
      <div className="node-copy">
        <strong>{data.symbol.name}</strong>
        <span>{data.symbol.path}</span>
      </div>
      {data.distance !== undefined && data.distance > 0 && <span className="node-distance">d{data.distance}</span>}
      <Handle type="source" position={Position.Right} />
    </div>
  ),
}

function layoutNodes(nodes: ImpactFlowNode[], edges: Edge[]) {
  const graph = new dagre.graphlib.Graph()
  graph.setDefaultEdgeLabel(() => ({}))
  graph.setGraph({ rankdir: 'LR', nodesep: 34, ranksep: 86, marginx: 20, marginy: 20 })
  nodes.forEach((node) => graph.setNode(node.id, { width: 220, height: 72 }))
  edges.forEach((edge) => graph.setEdge(edge.source, edge.target))
  dagre.layout(graph)
  return nodes.map((node) => {
    const position = graph.node(node.id)
    return { ...node, position: { x: position.x - 110, y: position.y - 36 } }
  })
}

interface ImpactGraphProps {
  result: AnalysisResult
  selectedId: string | null
  onSelect: (id: string) => void
  expanded?: boolean
}

export function ImpactGraph({ result, selectedId, onSelect, expanded = false }: ImpactGraphProps) {
  const [filter, setFilter] = useState<'all' | 'changed' | 'tests'>(() => window.matchMedia('(max-width: 560px)').matches ? 'changed' : 'all')
  const changedIds = useMemo(() => new Set(result.changes.filter((change) => change.head).map((change) => change.symbolId)), [result])
  const findingById = useMemo(() => new Map(result.findings.map((finding) => [finding.symbol.id, finding])), [result])
  const testIds = useMemo(() => new Set(result.tests.map((test) => test.test.id)), [result])
  const symbolById = useMemo(() => new Map(result.symbols.map((symbol) => [symbol.id, symbol])), [result])

  const selectedPath = useMemo(() => {
    if (!selectedId) return new Set<string>()
    const item = result.findings.find((finding) => finding.symbol.id === selectedId)
      ?? result.tests.find((test) => test.test.id === selectedId)
    return new Set(item?.path.edgeIds ?? [])
  }, [result, selectedId])

  const visibleIds = useMemo(() => {
    const all = new Set(result.graphSymbolIds)
    if (filter === 'changed') return new Set([...changedIds])
    if (filter === 'tests') return new Set([...changedIds, ...testIds])
    return all
  }, [filter, result, changedIds, testIds])

  const { nodes, edges } = useMemo(() => {
    const visibleEdges = result.edges.filter((edge) => edge.type === 'calls' && visibleIds.has(edge.source) && visibleIds.has(edge.target))
    const visibleNodes: ImpactFlowNode[] = [...visibleIds].sort().map((id) => {
      const symbol = symbolById.get(id)!
      const finding = findingById.get(id)
      const role = changedIds.has(id) ? 'changed' : testIds.has(id) ? 'test' : finding?.impactType === 'direct' ? 'direct' : 'transitive'
      return {
        id,
        type: 'impact',
        position: { x: 0, y: 0 },
        data: { symbol, role, distance: finding?.distance ?? result.tests.find((test) => test.test.id === id)?.path.edgeIds.length },
        selected: selectedId === id,
      }
    })
    const flowEdges: Edge[] = visibleEdges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'smoothstep',
      className: selectedPath.has(edge.id) ? 'impact-edge is-path' : 'impact-edge',
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: selectedPath.has(edge.id) ? '#7fffe0' : '#666666' },
    }))
    return { nodes: layoutNodes(visibleNodes, flowEdges), edges: flowEdges }
  }, [result, visibleIds, symbolById, findingById, changedIds, testIds, selectedId, selectedPath])

  return (
    <section className={`graph-shell ${expanded ? 'graph-shell--expanded' : ''}`} aria-label="Dependency impact graph">
      <div className="graph-toolbar">
        <div>
          <span className="section-label">IMPACT MAP</span>
          <span className="graph-count">{nodes.length} nodes · {edges.length} visible edges</span>
        </div>
        <div className="segmented-control" aria-label="Filter graph nodes">
          {(['all', 'changed', 'tests'] as const).map((value) => (
            <button key={value} type="button" className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>
              {value === 'all' ? 'All' : value === 'changed' ? 'Changes' : 'Tests'}
            </button>
          ))}
        </div>
      </div>
      <div className="graph-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={(_, node) => onSelect(node.id)}
          onEdgeClick={(_, edge) => onSelect(edge.target)}
          fitView
          fitViewOptions={{ padding: 0.18, maxZoom: 1.05 }}
          minZoom={0.3}
          maxZoom={1.8}
          nodesConnectable={false}
          deleteKeyCode={null}
          colorMode="dark"
        >
          <Background color="#2b2b2b" gap={22} size={1} />
          <Controls showInteractive={false} position="bottom-left" />
        </ReactFlow>
        <div className="graph-legend" aria-label="Graph legend">
          <span><i className="legend-dot changed" />Changed</span>
          <span><i className="legend-dot direct" />Direct</span>
          <span><i className="legend-dot transitive" />Transitive</span>
          <span><i className="legend-triangle" />Test</span>
        </div>
      </div>
    </section>
  )
}
