/**
 * Rust prelude and primitive types.
 *
 * The prelude is imported into every module implicitly, so without this list its
 * members show up as unresolved in every single file.
 */

export const GLOBALS = new Set([
  // Primitives
  'bool', 'char', 'f32', 'f64', 'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
  'str', 'u8', 'u16', 'u32', 'u64', 'u128', 'usize',

  // Prelude types
  'Box', 'Clone', 'Copy', 'Default', 'Drop', 'Eq', 'Err', 'Fn', 'FnMut',
  'FnOnce', 'From', 'Into', 'Iterator', 'None', 'Ok', 'Option', 'Ord',
  'PartialEq', 'PartialOrd', 'Result', 'Send', 'Sized', 'Some', 'String',
  'Sync', 'ToOwned', 'ToString', 'Vec', 'IntoIterator', 'DoubleEndedIterator',
  'ExactSizeIterator', 'AsRef', 'AsMut', 'TryFrom', 'TryInto', 'Self',

  // Prelude macros
  'assert', 'assert_eq', 'assert_ne', 'debug_assert', 'dbg', 'format',
  'matches', 'panic', 'print', 'println', 'eprint', 'eprintln', 'todo',
  'unimplemented', 'unreachable', 'vec', 'write', 'writeln', 'include_str',
]);

/** Methods that appear on nearly every type via the prelude traits. */
export const METHODS = new Set([
  'clone', 'to_string', 'to_owned', 'into', 'from', 'as_ref', 'as_mut',
  'unwrap', 'unwrap_or', 'unwrap_or_else', 'unwrap_or_default', 'expect',
  'ok', 'err', 'is_some', 'is_none', 'is_ok', 'is_err', 'map', 'map_err',
  'and_then', 'or_else', 'filter', 'iter', 'iter_mut', 'into_iter', 'collect',
  'next', 'len', 'is_empty', 'push', 'pop', 'insert', 'remove', 'get',
  'contains', 'extend', 'sort', 'sort_by', 'join', 'split', 'trim', 'parse',
  'to_vec', 'as_str', 'as_bytes', 'fmt', 'default', 'new', 'with_capacity',
]);

export default { globals: GLOBALS, methods: METHODS, package: 'rust' };
