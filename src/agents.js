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
 */

import fs from 'node:fs';
import path from 'node:path';

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
export function registerMcp(root, agentId, { serverName = 'cgraph', explicit = false } = {}) {
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
  if (json[spec.key][serverName]) {
    return { file: spec.file, label: agent.label, status: 'exists' };
  }

  json[spec.key][serverName] = serverEntry(spec.shape, root);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  return { file: spec.file, label: agent.label, status: 'created' };
}

/**
 * The server entry, in the shape the target agent expects.
 *
 * `--root` is passed explicitly because agents start MCP servers with an
 * unpredictable working directory; without it the server resolves the nearest
 * index from wherever the agent happened to launch.
 */
function serverEntry(shape, root) {
  const rootArg = root.replace(/\\/g, '/');

  if (shape === 'opencode') {
    // opencode takes one flat command array and needs an explicit type.
    return {
      type: 'local',
      command: ['cgraph', 'serve', '--root', rootArg],
      enabled: true,
    };
  }

  return { command: 'cgraph', args: ['serve', '--root', rootArg] };
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

This repository has a cgraph index. Prefer these tools over shell search: they
return the specific thing asked for rather than whole files, so answers are much
smaller and carry exact locations.

| Instead of | Use | Returns |
|---|---|---|
| \`ls\`, \`glob\`, opening a file to see what's in it | \`map\` | symbol outline with line numbers |
| \`grep\` for a symbol | \`find\` | ranked definitions; matches camelCase parts, so "login" finds "handleLogin" |
| reading a whole file | \`read\` | one symbol, or an exact line range |
| — no shell equivalent — | \`graph\` | callers, callees, transitive impact, call paths |
| reading node_modules or searching the web for an API | \`docs\` | the dependency API *this* repo actually calls |

Working rules:

- Start with \`map\` before exploring: an outline of a file is a small fraction
  of the file itself, and tells you which one symbol is worth reading in full.
- Before changing anything shared, run \`graph\` with \`direction=impact\` to see
  what depends on it.
- Edges marked \`!\` are **inferred** from a name match, not proven through an
  import. Verify before relying on them.
- If results look stale, call \`status\` — it re-indexes changed files.
- \`read\` accepts \`Class#method\` and \`path/to/file.ts:20-40\`.

The same data is available from the shell if MCP is unavailable:
\`cgraph map|find|read|graph|docs\`.
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
