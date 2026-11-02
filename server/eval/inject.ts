import type { Language, SourceFile } from '../../src/analysis/types'

/** The breaking changes the benchmark injects, one per case. */
export type BugType = 'signature' | 'rename' | 'delete' | 'return-shape' | 'raise'
export const BUG_TYPES: BugType[] = ['signature', 'rename', 'delete', 'return-shape', 'raise']

export interface InjectionTarget {
  path: string
  name: string
  language: Language
  /** 1-based inclusive line range of the function, decorators included. */
  startLine: number
  endLine: number
}

export interface BreakLocation {
  path: string
  line: number
  kind: 'call' | 'import'
  /** Other lines that identify the same break, e.g. the first line of a multi-line import statement. */
  aliasLines?: number[]
  /** True when the break is in the file the injected commit changed, so a diff-only reviewer can see it. */
  inChangedFile: boolean
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const INJECTED_PARAM = { python: 'codeimpact_extra', typescript: 'codeimpactExtra: number' }
export const renamedName = (target: InjectionTarget) => (target.language === 'python' ? `${target.name}_renamed` : `${target.name}Renamed`)

/** Index (0-based) of the line holding the definition header, i.e. `def name(` or `function name(`. */
function headerLine(lines: string[], target: InjectionTarget) {
  const name = escape(target.name)
  const pattern = target.language === 'python'
    ? new RegExp(`^\\s*(async\\s+)?def\\s+${name}\\s*\\(`)
    : new RegExp(`(function\\s*\\*?\\s*${name}\\s*(<[^>]*>)?\\s*\\(|(const|let|var)\\s+${name}\\s*(:[^=]+)?=\\s*(async\\s*)?(\\(|function))`)
  for (let index = target.startLine - 1; index < Math.min(lines.length, target.endLine); index += 1) {
    if (pattern.test(lines[index])) return index
  }
  return -1
}

const balance = (text: string) => [...text].reduce((depth, char) => depth + ('([{'.includes(char) ? 1 : ')]}'.includes(char) ? -1 : 0), 0)
const stripComment = (line: string, language: Language) => line.replace(language === 'python' ? /\s+#.*$/ : /\s+\/\/.*$/, '')

/** Index of the first body line, or -1 for one-line definitions and expression-bodied arrows. */
function bodyStart(lines: string[], target: InjectionTarget, header: number) {
  let depth = 0
  for (let index = header; index < Math.min(lines.length, target.endLine); index += 1) {
    const code = stripComment(lines[index], target.language)
    depth += balance(code)
    const opensBody = target.language === 'python' ? /:\s*$/.test(code) && depth === 0 : /\{\s*$/.test(code) && /\)\s*(:\s*[^={]+)?(=>\s*)?\{\s*$/.test(code)
    if (opensBody) return index + 1 < target.endLine ? index + 1 : -1
    if (target.language === 'typescript' && depth === 0 && /=>\s*[^{\s]/.test(code)) return -1
  }
  return -1
}

/**
 * Apply one breaking change to the target function and return the new file source, or undefined when the
 * change does not apply to this function (no single-line return, a one-line body, ...).
 */
export function injectBug(source: string, target: InjectionTarget, type: BugType): string | undefined {
  const lines = source.split('\n')
  const header = headerLine(lines, target)
  if (header < 0) return undefined
  const name = new RegExp(`(?<![\\w$])${escape(target.name)}(?![\\w$])`)

  if (type === 'signature') {
    const line = lines[header]
    const open = line.indexOf('(', line.search(name) + target.name.length)
    if (open < 0) return undefined
    const empty = /^\(\s*\)/.test(line.slice(open))
    lines[header] = `${line.slice(0, open + 1)}${INJECTED_PARAM[target.language]}${empty ? '' : ', '}${line.slice(open + 1)}`
    return lines.join('\n')
  }
  if (type === 'rename') {
    lines[header] = lines[header].replace(name, renamedName(target))
    return lines.join('\n')
  }
  if (type === 'delete') {
    lines.splice(target.startLine - 1, target.endLine - target.startLine + 1)
    return lines.join('\n')
  }
  if (type === 'return-shape') {
    let changed = 0
    for (let index = header + 1; index < target.endLine; index += 1) {
      const match = stripComment(lines[index], target.language).match(/^(\s*)return\s+(.+?)\s*(;?)\s*$/)
      if (!match || balance(match[2]) !== 0 || /[,\\+\-*/&|=(]$/.test(match[2])) continue
      lines[index] = `${match[1]}return [${match[2]}]${match[3]}`
      changed += 1
    }
    return changed > 0 ? lines.join('\n') : undefined
  }
  const body = bodyStart(lines, target, header)
  if (body < 0) return undefined
  const following = lines.slice(body).find((line) => line.trim()) ?? ''
  const indent = following.match(/^\s*/)![0] || (target.language === 'python' ? '    ' : '  ')
  lines.splice(body, 0, target.language === 'python' ? `${indent}raise RuntimeError("codeimpact injected")` : `${indent}throw new Error("codeimpact injected")`)
  return lines.join('\n')
}

const isComment = (line: string) => /^\s*(#|\/\/|\/\*|\*)/.test(line)

/** Exceptions a Python `except` clause catches that would also catch the injected RuntimeError. */
const CATCHES_RUNTIME_ERROR = /^\s*except\s*(:|\(?\s*[^:]*\b(RuntimeError|Exception|BaseException)\b)/

/** True when the call on `lines[index]` sits inside a `try` body that would handle the injected exception. */
function handledByTry(lines: string[], index: number, language: Language) {
  if (language === 'python') {
    const indentOf = (line: string) => line.match(/^\s*/)![0].length
    let level = indentOf(lines[index])
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const line = lines[cursor]
      if (!line.trim() || isComment(line) || indentOf(line) >= level) continue
      level = indentOf(line)
      if (/^\s*(def|class|async\s+def)\b/.test(line)) return false
      if (/^\s*try\s*:/.test(line)) {
        for (let after = index + 1; after < lines.length; after += 1) {
          const next = lines[after]
          if (!next.trim()) continue
          if (indentOf(next) < level) break
          if (indentOf(next) === level && /^\s*except\b/.test(next) && CATCHES_RUNTIME_ERROR.test(next)) return true
        }
      }
    }
    return false
  }
  // TypeScript: any enclosing `try {` whose block is still open at the call catches everything.
  let depth = 0
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const code = stripComment(lines[cursor], language)
    for (let char = code.length - 1; char >= 0; char -= 1) {
      if (code[char] === '}') depth += 1
      if (code[char] === '{') {
        if (depth === 0) {
          if (/\btry\s*$/.test(code.slice(0, char))) return true
          if (/\b(function\b|=>\s*$)/.test(code.slice(0, char))) return false
        } else depth -= 1
      }
    }
  }
  return false
}

/** True when a call line only evaluates the call and discards its value. */
function discardsValue(line: string, name: string) {
  return new RegExp(`^\\s*(await\\s+)?[\\w$.]*${escape(name)}\\s*\\(.*\\)\\s*;?\\s*$`).test(line) && balance(line) === 0
}

/**
 * Where an injected break lands, found by plain text search over the head revision. This oracle is
 * deliberately independent of CodeImpact's parser and resolver.
 */
export function breakLocations(files: SourceFile[], target: InjectionTarget, type: BugType): BreakLocation[] {
  const name = escape(target.name)
  const call = new RegExp(`(?<![\\w$])${name}\\s*(<[^>()]*>)?\\s*\\(`)
  const definition = target.language === 'python'
    ? new RegExp(`^\\s*(async\\s+)?def\\s+${name}\\s*\\(`)
    : new RegExp(`(function\\s*\\*?\\s*${name}\\s*[<(]|(const|let|var)\\s+${name}\\s*[:=])`)
  const word = new RegExp(`(?<![\\w$])${name}(?![\\w$])`)
  const locations: BreakLocation[] = []

  for (const file of files.filter((candidate) => candidate.language === target.language)) {
    const lines = file.source.split('\n')
    let inImportBlock = false
    let importStartLine = 0
    lines.forEach((line, index) => {
      if (isComment(line)) return
      const importStart = target.language === 'python'
        ? /^\s*from\s+\S+\s+import\b/.test(line)
        : /^\s*(import|export)\b[^'"]*(\{|$)/.test(line) && !/\b(function|const|let|var|class|interface|type)\b/.test(line)
      const importLine = inImportBlock || importStart
      if (importStart) importStartLine = index + 1
      if (importStart && balance(line) > 0) inImportBlock = true
      else if (inImportBlock && balance(line) < 0) inImportBlock = false
      else if (inImportBlock && /[)}]/.test(line)) inImportBlock = false

      const location = { path: file.path, line: index + 1, inChangedFile: file.path === target.path }
      if (importLine) {
        if ((type === 'rename' || type === 'delete') && word.test(line)) {
          locations.push({ ...location, kind: 'import', ...(importStartLine !== index + 1 ? { aliasLines: [importStartLine] } : {}) })
        }
        return
      }
      if (!call.test(line) || definition.test(line)) return
      if (type === 'return-shape' && discardsValue(line, target.name)) return
      if (type === 'raise' && handledByTry(lines, index, target.language)) return
      locations.push({ ...location, kind: 'call' })
    })
  }
  return locations
}
