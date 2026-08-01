/**
 * CLI router.
 *
 * Commands are lazily imported so that `cgraph map` doesn't pay to load the
 * indexer or the MCP server. On a tool an agent may invoke dozens of times
 * per session, startup latency is a real cost.
 */

import { parseArgs } from './args.js';
import { out, color } from './ui.js';

const COMMANDS = {
  init: () => import('./commands/init.js'),
  index: () => import('./commands/index-cmd.js'),
  update: () => import('./commands/index-cmd.js'),
  map: () => import('./commands/map.js'),
  find: () => import('./commands/find.js'),
  read: () => import('./commands/read.js'),
  graph: () => import('./commands/graph.js'),
  stats: () => import('./commands/stats.js'),
  packs: () => import('./commands/packs.js'),
  doctor: () => import('./commands/doctor.js'),
  serve: () => import('./commands/serve.js'),
  watch: () => import('./commands/watch.js'),
  hooks: () => import('./commands/hooks.js'),
};

const HELP = `
${color.bold('cgraph')} — token-efficient code retrieval for AI agents

${color.bold('USAGE')}
  cgraph <command> [options]

${color.bold('SETUP')}
  init                 Index, register MCP, write agent instructions
                       ${color.dim('--agent claude|copilot|opencode|cursor|windsurf|all')}
  index [--force]      Build or rebuild the index
  update               Re-index only what changed
  watch                Keep the index fresh as files change
  hooks                Pre-warm the index on git checkout/merge/rebase

${color.bold('RETRIEVAL')}
  map [path]           Hierarchical outline          (replaces ls / glob)
  find <query>         Ranked symbol + text search   (replaces grep)
  read <symbol|loc>    Exact code slice              (replaces whole-file read)
  graph <symbol>       Callers, callees, impact      (no shell equivalent)

${color.bold('DIAGNOSTICS')}
  stats                Index size and token savings to date
  doctor               Resolution quality, misconfiguration, staleness
  packs                List, add, or scaffold language packs
  serve                Run the MCP server on stdio

${color.bold('GLOBAL OPTIONS')}
  --root <dir>         Project root (default: nearest .cgraph or .git)
  --json               Machine-readable output
  --budget <n>         Cap response size in tokens
  --quiet              Suppress progress output
  -h, --help           Show help for a command

Run ${color.cyan('cgraph <command> --help')} for command-specific options.
`;

export async function main(argv) {
  const args = parseArgs(argv, {
    // `agent` must consume a value, or `--agent claude` parses 'claude' as a
    // positional and the flag silently becomes `true`.
    strings: ['root', 'path', 'lang', 'kind', 'mode', 'dir', 'symbol', 'q', 'agent', 'grammar', 'to'],
    numbers: ['budget', 'depth', 'limit', 'workers'],
    alias: { h: 'help', v: 'version', q: 'query' },
  });

  if (args.version) {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const pkgUrl = new URL('../../package.json', import.meta.url);
    out(JSON.parse(readFileSync(fileURLToPath(pkgUrl), 'utf8')).version);
    return;
  }

  const name = args._[0];

  if (!name || (args.help && !name)) {
    out(HELP);
    return;
  }

  const load = COMMANDS[name];
  if (!load) {
    const near = Object.keys(COMMANDS).filter((c) => c.startsWith(name[0]));
    throw new Error(
      `Unknown command '${name}'.` +
        (near.length ? ` Did you mean: ${near.join(', ')}?` : '') +
        `\nRun \`cgraph --help\` for the command list.`
    );
  }

  const mod = await load();
  const handler = mod.run ?? mod.default;
  await handler({ ...args, _: args._.slice(1), _command: name });
}
