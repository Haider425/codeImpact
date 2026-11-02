import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { escapeText, locationLink, MARKER, readContext, renderComment, safePath, upsertComment } from '../actions/comment/comment.mjs'
import type { CommentContext } from '../actions/comment/comment.mjs'

const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const context: CommentContext = {
  repository: 'octo/demo', serverUrl: 'https://github.com', apiUrl: 'https://api.github.com', token: 't',
  pullNumber: 7, headSha: head, baseSha: base, fromFork: false,
}

const finding = (overrides: Record<string, unknown> = {}) => ({
  ruleId: 'signature/missing-argument', severity: 'high', source: 'rule', confidence: 'confirmed',
  message: '`checkout` calls `applyDiscount` and does not pass required parameter `cap`.',
  changed: { path: 'src/pricing.ts', line: 1, revision: 'head' },
  affected: { path: 'src/cart.ts', line: 4, revision: 'head' },
  evidence: [], ...overrides,
})

const report = (findings: unknown[], extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, findings, stats: { changedSymbols: 1, impactedSymbols: 2, recommendedTests: 1 }, ...extra })

describe('untrusted text', () => {
  it('neutralizes mentions, links, references, HTML, and markdown', () => {
    const hostile = '@octocat @org/team see https://evil.example and www.evil.example [x](https://e.x) <img src=x onerror=alert(1)> **bold** #12 GH-34 | table'
    const safe = escapeText(hostile)
    expect(safe).not.toMatch(/@\w/)
    expect(safe).not.toContain('https://')
    expect(safe).not.toMatch(/\bwww\./)
    expect(safe).not.toContain('<img')
    expect(safe).not.toMatch(/(?<!\\)\[x\]/)
    expect(safe).not.toMatch(/(?<!\\)\*\*bold/)
    expect(safe).not.toMatch(/#\d/)
    expect(safe).not.toMatch(/GH-\d/)
    expect(safe).toContain('&lt;img')
  })

  it('strips control and bidirectional override characters, collapses lines, and truncates', () => {
    const text = `line one\nline two‮ reversed\u0007 ${'x'.repeat(2000)}`
    const safe = escapeText(text, 100)
    for (const forbidden of ['\n', '‮', '\u0007']) expect(safe.includes(forbidden)).toBe(false)
    expect(safe.length).toBeLessThanOrEqual(110)
    expect(safe.endsWith('…')).toBe(true)
  })

  it('only links safe repository paths and valid lines', () => {
    expect(safePath('src/a b/c.ts')).toBe('src/a b/c.ts')
    for (const bad of ['../etc/passwd', '/abs', 'a/../b', 'a\\b', 'x)](https://evil', '', 'a//b']) expect(safePath(bad), bad).toBeUndefined()
    expect(locationLink({ path: 'src/a b.ts', line: 3, revision: 'head' }, context)).toBe(`[src/a b.ts:3](https://github.com/octo/demo/blob/${head}/src/a%20b.ts#L3)`)
    expect(locationLink({ path: 'src/a.ts', line: 3, revision: 'base' }, context)).toContain(`/blob/${base}/`)
    expect(locationLink({ path: 'src/a.ts', line: -1, revision: 'head' }, context)).toBe(`[src/a.ts](https://github.com/octo/demo/blob/${head}/src/a.ts)`)
    expect(locationLink({ path: '../x', line: 1 }, context)).toBe('_unknown location_')
  })
})

describe('comment rendering', () => {
  it('renders one merged finding per affected location, listing every piece of evidence', () => {
    const rule = finding()
    const tsc = finding({ ruleId: 'typecheck/tsc', source: 'typecheck', message: 'tsc TS2554: Expected 3 arguments, but got 2.' })
    const test = finding({ ruleId: 'tests/failure', source: 'test-run', message: '`checkout > applies` fails on the PR head.', affected: { path: 'src/cart.test.ts', line: 5, revision: 'head' } })
    const low = finding({ ruleId: 'impact/unupdated-caller', severity: 'low', confidence: 'inferred', message: 'x changed internally only.', affected: { path: 'src/other.ts', line: 2, revision: 'head' } })
    const { body, high } = renderComment(report([rule, tsc, test, low], {
      schemaVersion: 2,
      groups: [
        { severity: 'high', affected: { path: 'src/cart.ts', line: 4, revision: 'head', symbol: 'checkout' }, findings: [rule, tsc, test] },
        { severity: 'low', affected: low.affected, findings: [low] },
      ],
      evidence: { typecheck: [{ head: { tool: 'tsc', status: 'ran' }, reported: 1 }], tests: { runner: 'vitest', status: 'ran', selected: 2, totalTests: 9, passed: 1, failed: 1, errors: 0, skipped: 0, environmentErrors: [] } },
    }), context)
    expect(high).toBe(1)
    expect(body.startsWith(MARKER)).toBe(true)
    expect(body).toContain('**1 high · 0 medium · 1 low** (4 pieces of evidence merged by affected location)')
    expect(body).toContain('#### 🔴 High (1)')
    expect(body).toContain('<details><summary>⚪ Low (1)</summary>')
    expect(body).toContain('- **Caller misses a required argument** in <code>checkout</code> · evidence: rule, type checker, 1 failing test')
    expect(body).toContain(`  Affected: [src/cart.ts:4](https://github.com/octo/demo/blob/${head}/src/cart.ts#L4) · Changed: [src/pricing.ts:1](https://github.com/octo/demo/blob/${head}/src/pricing.ts#L1)`)
    expect(body).toContain('  - rule <code>signature/missing-argument</code>: <code>checkout</code> calls <code>applyDiscount</code> and does not pass')
    expect(body).toContain('  - type checker <code>typecheck/tsc</code>: tsc TS2554')
    expect(body).toContain(`  - test run <code>tests/failure</code> ([src/cart.test.ts:5](https://github.com/octo/demo/blob/${head}/src/cart.test.ts#L5)):`)
    expect(body).toContain('inferred link')
    expect(body).toContain('impacted tests (vitest): 2 of 9 selected, 2 ran, 1 failed')
  })

  it('links every valid Changed and Affected location', () => {
    const findings = [
      finding(),
      finding({ ruleId: 'typecheck/tsc', source: 'typecheck', affected: { path: 'src/b.ts', line: 7, revision: 'head' } }),
      finding({ ruleId: 'reference/removed-symbol', changed: { path: 'src/old.ts', line: 3, revision: 'base' }, affected: { path: 'src/c d.ts', line: 1, revision: 'head' } }),
      finding({ severity: 'medium', affected: { path: 'src/e.ts', line: 9, revision: 'head' } }),
    ]
    const { body } = renderComment(report(findings), context)
    const locationLines = body.split('\n').filter((line) => line.startsWith('  Affected:'))
    expect(locationLines).toHaveLength(4)
    for (const line of locationLines) {
      const [affected, changed] = line.replace('  Affected: ', '').split(' · Changed: ')
      expect(affected, line).toMatch(/^\[[^\]]+\]\(https:\/\/github\.com\/octo\/demo\/blob\/[0-9a-f]{40}\/[^)]+#L\d+\)$/)
      expect(changed, line).toMatch(/^\[[^\]]+\]\(https:\/\/github\.com\/octo\/demo\/blob\/[0-9a-f]{40}\/[^)]+#L\d+\)$/)
    }
    expect(body).toContain(`[src/old.ts:3 (base)](https://github.com/octo/demo/blob/${base}/src/old.ts#L3)`)
    expect(body).toContain('[src/c d.ts:1](https://github.com/octo/demo/blob/')
  })

  it('recomputes group severity from the evidence instead of trusting the report', () => {
    const { body, high } = renderComment(report([], {
      schemaVersion: 2,
      groups: [{ severity: 'low', affected: { path: 'src/a.ts', line: 1, revision: 'head' }, findings: [finding()] }],
    }), context)
    expect(high).toBe(1)
    expect(body).toContain('#### 🔴 High (1)')
  })

  it('ignores malformed findings and never lets report fields escape into markup', () => {
    const { body, high } = renderComment(report([
      { severity: 'critical', message: 'not a severity' },
      'not an object',
      finding({ ruleId: '<script>', source: '@admin', message: '`a` @maintainers please merge https://phish.example', changed: { path: '../../secret', line: 'x' } }),
    ], { stats: { changedSymbols: '9; DROP', impactedSymbols: -1 } }), context)
    expect(high).toBe(1)
    expect(body).not.toContain('not a severity')
    expect(body).not.toMatch(/@maintainers|@admin/)
    expect(body).not.toContain('https://phish')
    expect(body).not.toContain('<script>')
    expect(body).toContain('_unknown location_')
    expect(body).toContain('0 changed symbols, 0 impacted')
  })

  it('caps the number of findings and the comment length', () => {
    const many = Array.from({ length: 200 }, (_, index) => finding({ message: `${'long message '.repeat(80)} ${index}` }))
    const { body } = renderComment(report(many), context)
    expect(body.length).toBeLessThanOrEqual(60_000)
    expect(body).toContain('…and 170 more high-severity findings')
  })
})

describe('comment upsert', () => {
  afterEach(() => vi.unstubAllGlobals())

  const stubGitHub = (comments: unknown[]) => {
    const calls: { method: string; url: string; body?: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ method: init.method ?? 'GET', url, body: init.body as string | undefined })
      if ((init.method ?? 'GET') === 'GET') return new Response(JSON.stringify(comments), { status: 200 })
      return new Response('{}', { status: 200 })
    }))
    return calls
  }

  it('creates the comment once, then updates the same comment on later pushes', async () => {
    const created = stubGitHub([{ id: 1, user: { type: 'User' }, body: `${MARKER} spoofed by a person` }])
    expect(await upsertComment(context, `${MARKER}\nfirst`)).toBe('created')
    expect(created.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET https://api.github.com/repos/octo/demo/issues/7/comments?per_page=100&page=1',
      'POST https://api.github.com/repos/octo/demo/issues/7/comments',
    ])

    const updated = stubGitHub([{ id: 9, user: { type: 'Bot' }, body: `${MARKER}\nold` }])
    expect(await upsertComment(context, `${MARKER}\nsecond`)).toBe('updated')
    expect(updated[1]).toMatchObject({ method: 'PATCH', url: 'https://api.github.com/repos/octo/demo/issues/comments/9' })
    expect(JSON.parse(updated[1].body!)).toEqual({ body: `${MARKER}\nsecond` })
  })

  it('reads trusted context from the event payload and detects fork pull requests', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codeimpact-event-'))
    const eventPath = join(dir, 'event.json')
    try {
      writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 3, head: { sha: head, repo: { full_name: 'someone/demo' } }, base: { sha: 'not-a-sha', repo: { full_name: 'octo/demo' } } } }))
      expect(readContext({ GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: 'octo/demo', INPUT_GITHUB_TOKEN: 'x' })).toMatchObject({
        pullNumber: 3, headSha: head, baseSha: undefined, fromFork: true, repository: 'octo/demo',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
