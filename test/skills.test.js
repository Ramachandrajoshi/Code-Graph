/**
 * Agent Skill tests.
 *
 * The skill is the integration with the fewest moving parts — one file a
 * harness reads — so the failure modes worth guarding are: the frontmatter
 * being malformed (harnesses silently ignore an unparseable SKILL.md, which is
 * indistinguishable from the skill not existing), the `name` not matching the
 * directory (discovery keys off both), the description ballooning past a
 * sentence (it sits in context every turn), and install clobbering a file the
 * developer wrote by hand at the same path.
 *
 * These exercise the pure functions directly. No grammars, no indexing, so
 * they run on every machine, not only where tree-sitter-wasms is present.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  SKILL_NAME, SCOPES, skillFile, skillContent,
  installSkill, uninstallSkill, skillStatus,
} from '../src/skills.js';

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-skill-'));
}
const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// ---------------------------------------------------------------- content

test('SKILL.md has a name and description frontmatter block', () => {
  const text = skillContent();
  // The harness parses frontmatter between leading `---` fences.
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(fm, 'SKILL.md must open with a --- frontmatter block');
  assert.match(fm[1], /^name:\s*\S+/m);
  assert.match(fm[1], /^description:\s*\S+/m);
});

test('the skill name matches the directory it is installed into', () => {
  // Harnesses discover by directory and validate the `name` field matches it.
  assert.match(skillContent(), new RegExp(`^name:\\s*${SKILL_NAME}\\s*$`, 'm'));
  assert.ok(skillFile(makeRoot()).endsWith(path.join('.claude', 'skills', SKILL_NAME, 'SKILL.md')));
});

test('the description is a single rationed sentence', () => {
  // It sits in the model's context on every turn; a multi-paragraph
  // description spends tokens to save them, the 30-tool-server mistake.
  const desc = skillContent().match(/^description:\s*(.*)$/m)[1].trim();
  assert.ok(desc.length > 20, 'description should be meaningful');
  assert.ok(desc.length <= 600, `description is ${desc.length} chars — keep it rationed`);
  assert.ok(!desc.includes('\n'), 'description must be a single line');
});

test('the body teaches the shell verbs an agent will run', () => {
  const text = skillContent();
  for (const verb of ['cgraph map', 'cgraph find', 'cgraph graph']) {
    assert.ok(text.includes(verb), `body should mention \`${verb}\``);
  }
  // Degrade, don't stall: the skill must tell the agent the CLI works without MCP.
  assert.match(text, /MCP/i);
  assert.ok(/fallback|works on its own|from the shell/i.test(text),
    'body must point the agent at the CLI when MCP is unavailable');
});

// ---------------------------------------------------------------- install

test('install creates the project skill at the discovery path', () => {
  const root = makeRoot();
  try {
    const r = installSkill(root);
    assert.equal(r.status, 'created');
    assert.ok(fs.existsSync(skillFile(root)));
    assert.equal(read(root, '.claude/skills/cgraph/SKILL.md'), skillContent());
  } finally { cleanup(root); }
});

test('install is idempotent: a second run reports current, not a rewrite', () => {
  const root = makeRoot();
  try {
    installSkill(root);
    const second = installSkill(root);
    assert.equal(second.status, 'current');
  } finally { cleanup(root); }
});

test('install refreshes a stale skill in place', () => {
  const root = makeRoot();
  try {
    installSkill(root);
    fs.writeFileSync(skillFile(root), '---\nname: cgraph\ndescription: old\n---\n\nstale\n');
    const r = installSkill(root);
    assert.equal(r.status, 'updated');
    assert.equal(read(root, '.claude/skills/cgraph/SKILL.md'), skillContent());
  } finally { cleanup(root); }
});

test('the global scope resolves under the home directory', () => {
  const file = skillFile(makeRoot(), 'global');
  assert.ok(file.startsWith(os.homedir()));
  assert.ok(file.endsWith(path.join('.claude', 'skills', 'cgraph', 'SKILL.md')));
});

test('an unknown scope fails with the list of known scopes', () => {
  assert.throws(() => skillFile(makeRoot(), 'team'), /Unknown scope 'team'/);
  assert.throws(() => skillFile(makeRoot(), 'team'), new RegExp(Object.keys(SCOPES).join('|')));
});

// ---------------------------------------------------------------- uninstall

test('uninstall removes our skill and leaves the scope clean', () => {
  const root = makeRoot();
  try {
    installSkill(root);
    const r = uninstallSkill(root);
    assert.equal(r.status, 'removed');
    assert.ok(!fs.existsSync(skillFile(root)));
    // The empty skills/cgraph directory we created should not linger.
    assert.ok(!fs.existsSync(path.dirname(skillFile(root))));
  } finally { cleanup(root); }
});

test('uninstall refuses to delete a hand-written file at the skill path', () => {
  const root = makeRoot();
  try {
    const file = skillFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# my own notes\n\nnothing to do with cgraph\n');
    const r = uninstallSkill(root);
    assert.equal(r.status, 'foreign');
    assert.equal(read(root, '.claude/skills/cgraph/SKILL.md'), '# my own notes\n\nnothing to do with cgraph\n');
  } finally { cleanup(root); }
});

test('uninstall of an absent skill is a no-op', () => {
  const root = makeRoot();
  try {
    assert.equal(uninstallSkill(root).status, 'absent');
  } finally { cleanup(root); }
});

// ---------------------------------------------------------------- status

test('status reports absent, current, stale, and foreign correctly', () => {
  const root = makeRoot();
  try {
    const absent = skillStatus(root);
    assert.equal(absent.find((r) => r.scope === 'project').status, 'absent');

    installSkill(root);
    assert.equal(skillStatus(root).find((r) => r.scope === 'project').status, 'current');

    fs.writeFileSync(skillFile(root), '---\nname: cgraph\ndescription: drifted\n---\n\nold\n');
    assert.equal(skillStatus(root).find((r) => r.scope === 'project').status, 'stale');

    fs.writeFileSync(skillFile(root), '# not ours\n');
    assert.equal(skillStatus(root).find((r) => r.scope === 'project').status, 'foreign');
  } finally { cleanup(root); }
});
