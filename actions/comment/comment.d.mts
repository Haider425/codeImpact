export const MARKER: string

export interface CommentContext {
  repository?: string
  serverUrl: string
  apiUrl: string
  token?: string
  pullNumber?: number
  headSha?: string
  baseSha?: string
  fromFork: boolean
}

export function escapeText(value: unknown, max?: number): string
export function renderMessage(value: unknown): string
export function safePath(value: unknown): string | undefined
export function locationLink(location: unknown, context: CommentContext): string
export function renderComment(report: unknown, context: CommentContext): { body: string; high: number }
export function failureComment(context: CommentContext, reason: string): string
export function upsertComment(context: CommentContext, body: string): Promise<'created' | 'updated'>
export function readContext(env?: Record<string, string | undefined>): CommentContext
