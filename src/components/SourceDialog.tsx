import { useEffect, useRef, useState } from 'react'
import { FileCode2 } from 'lucide-react'
import type { DemoRepository } from '@/analysis/types'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export interface SourceSelection {
  path: string
  line: number
  revision: 'base' | 'head'
}

interface SourceDialogProps {
  repository: DemoRepository
  selection: SourceSelection | null
  onClose: () => void
}

export function SourceDialog({ repository, selection, onClose }: SourceDialogProps) {
  if (!selection) return null

  return (
    <SourceDialogContent
      key={`${selection.path}:${selection.line}:${selection.revision}`}
      repository={repository}
      selection={selection}
      onClose={onClose}
    />
  )
}

interface SourceDialogContentProps {
  repository: DemoRepository
  selection: SourceSelection
  onClose: () => void
}

function SourceDialogContent({ repository, selection, onClose }: SourceDialogContentProps) {
  const [revision, setRevision] = useState<'base' | 'head'>(selection.revision)
  const highlightedLine = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const timeout = window.setTimeout(() => highlightedLine.current?.scrollIntoView({ block: 'center' }), 80)
    return () => window.clearTimeout(timeout)
  }, [selection, revision])

  const file = repository[revision].files.find((candidate) => candidate.path === selection.path)

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="source-dialog">
        <DialogHeader>
          <div className="source-dialog-kicker"><FileCode2 size={15} />READ-ONLY SOURCE</div>
          <DialogTitle>{selection?.path}</DialogTitle>
          <DialogDescription>
            {repository[revision].sha} · {file?.language} · Evidence line {selection?.line}
          </DialogDescription>
        </DialogHeader>
        <div className="source-dialog-toolbar">
          <div className="segmented-control" aria-label="Source revision">
            {(['base', 'head'] as const).map((value) => (
              <button key={value} type="button" className={revision === value ? 'active' : ''} onClick={() => setRevision(value)}>
                {value} · {repository[value].sha}
              </button>
            ))}
          </div>
          <span>Repository code is parsed, never executed.</span>
        </div>
        <div className="source-code" role="region" aria-label="Source code">
          {file?.source.split('\n').map((line, index) => {
            const lineNumber = index + 1
            const highlighted = lineNumber === selection?.line
            return (
              <div
                key={`${lineNumber}-${line}`}
                ref={highlighted ? highlightedLine : undefined}
                className={`code-line ${highlighted ? 'is-highlighted' : ''}`}
              >
                <span className="line-number">{lineNumber}</span>
                <code>{line || ' '}</code>
              </div>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
