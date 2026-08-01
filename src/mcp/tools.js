/**
 * MCP tool definitions.
 *
 * TWO tools, not thirty (three with embeddings enabled), and every word here
 * is rationed. Tool schemas sit in the agent's context on EVERY turn, so this
 * file is a permanent token tax on every conversation — a 30-tool server
 * spends 3-4k tokens forever in order to save tokens on retrieval, which
 * largely defeats the purpose.
 *
 * Tools this server used to expose are gone on purpose:
 *   - `read`: every harness already has an exact, line-based file reader.
 *     Duplicating it here just gives the model two ways to do the same thing.
 *   - `status`: freshness is handled automatically (every call refreshes a
 *     throttled index scan first), so a manual "check status" tool had no
 *     decision behind it worth spending schema tokens on. `cgraph stats` still
 *     answers this from the shell.
 *   - `docs`: dependency API lookup is better served by a dedicated docs MCP
 *     (e.g. Context7) than by re-implementing registry/node_modules parsing
 *     here.
 * `map` and `graph` are merged into one tool below: both answer "where do I
 * look next", one by structure and one by relationship, and a model choosing
 * between two similarly-described tools is exactly the ambiguity a single
 * tool with two clearly-named modes avoids.
 *
 * Responses are not truncated by default — see `budget` on `map`/`find`: it is
 * an opt-in cap, not a silent one. An agent that gets a partial answer without
 * asking for one stops looking too early, which costs far more than the
 * tokens the cap would have saved.
 *
 * Descriptions are written for the model, not for a human reading docs. The
 * highest-value words are the ones naming what each tool REPLACES, because the
 * behaviour worth changing is the agent's reflex to reach for grep and read.
 */

export function toolDefinitions({ embeddingsEnabled = false } = {}) {
  const budget = { type: 'integer', description: 'Optional cap on response tokens. Uncapped by default.' };

  const tools = [
    {
      name: 'map',
      description:
        'Two modes — pass `path` for one, `symbol` for the other; never both.\n' +
        '\n' +
        'OUTLINE (`path`): symbol hierarchy of a repo, directory, or file, with line ' +
        'numbers. Use instead of ls/glob, and instead of opening a file to see what is ' +
        'in it — an outline is a fraction of the file\'s size and tells you which symbol ' +
        'is worth reading in full.\n' +
        '\n' +
        'RELATE (`symbol`): callers, callees, importers, blast-radius impact, or the call ' +
        'path to another symbol. run it before ' +
        'changing anything shared. Edges marked "!" are guessed from a name match, not ' +
        'proven through an import; verify before relying on them.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Outline mode. Repo-relative; omit for the whole repo.' },
          kinds: { type: 'array', items: { type: 'string' }, description: 'Outline: filter, e.g. ["class","function"].' },
          symbol: { type: 'string', description: 'Relate mode. Symbol to trace relationships for.' },
          direction: {
            type: 'string',
            enum: ['callers', 'callees', 'importers', 'impact', 'path', 'explore'],
            description:
              'Relate mode, default "callers". callees = what it calls. importers = files ' +
              'importing its file. impact = everything transitively affected by changing it. ' +
              'path = call path to `to`. explore = callers and callees together in one call, ' +
              'each with exact start-end line ranges.',
          },
          to: { type: 'string', description: 'Relate: destination symbol, required for direction=path.' },
          depth: { type: 'integer', description: 'Outline: directory levels (default 1). Relate: traversal depth for impact/path.' },
          exact: { type: 'boolean', description: 'Relate: proven edges only, hide name-match guesses.' },
          limit: { type: 'integer', description: 'Relate: max results.' },
          budget,
        },
      },
    },

    {
      name: 'find',
      description:
        'Search symbols by name, signature, or doc text. Use instead of grep. ' +
        'Matches camelCase parts ("login" finds "handleLogin") and substrings, ranked ' +
        'by importance. Returns definitions with exact locations, not line hits.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          kind: {
            type: 'string',
            enum: ['class', 'interface', 'function', 'method', 'field', 'var', 'const', 'type', 'enum'],
          },
          lang: { type: 'string' },
          path: { type: 'string', description: 'Path prefix filter.' },
          limit: { type: 'integer' },
          budget,
        },
        required: ['query'],
      },
    },

  ];

  // Registered only when configured, so its schema costs nothing otherwise.
  if (embeddingsEnabled) {
    tools.push({
      name: 'similar',
      description:
        'Find code by what it does rather than what it is called. Semantic search.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'integer' } },
        required: ['query'],
      },
    });
  }

  return tools;
}
