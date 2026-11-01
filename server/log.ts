/** Structured one-line JSON logs. Never pass secrets, tokens, or raw authorization headers. */
export function log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields })
  if (level === 'error') console.error(line)
  else console.log(line)
}
