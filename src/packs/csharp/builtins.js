/**
 * C# language keywords and universally-available BCL types.
 *
 * Without this list, `list.Add(x)` and `new List<T>()` are counted as
 * unresolved references. In a typical .NET codebase those are the majority of
 * all references, which would make the resolution-quality metric meaningless.
 */

export const GLOBALS = new Set([
  // Predefined type keywords
  'bool', 'byte', 'sbyte', 'char', 'decimal', 'double', 'float', 'int', 'uint',
  'long', 'ulong', 'short', 'ushort', 'object', 'string', 'void', 'dynamic',
  'var', 'nint', 'nuint',

  // System essentials, in scope in practically every file
  'Boolean', 'Byte', 'Char', 'Convert', 'DateOnly', 'DateTime', 'DateTimeOffset',
  'Decimal', 'Double', 'Enum', 'Environment', 'Guid', 'Int16', 'Int32', 'Int64',
  'Math', 'Nullable', 'Object', 'Random', 'Single', 'String', 'TimeOnly',
  'TimeSpan', 'Type', 'Uri', 'Version',

  // Collections and LINQ
  'Array', 'Dictionary', 'HashSet', 'IAsyncEnumerable', 'ICollection',
  'IDictionary', 'IEnumerable', 'IList', 'IQueryable', 'IReadOnlyCollection',
  'IReadOnlyDictionary', 'IReadOnlyList', 'ISet', 'KeyValuePair', 'LinkedList',
  'List', 'Queue', 'SortedDictionary', 'SortedSet', 'Stack', 'Enumerable',
  'ConcurrentDictionary', 'ImmutableArray', 'ImmutableList', 'Span',
  'ReadOnlySpan', 'Memory', 'Tuple', 'ValueTuple',

  // Async and threading
  'Task', 'ValueTask', 'CancellationToken', 'CancellationTokenSource',
  'IAsyncDisposable', 'IDisposable', 'Lazy', 'SemaphoreSlim', 'Interlocked',
  'Thread', 'ThreadPool', 'Parallel',

  // Delegates and functional shapes
  'Action', 'Func', 'Predicate', 'Comparison', 'EventHandler', 'IComparable',
  'IComparer', 'IEquatable', 'IEqualityComparer', 'IFormattable',

  // Exceptions
  'Exception', 'AggregateException', 'ArgumentException',
  'ArgumentNullException', 'ArgumentOutOfRangeException', 'FormatException',
  'InvalidOperationException', 'IndexOutOfRangeException', 'IOException',
  'KeyNotFoundException', 'NotImplementedException', 'NotSupportedException',
  'NullReferenceException', 'OperationCanceledException', 'OverflowException',
  'TimeoutException', 'UnauthorizedAccessException',

  // IO, text, serialization
  'Console', 'File', 'Directory', 'Path', 'Stream', 'MemoryStream',
  'FileStream', 'StreamReader', 'StreamWriter', 'StringBuilder', 'Encoding',
  'Regex', 'JsonSerializer', 'JsonSerializerOptions',

  // Common attributes
  'Obsolete', 'Serializable', 'Flags', 'AttributeUsage', 'CallerMemberName',
  'Required', 'Key', 'NotMapped', 'JsonPropertyName', 'JsonIgnore',
]);

/**
 * Methods on the types above, matched only when the call has a receiver.
 *
 * A bare `Add()` is far more likely to be a project method than
 * `List<T>.Add`, and misclassifying it would hide a real edge.
 */
export const METHODS = new Set([
  // object / universal
  'Equals', 'GetHashCode', 'GetType', 'ToString', 'MemberwiseClone',

  // string
  'Contains', 'EndsWith', 'Format', 'IndexOf', 'Insert', 'IsNullOrEmpty',
  'IsNullOrWhiteSpace', 'Join', 'LastIndexOf', 'PadLeft', 'PadRight', 'Remove',
  'Replace', 'Split', 'StartsWith', 'Substring', 'ToCharArray', 'ToLower',
  'ToLowerInvariant', 'ToUpper', 'ToUpperInvariant', 'Trim', 'TrimEnd',
  'TrimStart', 'Concat', 'Compare',

  // collections
  'Add', 'AddRange', 'Clear', 'ContainsKey', 'ContainsValue', 'CopyTo',
  'Dequeue', 'Enqueue', 'GetEnumerator', 'Insert', 'Peek', 'Pop', 'Push',
  'RemoveAll', 'RemoveAt', 'Sort', 'TryAdd', 'TryGetValue', 'TryRemove',

  // LINQ — extremely common, and unresolved LINQ alone would dominate the
  // diagnostics in any modern C# repository.
  'Aggregate', 'All', 'Any', 'AsEnumerable', 'AsNoTracking', 'AsQueryable',
  'Average', 'Cast', 'Count', 'Distinct', 'ElementAt', 'Except', 'First',
  'FirstOrDefault', 'GroupBy', 'GroupJoin', 'Intersect', 'Last',
  'LastOrDefault', 'Max', 'Min', 'OfType', 'OrderBy', 'OrderByDescending',
  'Reverse', 'Select', 'SelectMany', 'Single', 'SingleOrDefault', 'Skip',
  'SkipWhile', 'Sum', 'Take', 'TakeWhile', 'ThenBy', 'ThenByDescending',
  'ToArray', 'ToDictionary', 'ToHashSet', 'ToList', 'Union', 'Where', 'Zip',

  // async — the async variants are separate members and just as common
  'ConfigureAwait', 'GetAwaiter', 'GetResult', 'Wait', 'WhenAll', 'WhenAny',
  'FromResult', 'Delay', 'Run', 'ContinueWith', 'AnyAsync', 'CountAsync',
  'FirstAsync', 'FirstOrDefaultAsync', 'SingleOrDefaultAsync', 'ToListAsync',
  'ToArrayAsync', 'SaveChangesAsync', 'FindAsync', 'AddAsync',

  // conversion, parsing, IO
  'Parse', 'TryParse', 'ToInt32', 'ToInt64', 'ToDouble', 'ToDecimal',
  'ToBoolean', 'ToDateTime', 'ToString', 'Serialize', 'Deserialize',
  'ReadAllText', 'ReadAllLines', 'WriteAllText', 'Exists', 'Combine',
  'ReadLine', 'ReadToEnd', 'Write', 'WriteLine', 'Flush', 'Dispose',
  'Append', 'AppendLine', 'AppendFormat',

  // Match / regex
  'IsMatch', 'Matches', 'Groups', 'Success',
]);

export default { globals: GLOBALS, methods: METHODS, package: 'csharp' };
