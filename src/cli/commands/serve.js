/**
 * `cgraph serve` — run the MCP server on stdio.
 *
 * Nothing may write to stdout except protocol messages; a single stray log line
 * corrupts the JSON-RPC stream and the client disconnects with no useful error.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../mcp/server.js';
import { out, color } from '../ui.js';

export async function run(args) {
  if (args.help) return help();

  const version = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8')
  ).version;

  let ctx;
  try {
    ctx = await createServer({ root: args.root, version });
  } catch (err) {
    // Startup failures must be legible: the client shows stderr, and "no index"
    // is by far the most common cause.
    process.stderr.write(
      `[cgraph] cannot start: ${err.message}\n` +
        '[cgraph] run `cgraph init` in the project directory first.\n'
    );
    process.exit(1);
  }

  process.stderr.write(
    `[cgraph] serving ${ctx.config.root} (${ctx.store.stats().nodes} symbols)\n`
  );

  const shutdown = () => {
    try { ctx.refresher?.dispose(); } catch { /* never loaded */ }
    try { ctx.store.close(); } catch { /* already closed */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await ctx.server.start();
  shutdown();
}

function help() {
  out(`
${color.bold('cgraph serve')} — run the MCP server on stdio

Normally started by your agent, not by hand. \`cgraph init\` registers it
automatically in .mcp.json, .cursor/mcp.json, and similar.

${color.bold('OPTIONS')}
  --root <dir>   Project to serve (default: nearest .cgraph)
`);
}
