/**
 * MCP tool definitions.
 *
 * SEVEN tools, not thirty, and every word here is rationed. Tool schemas sit in
 * the agent's context on EVERY turn, so this file is a permanent token tax on
 * every conversation — a 30-tool server spends 3-4k tokens forever in order to
 * save tokens on retrieval, which largely defeats the purpose.
 *
 * Measured cost: ~1300 tokens for all six, enforced by test/mcp.test.js. The
 * original target was 900, which turned out not to be reachable while keeping
 * real enums and filters — roughly half the remaining cost is JSON Schema
 * structure rather than prose, and trimming further would mean removing
 * genuinely useful parameters. Recorded here rather than quietly missed.
 *
 * For comparison, the 30-tool servers this replaces cost 3-4k tokens per turn.
 *
 * Descriptions are written for the model, not for a human reading docs. The
 * highest-value words are the ones naming what each tool REPLACES, because the
 * behaviour worth changing is the agent's reflex to reach for grep and read.
 */

export function toolDefinitions({ embeddingsEnabled = false } = {}) {
  const budget = { type: 'integer', description: 'Max response tokens.' };

  const tools = [
    {
      name: 'map',
      description:
        'Outline a repo, directory, or file: symbol hierarchy with line numbers. ' +
        'Use instead of ls/glob, and instead of reading a file to see what is in it. ' +
        'Typically 10-20x cheaper than reading.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repo-relative. Omit for whole repo.' },
          depth: { type: 'integer', description: 'Directory levels (default 1).' },
          kinds: { type: 'array', items: { type: 'string' }, description: 'e.g. ["class","function"].' },
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

    {
      name: 'read',
      description:
        'Read one symbol or line range exactly. Use instead of reading a whole file.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Name, Class#method, or path:start-end.' },
          mode: { type: 'string', enum: ['body', 'signature'] },
          budget,
        },
        required: ['target'],
      },
    },

    {
      name: 'graph',
      description:
        'Relationships between symbols. No grep equivalent exists — use before ' +
        'changing shared code. Edges marked "!" are guessed from a name match, not ' +
        'proven through an import.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          direction: {
            type: 'string',
            enum: ['callers', 'callees', 'importers', 'impact', 'path'],
            description: 'impact = everything transitively affected by changing it.',
          },
          to: { type: 'string', description: 'Destination, for direction=path.' },
          depth: { type: 'integer' },
          exact: { type: 'boolean', description: 'Proven edges only.' },
          budget,
        },
        required: ['symbol'],
      },
    },

    {
      name: 'docs',
      description:
        'A dependency API, ranked by what THIS project calls, with usage sites. ' +
        'Use instead of reading node_modules or searching the web.',
      inputSchema: {
        type: 'object',
        properties: {
          package: { type: 'string', description: 'Omit to list deps by usage.' },
          symbol: { type: 'string' },
          top: { type: 'integer' },
        },
      },
    },

    {
      name: 'status',
      description:
        'Index freshness and stats. Call when results look stale. Re-indexes changed files.',
      inputSchema: {
        type: 'object',
        properties: { refresh: { type: 'boolean' } },
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
