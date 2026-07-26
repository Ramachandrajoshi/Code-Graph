/**
 * Agent integration tests.
 *
 * `init` writes into files a developer owns — their editor config and their
 * instructions files. The bar is therefore higher than "it works": it must
 * never clobber, never duplicate on re-run, never damage a file it cannot
 * parse, and never leave an agent told to use tools it was not given.
 *
 * The per-agent config shapes are also pinned here. They differ in ways that
 * fail silently: VS Code uses `servers` rather than `mcpServers`, and opencode
 * takes a single `command` array rather than `command` + `args`. Writing the
 * wrong shape produces a config the agent parses happily and ignores.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  AGENTS, AGENT_IDS, selectAgents, registerMcp, writeInstructions,
  instructionFilesFor, instructionBlock,
} from '../src/agents.js';

const require = createRequire(import.meta.url);
const skip = (() => {
  try { require.resolve('tree-sitter-wasms/package.json'); return false; }
  catch { return true; }
})();
const opts = { skip };

const BIN = fileURLToPath(new URL('../bin/cgraph.js', import.meta.url));

function makeRepo(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-agent-'));
  const base = {
    'package.json': '{"name":"demo"}',
    'src/db.js': 'export function findUser(id) { return id; }\n',
    'src/app.js': "import { findUser } from './db';\nexport function handleLogin(e) { return findUser(e); }\n",
    ...files,
  };
  for (const [rel, content] of Object.entries(base)) {
    const abs = path.join(root, rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

function init(root, extra = []) {
  return execFileSync(process.execPath, [BIN, 'init', '--root', root, '--quiet', ...extra], {
    encoding: 'utf8', cwd: root,
    env: { ...process.env, NO_COLOR: '1', CGRAPH_HOME: path.join(root, '.cache') },
  });
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const readJson = (root, rel) => JSON.parse(read(root, rel));
const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });

// ---------------------------------------------------------------- selection

test('every agent declares a complete definition', () => {
  for (const id of AGENT_IDS) {
    const a = AGENTS[id];
    assert.ok(a.label, `${id} needs a label`);
    assert.ok(a.mcp?.file && a.mcp?.key && a.mcp?.shape, `${id} needs an mcp spec`);
    assert.ok(a.instructions, `${id} needs an instructions file`);
    assert.equal(typeof a.detect, 'function', `${id} needs a detect()`);
  }
});

test('autodetect always includes Claude Code as the portable default', () => {
  const root = makeRepo();
  try {
    const { ids, explicit } = selectAgents(root, undefined);
    assert.ok(ids.includes('claude'));
    assert.equal(explicit, false);
  } finally { cleanup(root); }
});

test('autodetect finds agents by their marker files', () => {
  const root = makeRepo({ '.cursor/settings.json': '{}', 'opencode.json': '{}' });
  try {
    const { ids } = selectAgents(root, undefined);
    assert.ok(ids.includes('cursor'));
    assert.ok(ids.includes('opencode'));
  } finally { cleanup(root); }
});

test('an explicit selection is marked explicit', () => {
  const root = makeRepo();
  try {
    assert.deepEqual(selectAgents(root, 'copilot,opencode'), {
      ids: ['copilot', 'opencode'], explicit: true,
    });
    assert.equal(selectAgents(root, 'all').ids.length, AGENT_IDS.length);
    assert.deepEqual(selectAgents(root, 'none').ids, []);
  } finally { cleanup(root); }
});

test('an unknown agent name fails with the known list', () => {
  const root = makeRepo();
  try {
    assert.throws(() => selectAgents(root, 'emacs'), /Unknown agent: emacs/);
    assert.throws(() => selectAgents(root, 'emacs'), /claude/);
  } finally { cleanup(root); }
});

// ---------------------------------------------------------------- MCP shapes

test('Claude Code gets mcpServers with command and args', () => {
  const root = makeRepo();
  try {
    registerMcp(root, 'claude');
    const entry = readJson(root, '.mcp.json').mcpServers.cgraph;
    assert.equal(entry.command, 'cgraph');
    assert.deepEqual(entry.args.slice(0, 2), ['serve', '--root']);
  } finally { cleanup(root); }
});

test('VS Code / Copilot uses the "servers" key, not "mcpServers"', () => {
  // The wrong key parses fine and registers nothing at all.
  const root = makeRepo({ '.vscode/settings.json': '{}' });
  try {
    registerMcp(root, 'copilot');
    const json = readJson(root, '.vscode/mcp.json');
    assert.ok(json.servers?.cgraph, 'must be under "servers"');
    assert.equal(json.mcpServers, undefined);
  } finally { cleanup(root); }
});

test('opencode gets a command array and type: local', () => {
  // opencode takes one flat command array; command+args is silently ignored.
  const root = makeRepo({ 'opencode.json': '{}' });
  try {
    registerMcp(root, 'opencode');
    const entry = readJson(root, 'opencode.json').mcp.cgraph;
    assert.equal(entry.type, 'local');
    assert.ok(Array.isArray(entry.command), 'command must be an array');
    assert.equal(entry.command[0], 'cgraph');
    assert.equal(entry.enabled, true);
    assert.equal(entry.args, undefined, 'opencode has no args field');
  } finally { cleanup(root); }
});

test('the server entry pins --root', () => {
  // Agents launch MCP servers with an unpredictable working directory; without
  // an explicit root the server resolves whatever index is nearest to that.
  const root = makeRepo();
  try {
    registerMcp(root, 'claude');
    const args = readJson(root, '.mcp.json').mcpServers.cgraph.args;
    assert.ok(args.includes('--root'));
    assert.ok(args[args.indexOf('--root') + 1].length > 0);
  } finally { cleanup(root); }
});

// ---------------------------------------------------------------- safety

test('an existing cgraph entry is never overwritten', () => {
  const root = makeRepo({
    '.mcp.json': JSON.stringify({ mcpServers: { cgraph: { command: 'my/custom/cgraph' } } }),
  });
  try {
    assert.equal(registerMcp(root, 'claude').status, 'exists');
    assert.equal(readJson(root, '.mcp.json').mcpServers.cgraph.command, 'my/custom/cgraph');
  } finally { cleanup(root); }
});

test('unrelated servers survive registration', () => {
  const root = makeRepo({
    '.mcp.json': JSON.stringify({ mcpServers: { other: { command: 'other-tool' } } }),
  });
  try {
    registerMcp(root, 'claude');
    const servers = readJson(root, '.mcp.json').mcpServers;
    assert.equal(servers.other.command, 'other-tool');
    assert.ok(servers.cgraph);
  } finally { cleanup(root); }
});

test('a config that is not valid JSON is left untouched', () => {
  const broken = '{ this is not json';
  const root = makeRepo({ '.mcp.json': broken });
  try {
    assert.equal(registerMcp(root, 'claude').status, 'unparseable');
    assert.equal(read(root, '.mcp.json'), broken);
  } finally { cleanup(root); }
});

test('a config with comments and trailing commas is still handled', () => {
  // Agent configs are hand-edited; JSON.parse alone would declare them broken
  // and silently skip registration.
  const root = makeRepo({
    '.vscode/mcp.json': '{\n  // my servers\n  "servers": {},\n}',
  });
  try {
    assert.equal(registerMcp(root, 'copilot').status, 'created');
    assert.ok(readJson(root, '.vscode/mcp.json').servers.cgraph);
  } finally { cleanup(root); }
});

test('autodetect does not create directories for unused agents', () => {
  const root = makeRepo();
  try {
    assert.equal(registerMcp(root, 'cursor', { explicit: false }).status, 'skipped');
    assert.ok(!fs.existsSync(path.join(root, '.cursor')));
  } finally { cleanup(root); }
});

test('an explicitly requested agent is set up even with no prior presence', () => {
  // Naming the agent IS the evidence; skipping it would be confusing.
  const root = makeRepo();
  try {
    assert.equal(registerMcp(root, 'cursor', { explicit: true }).status, 'created');
    assert.ok(readJson(root, '.cursor/mcp.json').mcpServers.cgraph);
  } finally { cleanup(root); }
});

// ---------------------------------------------------------------- instructions

test('the instruction block names the tools and the grep replacement', () => {
  const block = instructionBlock();
  for (const tool of ['map', 'find', 'read', 'graph', 'docs', 'update']) {
    assert.match(block, new RegExp(`\\b${tool}\\b`), `should mention ${tool}`);
  }
  assert.match(block, /grep/, 'the behaviour being replaced must be named');
  assert.match(block, /inferred/i, 'inferred edges are the one thing that can mislead');
});

test('the instruction block stays small enough to sit in every session', async () => {
  // It is loaded into the agent's context for the whole session, so it is under
  // the same token discipline as tool output.
  const { estimate } = await import('../src/core/tokens.js');
  const tokens = estimate(instructionBlock());
  assert.ok(tokens < 600, `instruction block costs ${tokens} tokens; budget is 600`);
});

test('instructions are created when the file is absent', () => {
  const root = makeRepo();
  try {
    assert.equal(writeInstructions(root, 'CLAUDE.md').status, 'created');
    assert.match(read(root, 'CLAUDE.md'), /cgraph:start/);
  } finally { cleanup(root); }
});

test('existing instructions content is preserved', () => {
  const root = makeRepo({ 'CLAUDE.md': '# My Project\n\nHouse rules here.\n' });
  try {
    assert.equal(writeInstructions(root, 'CLAUDE.md').status, 'appended');
    const text = read(root, 'CLAUDE.md');
    assert.match(text, /House rules here/, "the user's own content must survive");
    assert.match(text, /cgraph:start/);
  } finally { cleanup(root); }
});

test('re-writing updates in place instead of appending a second copy', () => {
  const root = makeRepo({ 'CLAUDE.md': '# Mine\n' });
  try {
    writeInstructions(root, 'CLAUDE.md');
    writeInstructions(root, 'CLAUDE.md');
    writeInstructions(root, 'CLAUDE.md');
    const text = read(root, 'CLAUDE.md');
    assert.equal((text.match(/cgraph:start/g) ?? []).length, 1, 'exactly one block');
    assert.equal((text.match(/# Mine/g) ?? []).length, 1);
  } finally { cleanup(root); }
});

test('content outside the markers is not disturbed by an update', () => {
  const root = makeRepo();
  try {
    writeInstructions(root, 'CLAUDE.md');
    fs.appendFileSync(path.join(root, 'CLAUDE.md'), '\n## Added later\n\nMore rules.\n');
    writeInstructions(root, 'CLAUDE.md');
    assert.match(read(root, 'CLAUDE.md'), /## Added later[\s\S]*More rules/);
  } finally { cleanup(root); }
});

test('agents sharing AGENTS.md produce one file, not three', () => {
  const files = instructionFilesFor(['opencode', 'cursor', 'windsurf']);
  assert.deepEqual(files, ['AGENTS.md']);
});

// ---------------------------------------------------------------- end to end

test('init autodetects and wires up the agents in use', opts, () => {
  const root = makeRepo({ '.vscode/settings.json': '{}', 'CLAUDE.md': '# Notes\n' });
  try {
    init(root);
    assert.ok(readJson(root, '.mcp.json').mcpServers.cgraph, 'Claude Code registered');
    assert.ok(readJson(root, '.vscode/mcp.json').servers.cgraph, 'Copilot registered');
    assert.match(read(root, 'CLAUDE.md'), /cgraph:start/);
    assert.match(read(root, '.github/copilot-instructions.md'), /cgraph:start/);
    assert.ok(!fs.existsSync(path.join(root, '.cursor')), 'unused agents untouched');
  } finally { cleanup(root); }
});

test('init --agent selects only what was asked for', opts, () => {
  const root = makeRepo();
  try {
    init(root, ['--agent', 'opencode']);
    assert.ok(readJson(root, 'opencode.json').mcp.cgraph);
    assert.match(read(root, 'AGENTS.md'), /cgraph:start/);
    assert.ok(!fs.existsSync(path.join(root, '.mcp.json')), 'claude not requested');
  } finally { cleanup(root); }
});

test('init --agent all wires up every agent', opts, () => {
  const root = makeRepo();
  try {
    init(root, ['--agent', 'all']);
    for (const id of AGENT_IDS) {
      assert.ok(
        fs.existsSync(path.join(root, AGENTS[id].mcp.file)),
        `${id}: ${AGENTS[id].mcp.file} should exist`
      );
    }
  } finally { cleanup(root); }
});

test('init --no-instructions registers MCP but writes no guidance', opts, () => {
  const root = makeRepo();
  try {
    init(root, ['--no-instructions']);
    assert.ok(readJson(root, '.mcp.json').mcpServers.cgraph);
    assert.ok(!fs.existsSync(path.join(root, 'CLAUDE.md')));
  } finally { cleanup(root); }
});

test('init --no-mcp touches no agent files at all', opts, () => {
  const root = makeRepo();
  try {
    init(root, ['--no-mcp']);
    assert.ok(fs.existsSync(path.join(root, '.cgraph', 'index.db')), 'still indexes');
    assert.ok(!fs.existsSync(path.join(root, '.mcp.json')));
    assert.ok(!fs.existsSync(path.join(root, 'CLAUDE.md')));
  } finally { cleanup(root); }
});

test('an agent skipped for MCP is not given instructions either', opts, () => {
  // Otherwise the file tells the agent to use tools it was never given.
  const root = makeRepo();
  try {
    init(root);   // autodetect: copilot has no .vscode or .github here
    assert.ok(!fs.existsSync(path.join(root, '.github', 'copilot-instructions.md')));
  } finally { cleanup(root); }
});

test('init --agent with a bad name fails before indexing', opts, () => {
  const root = makeRepo();
  try {
    let output = '';
    try { init(root, ['--agent', 'nonsense']); }
    catch (err) { output = (err.stderr ?? '') + (err.stdout ?? ''); }
    assert.match(output, /Unknown agent/);
    assert.ok(!fs.existsSync(path.join(root, '.cgraph', 'index.db')),
      'a typo should not cost a full index');
  } finally { cleanup(root); }
});

test('running init twice changes nothing the second time', opts, () => {
  const root = makeRepo({ '.vscode/settings.json': '{}' });
  try {
    init(root);
    const before = {
      mcp: read(root, '.mcp.json'),
      vscode: read(root, '.vscode/mcp.json'),
      claude: read(root, 'CLAUDE.md'),
    };
    init(root);
    assert.equal(read(root, '.mcp.json'), before.mcp);
    assert.equal(read(root, '.vscode/mcp.json'), before.vscode);
    assert.equal(read(root, 'CLAUDE.md'), before.claude);
  } finally { cleanup(root); }
});

test('init --help documents every agent', opts, () => {
  const output = execFileSync(process.execPath, [BIN, 'init', '--help'], {
    encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
  });
  for (const id of AGENT_IDS) {
    assert.match(output, new RegExp(`\\b${id}\\b`), `--help should list '${id}'`);
  }
  assert.match(output, /--agent/);
  assert.match(output, /--no-instructions/);
});
