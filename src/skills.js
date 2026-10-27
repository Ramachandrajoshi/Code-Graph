/**
 * Agent Skill packaging.
 *
 * An Agent Skill is the lowest-friction way to wire cgraph into a harness. MCP
 * registration needs a config entry in each tool's own shape, an agent restart,
 * and (for Claude Code) a permission pre-approval — a subagent with nobody to
 * click "allow" silently loses the tools and falls back to grep. A Skill needs
 * none of that: it is one file, `SKILL.md`, that the harness discovers on its
 * own and reads only when the task matches. No restart, no permission prompt,
 * no per-tool config shape to get wrong.
 *
 * Progressive disclosure is the point, and it is the same discipline as the
 * MCP tool schemas: the `description` frontmatter sits in context on every
 * turn, so it is rationed to one sentence naming the decision (when to reach
 * for cgraph instead of grep). The body — the full guidance — is loaded only
 * when the skill triggers. A skill that front-loads a wall of instructions
 * spends tokens on every conversation to save them on a few, which is the same
 * mistake a 30-tool MCP server makes.
 *
 * The body teaches the shell CLI, not just the MCP tools, because the shell
 * path has no connection to fail: an agent that can run `cgraph map` is never
 * blocked by an MCP server that did not start. MCP is mentioned as the
 * preferred route when present, with an explicit fallback — degrade, don't
 * stall.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The skill directory name. Harnesses key discovery off the directory, and the
 * `name` frontmatter must match it, so this single constant defines both.
 */
export const SKILL_NAME = 'cgraph';

/**
 * Where a skill lives.
 *
 * `project` is committed alongside the repo and travels with it — anyone who
 * clones gets the same guidance. `global` is the developer's own machine, for
 * a project that is not theirs to commit into. The paths follow the Agent
 * Skills convention harnesses scan: `.claude/skills/<name>/SKILL.md` and
 * `~/.claude/skills/<name>/SKILL.md`.
 */
export const SCOPES = {
  project: { label: 'project', dir: (root) => path.join(root, '.claude', 'skills', SKILL_NAME) },
  global: { label: 'global', dir: () => path.join(os.homedir(), '.claude', 'skills', SKILL_NAME) },
};

export function skillFile(root, scope = 'project') {
  const spec = SCOPES[scope];
  if (!spec) throw new Error(`Unknown scope '${scope}'. Use: ${Object.keys(SCOPES).join(', ')}`);
  return path.join(spec.dir(root), 'SKILL.md');
}

/**
 * The SKILL.md content.
 *
 * The whole file is cgraph's to own — it lives in a directory named for us,
 * unlike an instruction block spliced into a shared CLAUDE.md. That is why this
 * is a full write rather than a marker-splice: re-running refreshes it cleanly
 * and there is no user content in this file to preserve.
 *
 * `description` is the only frontmatter that costs tokens every turn. It names
 * the trigger and the payoff, not the mechanics. `allowed-tools` pre-approves
 * the shell verbs in Claude Code so a subagent is not blocked mid-task.
 */
export function skillContent() {
  return `---
name: ${SKILL_NAME}
description: Structural questions about this codebase — where a symbol is defined, what calls or imports it, everything a change breaks, or what a file contains. Returns exact locations in a fraction of the tokens of grep, glob and whole-file reads. Reach for this before grep, ls, glob, or opening files.
allowed-tools: Bash(cgraph:*)
---

# cgraph — code navigation

A pre-built graph of this repository is indexed in \`.cgraph/\`. Query it for
structure instead of scanning text. \`map\` and \`find\` answer where to look;
they return exact locations, not files to read.

Prefer the MCP tools \`map\` and \`find\` if they are available; if not, run the
same command from the shell (below). Never stall on a missing MCP server — the
CLI works on its own.

## map — outline, or trace relationships

Pass \`path\` for an outline, \`symbol\` for relationships. Never both.

\`\`\`bash
cgraph map                      # outline the whole repo
cgraph map src/core/store.js    # a file's symbols with line numbers
cgraph map src/packs --depth 2  # a directory tree
cgraph graph estimate --dir impact    # blast radius of changing \`estimate\`
cgraph graph handleLogin --dir callers  # who calls it
cgraph graph a --dir path --to b        # call path between two symbols
\`\`\`

- Call \`map\` on a file before opening it: the outline is a fraction of the
  file's size and shows which symbol is worth reading.
- Before changing anything shared, run \`map <symbol>\` with \`--dir impact\` to
  see what depends on it.

## find — ranked symbol search (replaces grep)

\`\`\`bash
cgraph find login        # matches camelCase parts: finds \`handleLogin\`
cgraph find Store --kind class
cgraph find "parse query" --path src/core
\`\`\`

Returns definitions with exact locations, ranked by importance — not line hits.

## Rules

- Edges marked \`!\` are **inferred** from a name match, not proven through an
  import. Verify before relying on them.
- The index refreshes itself before every call. If it still looks stale, run
  \`cgraph update\`.
- Use your own file reader for full-file or line-range reads: \`map\`/\`find\`
  index definitions, calls, and imports — not plain text. Fall back to grep for
  string literals and comments.
- \`--budget <n>\` caps a response's tokens when you need a bound; uncapped by
  default.
`;
}

/**
 * Install the skill for one scope.
 *
 * Idempotent: a byte-for-byte match is reported as `current` and not rewritten,
 * so a repo whose skill is up to date shows no churn. The file is cgraph's own,
 * so a differing file is refreshed (not skipped) — the whole point of
 * re-running is to pick up an updated skill.
 */
export function installSkill(root, { scope = 'project' } = {}) {
  const file = skillFile(root, scope);
  const rel = relativeForDisplay(file, root);
  const content = skillContent();

  let status;
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, 'utf8') === content) {
      status = 'current';
    } else {
      fs.writeFileSync(file, content);
      status = 'updated';
    }
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    status = 'created';
  }

  return { file: rel, scope, status };
}

/**
 * Remove the skill.
 *
 * Only touches a file that is recognisably ours — the `name: cgraph`
 * frontmatter. A file the developer wrote by hand at the same path is left for
 * them to delete, the same way an unparseable config is left alone elsewhere.
 */
export function uninstallSkill(root, { scope = 'project' } = {}) {
  const file = skillFile(root, scope);
  const rel = relativeForDisplay(file, root);

  if (!fs.existsSync(file)) return { file: rel, scope, status: 'absent' };

  const text = fs.readFileSync(file, 'utf8');
  if (!/^name:\s*cgraph\s*$/m.test(text)) {
    return { file: rel, scope, status: 'foreign' };
  }

  fs.rmSync(file);
  // The skill directory was created by us; remove it if nothing is left, so a
  // bare empty `skills/cgraph/` does not linger.
  const dir = path.dirname(file);
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* not ours to manage */ }

  return { file: rel, scope, status: 'removed' };
}

/**
 * Report installed skills across scopes.
 */
export function skillStatus(root) {
  return Object.keys(SCOPES).map((scope) => {
    const file = skillFile(root, scope);
    const rel = relativeForDisplay(file, root);
    if (!fs.existsSync(file)) return { file: rel, scope, status: 'absent' };

    const text = fs.readFileSync(file, 'utf8');
    if (!/^name:\s*cgraph\s*$/m.test(text)) return { file: rel, scope, status: 'foreign' };
    return { file: rel, scope, status: text === skillContent() ? 'current' : 'stale' };
  });
}

function relativeForDisplay(abs, root) {
  const rel = path.relative(root, abs);
  // A global skill lives outside the project; show it from the home directory.
  if (rel.startsWith('..')) {
    const home = path.relative(os.homedir(), abs);
    return home.startsWith('..') ? abs : `~/${home}`.replace(/\\/g, '/');
  }
  return rel.replace(/\\/g, '/');
}
