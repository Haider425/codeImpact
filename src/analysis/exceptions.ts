/** Python's built-in exception hierarchy (3.13), as child → parent. Aliases map to their target. */
const PYTHON_BUILTIN_PARENTS: Record<string, string> = {
  SystemExit: 'BaseException',
  KeyboardInterrupt: 'BaseException',
  GeneratorExit: 'BaseException',
  BaseExceptionGroup: 'BaseException',
  Exception: 'BaseException',
  ExceptionGroup: 'Exception',
  ArithmeticError: 'Exception',
  FloatingPointError: 'ArithmeticError',
  OverflowError: 'ArithmeticError',
  ZeroDivisionError: 'ArithmeticError',
  AssertionError: 'Exception',
  AttributeError: 'Exception',
  BufferError: 'Exception',
  EOFError: 'Exception',
  ImportError: 'Exception',
  ModuleNotFoundError: 'ImportError',
  LookupError: 'Exception',
  IndexError: 'LookupError',
  KeyError: 'LookupError',
  MemoryError: 'Exception',
  NameError: 'Exception',
  UnboundLocalError: 'NameError',
  OSError: 'Exception',
  EnvironmentError: 'OSError',
  IOError: 'OSError',
  BlockingIOError: 'OSError',
  ChildProcessError: 'OSError',
  ConnectionError: 'OSError',
  BrokenPipeError: 'ConnectionError',
  ConnectionAbortedError: 'ConnectionError',
  ConnectionRefusedError: 'ConnectionError',
  ConnectionResetError: 'ConnectionError',
  FileExistsError: 'OSError',
  FileNotFoundError: 'OSError',
  InterruptedError: 'OSError',
  IsADirectoryError: 'OSError',
  NotADirectoryError: 'OSError',
  PermissionError: 'OSError',
  ProcessLookupError: 'OSError',
  TimeoutError: 'OSError',
  ReferenceError: 'Exception',
  RuntimeError: 'Exception',
  NotImplementedError: 'RuntimeError',
  PythonFinalizationError: 'RuntimeError',
  RecursionError: 'RuntimeError',
  StopAsyncIteration: 'Exception',
  StopIteration: 'Exception',
  SyntaxError: 'Exception',
  IndentationError: 'SyntaxError',
  TabError: 'IndentationError',
  SystemError: 'Exception',
  TypeError: 'Exception',
  ValueError: 'Exception',
  UnicodeError: 'ValueError',
  UnicodeDecodeError: 'UnicodeError',
  UnicodeEncodeError: 'UnicodeError',
  UnicodeTranslateError: 'UnicodeError',
  Warning: 'Exception',
  BytesWarning: 'Warning',
  DeprecationWarning: 'Warning',
  EncodingWarning: 'Warning',
  FutureWarning: 'Warning',
  ImportWarning: 'Warning',
  PendingDeprecationWarning: 'Warning',
  ResourceWarning: 'Warning',
  RuntimeWarning: 'Warning',
  SyntaxWarning: 'Warning',
  UnicodeWarning: 'Warning',
  UserWarning: 'Warning',
}

const shortName = (name: string) => name.split('.').pop() ?? name

/**
 * Every class `name` inherits from, including itself, using the built-in table plus base classes of
 * exception classes declared in the repository (keyed by short class name).
 */
export function exceptionAncestors(name: string, repositoryBases: Map<string, string[]>) {
  const seen = new Set<string>()
  const queue = [shortName(name)]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (seen.has(current)) continue
    seen.add(current)
    const builtin = PYTHON_BUILTIN_PARENTS[current]
    if (builtin) queue.push(builtin)
    for (const base of repositoryBases.get(current) ?? []) queue.push(shortName(base))
  }
  return seen
}

/** True when an `except`/`catch` list catches `raised`: `*` is a catch-all, otherwise any ancestor matches. */
export function isCaught(caught: string[] | null, raised: string, repositoryBases: Map<string, string[]>) {
  if (!caught) return false
  if (caught.includes('*')) return true
  const ancestors = exceptionAncestors(raised, repositoryBases)
  return caught.some((name) => ancestors.has(shortName(name)))
}
