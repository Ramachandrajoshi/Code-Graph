/**
 * JavaScript / TypeScript runtime built-ins.
 *
 * Without this list, `arr.map(...)` and `new Map()` are counted as unresolved
 * references. On a normal codebase that is the *majority* of all references,
 * which makes the resolution-quality metric meaningless and makes `doctor`
 * report a serious problem where none exists.
 *
 * These are not failures — they are calls into the language runtime, and
 * recording them as such is both honest and useful: an agent can then ask what
 * a module actually depends on.
 */

/** Global constructors and namespaces. */
export const GLOBALS = new Set([
  'Array', 'ArrayBuffer', 'BigInt', 'Boolean', 'DataView', 'Date', 'Error',
  'EvalError', 'FinalizationRegistry', 'Float32Array', 'Float64Array',
  'Function', 'Infinity', 'Int8Array', 'Int16Array', 'Int32Array', 'Intl',
  'JSON', 'Map', 'Math', 'NaN', 'Number', 'Object', 'Promise', 'Proxy',
  'RangeError', 'ReferenceError', 'Reflect', 'RegExp', 'Set', 'String',
  'Symbol', 'SyntaxError', 'TypeError', 'URIError', 'Uint8Array',
  'Uint16Array', 'Uint32Array', 'WeakMap', 'WeakRef', 'WeakSet',
  'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent',
  'eval', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'structuredClone',

  // Host globals present in Node and/or browsers.
  'console', 'process', 'globalThis', 'Buffer', 'URL', 'URLSearchParams',
  'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal', 'Event',
  'EventTarget', 'fetch', 'Headers', 'Request', 'Response', 'FormData', 'Blob',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
  'queueMicrotask', 'require', 'window', 'document', 'localStorage',
  'sessionStorage', 'navigator', 'location', 'history', 'alert',
]);

/**
 * Prototype and static methods.
 *
 * Only treated as built-in when the call has a receiver (`x.map()`), because a
 * bare `map()` is far more likely to be a local helper — and misclassifying a
 * real project function as a runtime built-in would hide a genuine edge.
 */
export const METHODS = new Set([
  // Array
  'at', 'concat', 'copyWithin', 'entries', 'every', 'fill', 'filter', 'find',
  'findIndex', 'findLast', 'findLastIndex', 'flat', 'flatMap', 'forEach',
  'includes', 'indexOf', 'join', 'keys', 'lastIndexOf', 'map', 'pop', 'push',
  'reduce', 'reduceRight', 'reverse', 'shift', 'slice', 'some', 'sort',
  'splice', 'unshift', 'values', 'toSorted', 'toReversed', 'with',

  // String
  'charAt', 'charCodeAt', 'codePointAt', 'endsWith', 'localeCompare', 'match',
  'matchAll', 'normalize', 'padEnd', 'padStart', 'repeat', 'replace',
  'replaceAll', 'search', 'split', 'startsWith', 'substring', 'substr',
  'toLowerCase', 'toUpperCase', 'trim', 'trimEnd', 'trimStart', 'raw',

  // Object / Reflect
  'assign', 'create', 'defineProperty', 'freeze', 'fromEntries',
  'getOwnPropertyNames', 'getPrototypeOf', 'hasOwn', 'hasOwnProperty', 'is',
  'isFrozen', 'setPrototypeOf',

  // Map / Set / WeakMap
  'add', 'clear', 'delete', 'get', 'has', 'set',

  // Promise
  'all', 'allSettled', 'any', 'catch', 'finally', 'race', 'resolve', 'reject',
  'then',

  // Number / Math / JSON / Date
  'abs', 'ceil', 'floor', 'max', 'min', 'pow', 'random', 'round', 'sign',
  'sqrt', 'trunc', 'toFixed', 'toPrecision', 'parse', 'stringify',
  'toISOString', 'toJSON', 'getTime', 'now',

  // Function / RegExp / iterator protocol
  'apply', 'bind', 'call', 'exec', 'test', 'toString', 'valueOf', 'next',

  // Node host objects that appear constantly: process.*, stream.*, console.*.
  'cwd', 'exit', 'on', 'once', 'off', 'emit', 'write', 'end', 'pipe',
  'log', 'warn', 'error', 'info', 'debug', 'trace', 'nextTick',
]);

export default { globals: GLOBALS, methods: METHODS, package: 'javascript' };
