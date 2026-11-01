/** An analysis failure that is safe to show to users and says whether retrying can help. */
export class AnalysisError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable: boolean) {
    super(message)
    this.code = code
    this.retryable = retryable
  }
}

export function toAnalysisError(error: unknown): AnalysisError {
  if (error instanceof AnalysisError) return error
  return new AnalysisError('internal_error', 'The analysis failed unexpectedly. The error has been logged.', true)
}
