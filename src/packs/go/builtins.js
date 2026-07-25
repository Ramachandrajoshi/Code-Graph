/**
 * Go predeclared identifiers.
 *
 * Go's builtin set is famously small, which makes this list short and complete
 * rather than a best-effort sample.
 */

export const GLOBALS = new Set([
  // Functions
  'append', 'cap', 'clear', 'close', 'complex', 'copy', 'delete', 'imag', 'len',
  'make', 'max', 'min', 'new', 'panic', 'print', 'println', 'real', 'recover',

  // Types
  'any', 'bool', 'byte', 'comparable', 'complex64', 'complex128', 'error',
  'float32', 'float64', 'int', 'int8', 'int16', 'int32', 'int64', 'rune',
  'string', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',

  // Values
  'true', 'false', 'iota', 'nil',
]);

/**
 * Go has no methods on builtin types, so this stays empty. Kept for contract
 * symmetry with the other packs — an empty set is a statement, not an omission.
 */
export const METHODS = new Set();

export default { globals: GLOBALS, methods: METHODS, package: 'go' };
