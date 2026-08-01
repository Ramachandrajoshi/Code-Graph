/**
 * `cgraph init` — index a project, register the MCP server, and teach the agent
 * to use it.
 *
 * This is the only command that modifies files outside `.cgraph/`, so it is
 * conservative by design: it never overwrites an existing MCP entry, never
 * rewrites a config file it cannot parse, never creates directories for tools
 * the project does not use, and reports every change it made. A tool that
 * silently edits a developer's editor config loses trust permanently.
 *
 * Registration alone is not enough. An agent with the tools available but no
 * guidance keeps reaching for grep, because that is what its training says to
 * do — so the instruction block is written at the same time.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig, projectDir } from '../../core/config.js';
import { Store } from '../../core/store.js';
import { Indexer } from '../../core/indexer.js';
import { PackRegistry } from '../../packs/registry.js';
import { detectSubprojectTechnologies } from '../../packs/technologies.js';
import {
  AGENTS, AGENT_IDS, selectAgents, registerMcp, writeInstructions, instructionFilesFor,
  writeClaudeSettings,
} from '../../agents.js';
import { out, color, Progress, toks, duration } from '../ui.js';

export async function run(args) {
  if (args.help) return help();

  const root = args.root ? path.resolve(args.root) : process.cwd();
  const config = loadConfig(root, { root });

  // Resolve the agent selection before doing any work, so a typo in --agent
  // fails immediately rather than after a full index.
  const skipMcp = args.mcp === false || args.noMcp === true;
  const selection = skipMcp ? { ids: [], explicit: true } : selectAgents(root, args.agent);
  const agentIds = selection.ids;
  const wantInstructions = args.instructions !== false;

  out('');
  out(`${color.bold('cgraph')} init  ${root}`);
  out('');

  fs.mkdirSync(projectDir(root), { recursive: true });

  // 1. Index -----------------------------------------------------------------
  const store = await Store.open(config.db);
  let stats;
  try {
    const registry = await PackRegistry.load(config);
    const progress = new Progress('  indexing', { quiet: args.quiet });
    stats = await new Indexer({ store, config, registry, progress }).run({});
    progress.done();

    // What was detected drives which packs loaded, so showing it lets a wrong
    // guess be spotted immediately rather than surfacing later as mysteriously
    // missing symbols.
    const tech = registry.technologies;
    if (tech?.stacks?.length) {
      const parts = [tech.stacks.join(', ')];
      if (tech.frameworks.length) parts.push(tech.frameworks.join(', '));
      out(`  detected  ${parts.join('  ·  ')}`);
    }

    // A root that bundles several independently-cloned repos (fleet of
    // microservices) gets each one labeled here, so a wrong or missing
    // detection is visible immediately rather than surfacing later as an agent
    // confusing one stack's conventions for another's.
    const subprojectPaths = store.listSubprojects();
    if (subprojectPaths.length) {
      const perSub = detectSubprojectTechnologies(root, subprojectPaths);
      out('');
      out('  sub-projects');
      for (const rel of subprojectPaths) {
        const t = perSub[rel];
        const parts = [t.stacks.join(', ') || '(unknown)'];
        if (t.frameworks.length) parts.push(t.frameworks.join(', '));
        out(`    ${rel.padEnd(10)} ${parts.join('  ·  ')}`);
      }
    }

    const s = store.stats();
    out(`  indexed   ${s.parsed} files, ${s.nodes} symbols, ${s.edges} edges`);
    out(`            ~${toks(s.tok)} tokens of source  ·  ${duration(stats.durationMs)}`);

    const gaps = registry.gaps();
    if (gaps.length) {
      // Honesty about coverage up front. A user whose main language has no
      // queries yet should learn it here, not by wondering why find is empty.
      out('');
      out(color.yellow(`  no extraction queries yet for: ${gaps.join(', ')}`));
      out(color.dim('            these files are listed by map but have no symbols'));
    }
    registry.dispose();
  } finally {
    store.close();
  }

  // 2. Config and .gitignore -------------------------------------------------
  saveConfig(root, config);
  const ignored = ensureGitignore(root);

  // 3. Agents ----------------------------------------------------------------
  const mcpResults = agentIds.map((id) => ({
    id, ...registerMcp(root, id, { explicit: selection.explicit }),
  }));

  // Instructions follow registration. Writing guidance for an agent whose MCP
  // config we declined to create would leave a file telling the agent to use
  // tools it was never given.
  const connected = mcpResults.filter((r) => r.status !== 'skipped').map((r) => r.id);
  const docResults = wantInstructions && connected.length
    ? instructionFilesFor(connected).map((file) => writeInstructions(root, file))
    : [];

  // Registration alone leaves the tool behind a permission prompt that only a
  // human in an interactive session can clear — a subagent has no one to
  // click "allow", so this closes that gap for Claude Code specifically.
  const settingsResult = connected.includes('claude') ? writeClaudeSettings(root) : null;

  // 4. Report ----------------------------------------------------------------
  out('');
  out(`  ${color.green('created')}   .cgraph/`);
  if (ignored) out(`  ${color.green('updated')}   .gitignore`);

  for (const r of mcpResults) {
    const tag = {
      created: color.green('created'),
      exists: color.dim('exists '),
      skipped: color.dim('skipped'),
      unparseable: color.yellow('skipped'),
    }[r.status];
    const note = r.status === 'unparseable' ? ' (not valid JSON; left alone)'
      : r.status === 'skipped' ? ' (not in use here)'
      : '';
    out(`  ${tag}   ${r.file}${note ? color.dim(note) : ''}  ${color.dim(r.label)}`);
  }

  for (const r of docResults) {
    const tag = {
      created: color.green('created'),
      appended: color.green('updated'),
      updated: color.green('updated'),
      current: color.dim('current'),
    }[r.status];
    out(`  ${tag}   ${r.file}  ${color.dim('agent instructions')}`);
  }

  if (settingsResult) {
    const tag = {
      created: color.green('created'),
      updated: color.green('updated'),
      current: color.dim('current'),
      unparseable: color.yellow('skipped'),
    }[settingsResult.status];
    const note = settingsResult.status === 'unparseable' ? ' (not valid JSON; left alone)' : '';
    out(`  ${tag}   ${settingsResult.file}${note ? color.dim(note) : ''}  ${color.dim('pre-approved so subagents don\'t need a human to allow it')}`);
  }

  out('');
  const registered = mcpResults.filter((r) => r.status === 'created');
  if (registered.length) {
    out('  Restart your agent to pick up the MCP server.');
  } else if (!agentIds.length && !skipMcp) {
    out('  No agent detected. Register manually, or re-run with --agent <name>:');
    out(color.dim(`    { "command": "cgraph", "args": ["serve", "--root", "${root.replace(/\\/g, '/')}"] }`));
  } else if (!registered.length) {
    out(color.dim('  All agent configs were already registered.'));
  }

  out(`  Try: ${color.cyan('cgraph map')}  ·  ${color.cyan('cgraph find <symbol>')}  ·  ${color.cyan('cgraph graph <symbol> --dir impact')}`);
  out('');
}

/**
 * Append `.cgraph/` to .gitignore if absent.
 *
 * The index is a build artifact — machine-specific paths, constantly rewritten.
 * Committing it produces enormous diffs on every branch switch.
 */
function ensureGitignore(root) {
  const file = path.join(root, '.gitignore');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // No .gitignore, and not a git repo either: creating one would be presumptuous.
    if (!fs.existsSync(path.join(root, '.git'))) return false;
  }

  if (/^\.cgraph\/?\s*$/m.test(text)) return false;

  const prefix = text && !text.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(file, `${prefix}\n# cgraph index (machine-specific, regenerated)\n.cgraph/\n`);
  return true;
}

function help() {
  const rows = AGENT_IDS.map((id) => {
    const a = AGENTS[id];
    return `  ${id.padEnd(10)} ${a.mcp.file.padEnd(22)} ${a.instructions}`;
  }).join('\n');

  out(`
${color.bold('cgraph init')} — index this project and connect it to your agent

  cgraph init                     Index, register MCP, write agent instructions
  cgraph init --agent claude      Only Claude Code
  cgraph init --agent copilot,opencode
  cgraph init --agent all         Every agent below
  cgraph init --no-mcp            Index only; touch no agent files
  cgraph init --no-instructions   Register MCP but write no instruction files

${color.bold('AGENTS')}
  ${color.dim('id         mcp config             instructions')}
${rows}

  With no --agent, cgraph registers whichever agents this project shows
  evidence of, plus Claude Code (.mcp.json is the portable default several
  tools read). Directories are never created for agents you do not use.

${color.bold('WHAT IT WRITES')}
  .cgraph/                 index + config      (added to .gitignore)
  <mcp config>             one server entry named "cgraph"
  <instructions>           a block between <!-- cgraph:start --> markers

  Existing entries are never overwritten, files that are not valid JSON are
  left untouched, and re-running updates the instruction block in place.

${color.bold('OPTIONS')}
  --agent <list>       Comma-separated ids, or 'all' / 'none'
  --no-instructions    Skip instruction files
  --no-mcp             Skip all agent files
  --root <dir>         Project directory (default: current)
  --quiet              No progress output
`);
}
