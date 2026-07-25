/**
 * Python runtime built-ins.
 *
 * Same rationale as the JS list: without it, `len(x)`, `str(y)` and `d.items()`
 * are all counted as unresolved references, which drowns real resolution
 * failures in noise.
 */

/** Built-in functions and types (the `builtins` module). */
export const GLOBALS = new Set([
  'abs', 'aiter', 'all', 'anext', 'any', 'ascii', 'bin', 'bool', 'breakpoint',
  'bytearray', 'bytes', 'callable', 'chr', 'classmethod', 'compile', 'complex',
  'delattr', 'dict', 'dir', 'divmod', 'enumerate', 'eval', 'exec', 'filter',
  'float', 'format', 'frozenset', 'getattr', 'globals', 'hasattr', 'hash',
  'help', 'hex', 'id', 'input', 'int', 'isinstance', 'issubclass', 'iter',
  'len', 'list', 'locals', 'map', 'max', 'memoryview', 'min', 'next', 'object',
  'oct', 'open', 'ord', 'pow', 'print', 'property', 'range', 'repr', 'reversed',
  'round', 'set', 'setattr', 'slice', 'sorted', 'staticmethod', 'str', 'sum',
  'super', 'tuple', 'type', 'vars', 'zip', '__import__',

  // Exceptions.
  'ArithmeticError', 'AssertionError', 'AttributeError', 'BaseException',
  'BlockingIOError', 'BrokenPipeError', 'BufferError', 'ConnectionError',
  'EOFError', 'Exception', 'FileExistsError', 'FileNotFoundError',
  'FloatingPointError', 'GeneratorExit', 'ImportError', 'IndentationError',
  'IndexError', 'InterruptedError', 'IsADirectoryError', 'KeyError',
  'KeyboardInterrupt', 'LookupError', 'MemoryError', 'ModuleNotFoundError',
  'NameError', 'NotADirectoryError', 'NotImplementedError', 'OSError',
  'OverflowError', 'PermissionError', 'ProcessLookupError', 'RecursionError',
  'ReferenceError', 'RuntimeError', 'StopAsyncIteration', 'StopIteration',
  'SyntaxError', 'SystemError', 'SystemExit', 'TabError', 'TimeoutError',
  'TypeError', 'UnboundLocalError', 'UnicodeDecodeError', 'UnicodeEncodeError',
  'UnicodeError', 'ValueError', 'ZeroDivisionError',

  // Typing constructs that appear constantly in annotations.
  'Any', 'Callable', 'Dict', 'Iterable', 'Iterator', 'List', 'Literal',
  'Optional', 'Sequence', 'Set', 'Tuple', 'Type', 'Union', 'TypeVar',
  'Generic', 'Protocol', 'Final', 'Annotated', 'None', 'True', 'False', 'self',
  'cls',
]);

/** Methods on built-in types, matched only when the call has a receiver. */
export const METHODS = new Set([
  // str
  'capitalize', 'casefold', 'center', 'encode', 'endswith', 'expandtabs',
  'find', 'format', 'index', 'isalnum', 'isalpha', 'isdigit', 'islower',
  'isnumeric', 'isspace', 'istitle', 'isupper', 'join', 'ljust', 'lower',
  'lstrip', 'partition', 'removeprefix', 'removesuffix', 'replace', 'rfind',
  'rindex', 'rjust', 'rpartition', 'rsplit', 'rstrip', 'split', 'splitlines',
  'startswith', 'strip', 'swapcase', 'title', 'translate', 'upper', 'zfill',

  // list / dict / set
  'append', 'clear', 'copy', 'count', 'extend', 'get', 'insert', 'items',
  'keys', 'pop', 'popitem', 'remove', 'reverse', 'setdefault', 'sort',
  'update', 'values', 'add', 'difference', 'discard', 'intersection',
  'issubset', 'issuperset', 'union',

  // file / context / common dunder protocol
  'close', 'flush', 'read', 'readline', 'readlines', 'seek', 'tell', 'write',
  'writelines', '__init__', '__enter__', '__exit__', '__str__', '__repr__',
  '__len__', '__iter__', '__next__', '__call__', '__eq__', '__hash__',
]);

export default { globals: GLOBALS, methods: METHODS, package: 'python' };
