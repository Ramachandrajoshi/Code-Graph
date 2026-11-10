/**
 * Agent integration: MCP registration and instruction files.
 *
 * Every agent stores MCP servers in its own place, under its own key, in its
 * own shape. opencode in particular takes `command` as an ARRAY and requires
 * `type: "local"`, which nothing else does — writing the Claude shape there
 * produces a config the agent silently ignores.
 *
 * Instruction files matter as much as registration. An agent with the tools
 * available but no guidance keeps reaching for grep, because that is what its
 * training says to do. The instruction block is what actually changes behaviour,
 * so it is written in the same breath as the MCP entry.
 *
 * For Claude Code specifically, registration and instructions are not enough
 * either: without a pre-approval in the shared settings.json, the tool sits
 * behind a permission prompt that only a human in an interactive session can
 * clear. A subagent has no one to click "allow", so a denied call just looks
 * like a missing tool and the model falls back to grep.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Known agents.
 *
 * `detect` decides whether an agent is in use here. `createIfMissing` marks the
 * portable defaults we are willing to create in a project that shows no sign of
 * that agent — creating `.cursor/` in a repo nobody opens in Cursor is litter.
 */
export const AGENTS = {
  claude: {
    label: 'Claude Code',
    mcp: { file: '.mcp.json', key: 'mcpServers', shape: 'command-args', createIfMissing: true },
    instructions: 'CLAUDE.md',
    detect: (root) => exists(root, '.claude') || exists(root, 'CLAUDE.md') || exists(root, '.mcp.json'),
  },

  copilot: {
    label: 'GitHub Copilot',
    // VS Code uses "servers", not "mcpServers". The wrong key parses fine and
    // registers nothing.
    mcp: { file: '.vscode/mcp.json', key: 'servers', shape: 'command-args' },
    instructions: '.github/copilot-instructions.md',
    detect: (root) => exists(root, '.vscode') || exists(root, '.github'),
  },

  opencode: {
    label: 'opencode',
    mcp: { file: 'opencode.json', key: 'mcp', shape: 'opencode' },
    instructions: 'AGENTS.md',
    detect: (root) => exists(root, 'opencode.json') || exists(root, 'opencode.jsonc') || exists(root, '.opencode'),
  },

  cursor: {
    label: 'Cursor',
    mcp: { file: '.cursor/mcp.json', key: 'mcpServers', shape: 'command-args' },
    instructions: 'AGENTS.md',
    detect: (root) => exists(root, '.cursor'),
  },

  windsurf: {
    label: 'Windsurf',
    mcp: { file: '.windsurf/mcp.json', key: 'mcpServers', shape: 'command-args' },
    instructions: 'AGENTS.md',
    detect: (root) => exists(root, '.windsurf'),
  },
};

export const AGENT_IDS = Object.keys(AGENTS);

function exists(root, rel) {
  return fs.existsSync(path.join(root, rel));
}

/**
 * Resolve the `--agent` selection.
 *
 * Default is "whatever this project shows evidence of, plus Claude Code",
 * because `.mcp.json` at the root is the portable option that several tools
 * read. `all` and `none` are accepted explicitly.
 */
export function selectAgents(root, spec) {
  // `explicit` distinguishes "the user named these agents" from "we guessed".
  // An explicit request is honoured even where the agent shows no presence —
  // asking for it IS the evidence. Autodetect stays conservative and skips
  // anything the project shows no sign of.
  if (spec === 'none') return { ids: [], explicit: true };

  if (spec === 'all') return { ids: AGENT_IDS, explicit: true };

  if (spec) {
    const requested = String(spec).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const unknown = requested.filter((id) => !AGENTS[id]);
    if (unknown.length) {
      throw new Error(
        `Unknown agent${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}\n` +
        `Known: ${AGENT_IDS.join(', ')}, or 'all' / 'none'.`
      );
    }
    return { ids: requested, explicit: true };
  }

  const detected = AGENT_IDS.filter((id) => AGENTS[id].detect(root));
  const ids = detected.includes('claude') ? detected : ['claude', ...detected];
  return { ids, explicit: false };
}

// ---------------------------------------------------------------- MCP

/**
 * Register the MCP server for one agent.
 *
 * Returns `{ file, label, status }` where status is created | updated | exists |
 * skipped | unparseable. Never overwrites an existing `cgraph` entry: the user
 * may have customised the command, and silently replacing it is the kind of
 * thing that destroys trust in a tool that edits your config.
 */
export function registerMcp(root, agentId, { serverName = 'cgraph', explicit = false, launch = launchCommand() } = {}) {
  const agent = AGENTS[agentId];
  const spec = agent.mcp;
  const file = path.join(root, spec.file);
  const dir = path.dirname(file);

  // When guessing, only write into a directory the project already has —
  // creating `.cursor/` in a repo nobody opens in Cursor is litter. When the
  // user named the agent, create whatever it needs.
  const mayCreate = explicit || spec.createIfMissing || fs.existsSync(dir);
  if (!fs.existsSync(file) && !mayCreate) {
    return { file: spec.file, label: agent.label, status: 'skipped' };
  }

  let json = {};
  if (fs.existsSync(file)) {
    try {
      json = JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')));
    } catch {
      return { file: spec.file, label: agent.label, status: 'unparseable' };
    }
  }

  json[spec.key] ??= {};
  const existing = json[spec.key][serverName];
  let status = 'created';

  if (existing) {
    // A customised entry is the user's and is never touched. The one exception
    // is the entry an older cgraph wrote itself — a bare `cgraph` — when that
    // command cannot be launched from here: leaving it means the agent reports
    // "connection closed" on every start and nobody learns why.
    const repairable = isStockEntry(existing) && launch[0] !== 'cgraph';
    if (!repairable) return { file: spec.file, label: agent.label, status: 'exists' };
    status = 'repaired';
  }

  json[spec.key][serverName] = serverEntry(spec.shape, root, launch);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  return { file: spec.file, label: agent.label, status };
}

/** True for the exact entry older versions generated: a bare `cgraph serve`. */
function isStockEntry(entry) {
  if (Array.isArray(entry?.command)) {
    return entry.command[0] === 'cgraph' && entry.command[1] === 'serve';
  }
  return entry?.command === 'cgraph' && entry.args?.[0] === 'serve';
}

const BIN_PATH = fileURLToPath(new URL('../bin/cgraph.js', import.meta.url));

/**
 * The argv prefix that starts cgraph from an agent's process, as an array.
 *
 * Agents spawn MCP servers directly, with no shell and with their own PATH —
 * not the one `cgraph init` happened to run under. Three ways a bare `cgraph`
 * fails there, each surfacing only as an opaque "connection closed":
 *
 *   - it was never installed globally (run from a checkout, or via `npx`)
 *   - it is on PATH only through `node_modules/.bin`, which npm adds for the
 *     duration of a script and the agent never sees
 *   - on Windows the global command is a `.cmd` shim, which cannot be spawned
 *     without a shell
 *
 * So: a bare `cgraph` only where it will really resolve (through `cmd /c` on
 * Windows), and otherwise this node binary plus the absolute path of the
 * script — which cannot fail to resolve for as long as the install exists.
 */
export function launchCommand({
  platform = process.platform,
  onPath = cgraphOnPath(),
  execPath = process.execPath,
  binPath = BIN_PATH,
} = {}) {
  if (onPath) return platform === 'win32' ? ['cmd', '/c', 'cgraph'] : ['cgraph'];
  return [execPath, binPath].map((p) => p.replace(/\\/g, '/'));
}

/** Is a `cgraph` command on a PATH entry the agent will also have? */
function cgraphOnPath() {
  const names = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((ext) => `cgraph${ext}`)
    : ['cgraph'];

  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    // npm prepends these for the lifetime of one script or `npx` call.
    if (!dir || /node_modules[\\/]\.bin[\\/]?$/.test(dir)) continue;
    for (const name of names) {
      try {
        if (fs.statSync(path.join(dir, name)).isFile()) return true;
      } catch { /* not here */ }
    }
  }
  return false;
}

/**
 * The server entry, in the shape the target agent expects.
 *
 * `--root` is passed explicitly because agents start MCP servers with an
 * unpredictable working directory; without it the server resolves the nearest
 * index from wherever the agent happened to launch.
 */
function serverEntry(shape, root, launch) {
  const argv = [...launch, 'serve', '--root', root.replace(/\\/g, '/')];

  if (shape === 'opencode') {
    // opencode takes one flat command array and needs an explicit type.
    return { type: 'local', command: argv, enabled: true };
  }

  return { command: argv[0], args: argv.slice(1) };
}

// ---------------------------------------------------------------- Claude settings

const CLAUDE_SETTINGS_FILE = '.claude/settings.json';
// Exactly the tools the server exposes (see mcp/tools.js). A pre-approval for a
// tool that does not exist is not harmless: it is a standing grant that a
// future tool of that name would inherit without anyone deciding it should.
const CLAUDE_TOOLS = ['map', 'find'].map((t) => `mcp__cgraph__${t}`);

/**
 * Pre-approve the cgraph MCP server and its tools in Claude Code's shared,
 * checked-in settings.
 *
 * `.mcp.json` alone leaves the server behind an approval prompt. A human
 * clicks through that once and forgets about it, but a subagent — spawned
 * non-interactively, with nobody there to approve anything — just has the
 * call denied and falls back to grep, indistinguishable from the tool never
 * having existed. Writing the approval into `settings.json` (not the
 * gitignored `settings.local.json`) means every clone and every subagent
 * starts pre-approved, not just the developer who ran `init`.
 *
 * Scoped to this one server by name. `enableAllProjectMcpServers` would also
 * work, and is deliberately NOT written: in a checked-in file it approves
 * every server anyone later adds to `.mcp.json`, for every clone, with no
 * prompt — one pull request away from running an arbitrary command on each
 * contributor's machine. Whatever value the user already has there is theirs
 * and is left alone.
 *
 * Additive only: existing permissions and servers are never removed.
 */
export function writeClaudeSettings(root, { serverName = 'cgraph' } = {}) {
  const file = path.join(root, CLAUDE_SETTINGS_FILE);
  const existed = fs.existsSync(file);

  let json = {};
  if (existed) {
    try {
      json = JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')));
    } catch {
      return { file: CLAUDE_SETTINGS_FILE, status: 'unparseable' };
    }
  }

  let changed = false;

  json.enabledMcpjsonServers ??= [];
  if (!json.enabledMcpjsonServers.includes(serverName)) {
    json.enabledMcpjsonServers.push(serverName);
    changed = true;
  }

  json.permissions ??= {};
  json.permissions.allow ??= [];
  for (const tool of CLAUDE_TOOLS) {
    if (!json.permissions.allow.includes(tool)) {
      json.permissions.allow.push(tool);
      changed = true;
    }
  }

  if (!changed) return { file: CLAUDE_SETTINGS_FILE, status: 'current' };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  return { file: CLAUDE_SETTINGS_FILE, status: existed ? 'updated' : 'created' };
}

// ---------------------------------------------------------------- instructions

const MARK_START = '<!-- cgraph:start -->';
const MARK_END = '<!-- cgraph:end -->';

/**
 * The guidance an agent reads.
 *
 * Deliberately short. This sits in the agent's context for the whole session,
 * so it is subject to the same token discipline as the tool output — the point
 * is to change one reflex (reach for grep) and to flag the one thing that can
 * mislead (inferred edges). Everything else is discoverable from the tools.
 */
export function instructionBlock() {
  return `${MARK_START}
## Code navigation: use cgraph, not grep

This repo has a cgraph index. Unless you already know the exact lines you need:

- \`find <name>\` instead of grep for a symbol: ranked definitions with exact
  locations. Matches camelCase parts ("login" finds "handleLogin").
- \`map <path>\` instead of ls/glob or opening a file: a symbol outline with
  line numbers, a fraction of the file's size. Then read only those lines.
- \`map <symbol>\` for callers, callees and call paths. Use \`direction=impact\`
  before changing anything shared.

\`map\` takes a \`path\` or a \`symbol\`, never both. Edges marked \`!\` are
**inferred** from a name match, not proven — verify them. Only definitions and
call/import edges are indexed: use grep for plain text and your own reader for
file contents. The index refreshes itself; \`cgraph update\` forces it. Without
the MCP tools, the shell has the same data: \`cgraph map|find|graph|read\`.
${MARK_END}`;
}

/**
 * Write the instruction block into an agent's instructions file.
 *
 * Between markers, so re-running updates in place instead of appending a second
 * copy — and so a user's own content in the same file is never touched.
 */
export function writeInstructions(root, relFile) {
  const file = path.join(root, relFile);
  const block = instructionBlock();

  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, block + '\n');
    return { file: relFile, status: 'created' };
  }

  const start = existing.indexOf(MARK_START);
  const end = existing.indexOf(MARK_END);

  if (start !== -1 && end !== -1 && end > start) {
    const updated =
      existing.slice(0, start) + block + existing.slice(end + MARK_END.length);
    if (updated === existing) return { file: relFile, status: 'current' };
    fs.writeFileSync(file, updated);
    return { file: relFile, status: 'updated' };
  }

  // A marker-less file is the user's; append rather than rewrite.
  const separator = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(file, existing + separator + block + '\n');
  return { file: relFile, status: 'appended' };
}

/** Instruction files for a set of agents, deduplicated (several share AGENTS.md). */
export function instructionFilesFor(agentIds) {
  return [...new Set(agentIds.map((id) => AGENTS[id].instructions).filter(Boolean))];
}

/** tsconfig-style tolerance: agent configs are hand-edited and often have comments. */
function stripJsonComments(text) {
  let out = '';
  let inString = false, inLine = false, inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inLine) { if (c === '\n') { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === '*' && next === '/') { inBlock = false; i++; } continue; }
    if (inString) {
      out += c;
      if (c === '\\') { out += next ?? ''; i++; }
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && next === '/') { inLine = true; i++; continue; }
    if (c === '/' && next === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}
