/**
 * Java implicit `java.lang` imports and common JDK types.
 *
 * Everything in java.lang is in scope without an import, so these appear
 * everywhere and would otherwise dominate the unresolved list.
 */

export const GLOBALS = new Set([
  // Primitives and their boxes
  'boolean', 'byte', 'char', 'double', 'float', 'int', 'long', 'short', 'void',
  'Boolean', 'Byte', 'Character', 'Double', 'Float', 'Integer', 'Long', 'Short',
  'Number', 'Object', 'String', 'StringBuilder', 'StringBuffer', 'CharSequence',

  // java.lang staples
  'Class', 'Comparable', 'Enum', 'Iterable', 'Math', 'Record', 'Runnable',
  'System', 'Thread', 'ThreadLocal', 'Void', 'Cloneable', 'AutoCloseable',
  'Override', 'Deprecated', 'SuppressWarnings', 'FunctionalInterface', 'SafeVarargs',

  // Exceptions
  'Exception', 'RuntimeException', 'Error', 'Throwable', 'IllegalArgumentException',
  'IllegalStateException', 'NullPointerException', 'IndexOutOfBoundsException',
  'ArrayIndexOutOfBoundsException', 'ClassCastException', 'NumberFormatException',
  'UnsupportedOperationException', 'InterruptedException', 'IOException',

  // Collections and utilities used almost universally
  'List', 'ArrayList', 'Map', 'HashMap', 'LinkedHashMap', 'TreeMap', 'Set',
  'HashSet', 'LinkedHashSet', 'TreeSet', 'Collection', 'Collections', 'Arrays',
  'Optional', 'Stream', 'Objects', 'Iterator', 'Queue', 'Deque',
]);

/** Methods present on Object, or on the collection types listed above. */
export const METHODS = new Set([
  'equals', 'hashCode', 'toString', 'getClass', 'clone', 'notify', 'notifyAll',
  'wait', 'compareTo', 'length', 'charAt', 'substring', 'indexOf', 'contains',
  'startsWith', 'endsWith', 'split', 'trim', 'strip', 'replace', 'format',
  'valueOf', 'parseInt', 'parseLong', 'parseDouble', 'join', 'isEmpty',
  'isBlank', 'toLowerCase', 'toUpperCase', 'add', 'addAll', 'get', 'set',
  'put', 'putAll', 'remove', 'removeAll', 'size', 'clear', 'containsKey',
  'containsValue', 'keySet', 'values', 'entrySet', 'iterator', 'stream',
  'forEach', 'map', 'filter', 'collect', 'findFirst', 'anyMatch', 'allMatch',
  'orElse', 'orElseGet', 'orElseThrow', 'ifPresent', 'isPresent', 'of',
  'append', 'println', 'print', 'printf', 'getMessage', 'printStackTrace',
]);

export default { globals: GLOBALS, methods: METHODS, package: 'java' };
