# Contributing to code-graph

Thanks for considering a contribution. The most valuable thing you can add is
**support for a language that doesn't have it yet** — that path is documented
first and deliberately made easy.

## Getting started

```bash
git clone https://github.com/Ramachandrajoshi/Code-Graph.git
cd Code-Graph
npm install
npm test          # 231 tests, ~30s
npm run bench     # token savings vs grep+read
```

Requires **Node >= 22.13** — the first release where `node:sqlite` is available
unflagged. There is no build step and no native compilation.

To try your changes against a real repo:

```bash
node bin/cgraph.js index --root /path/to/some/repo
node bin/cgraph.js doctor --root /path/to/some/repo
```

---

## Adding a language

This is the highest-value contribution and needs no changes to core.

### 1. Scaffold

```bash
cd /some/project/using/that/language
node /path/to/code-graph/bin/cgraph.js packs scaffold kotlin
```

That writes `.codegraph/packs/kotlin/` with a working `index.js` and commented
query stubs. Packs there are discovered at the highest precedence, so you can
iterate without installing anything.

### 2. Write the tags query

`queries/tags.scm` maps grammar nodes to graph nodes:

```scheme
(function_declaration name: (simple_identifier) @name) @definition.function
(class_declaration    name: (type_identifier)     @name) @definition.class
(call_expression      (simple_identifier)         @name) @reference.call
```

The vocabulary is `@definition.<kind>`, `@reference.<kind>`, `@name`, and
`@receiver`. It matches the convention upstream tree-sitter grammars use in their
own `queries/tags.scm`, so **you can usually vendor theirs and adjust**.

Two rules that will cost you an afternoon if you miss them:

- **Attach `@definition` to the declaration, never to the enclosing `(program)`
  or `(module)` node.** A capture on the file root gives the symbol the byte
  range of the *entire file*, which silently makes every later definition its
  child. The outline still looks plausible; the hierarchy is wrong.
- **A node name the grammar doesn't have fails the whole query to compile**, not
  just that pattern. One typo disables the language entirely. The error names the
  pack and grammar, so read it.

Iterate with:

```bash
node bin/cgraph.js index --force && node bin/cgraph.js map some/file.kt
```

### 3. Add hooks, in order of value

Everything below is optional; core falls back to generic behaviour.

| Hook | What it buys |
|---|---|
| `resolveImport(spec, fromPath, ctx)` | **Biggest win.** Turns `INFERRED` edges into `EXACT` ones. |
| `builtins: { globals, methods }` | Keeps runtime calls (`list.append`, `Math.max`) out of the unresolved list — otherwise they swamp the quality metric. |
| `signature(def, source)` | Exact declarations instead of the first physical line, which truncates wrapped parameter lists. |
| `docComment(def, source)` | Documentation attached to symbols, and searchable. |
| `isExported` / `visibility` | Lets resolution prefer public symbols when names collide. |
| `lsp: { command, args }` | On-demand precision upgrades via a language server. |

Unit-test a hook without standing up an index:

```js
import { makeTestContext } from 'code-graph/sdk';

const ctx = makeTestContext({ root: '/repo', files: ['src/db.kt'] });
assert.deepEqual(pack.resolveImport('./db', 'src/main.kt', ctx), { file: 'src/db.kt' });
```

### 4. Measure it

```bash
node bin/cgraph.js doctor
```

Resolution quality is a tracked number, not a vibe. Aim for **>85% proven** on a
real repository in that language. If you're well below, the usual cause is
`resolveImport` returning `null` too often — check `imports resolved` in the same
report.

### 5. Ship it with fixtures

Move the pack into `src/packs/<lang>/`, add it to `BUILTIN` in
`src/packs/registry.js`, and add tests to `test/packs.test.js` following the
existing Go/Rust/Java ones. **A pack without fixtures will not be merged** —
that's the only thing keeping 36 languages from silently rotting.

You can also publish independently as `code-graph-pack-<lang>` on npm; anything
matching that name in a project's `node_modules` is discovered automatically.

---

## Architecture

```
src/
  core/       language-agnostic engine
    walker      gitignore-aware traversal
    parse       tree-sitter host (the only file importing web-tree-sitter)
    extract     captures -> hierarchy, refs, imports
    resolve     import tables -> edges, with confidence labels
    rank        PageRank over the call graph
    store       SQLite via node:sqlite
    retrieve    token-budgeted rendering
  packs/      language packs (all language-specific knowledge lives here)
  mcp/        MCP server (6 tools, stdio JSON-RPC)
  deps/       dependency documentation
  sdk/        public API for pack authors
```

**The layering rule:** `core/` contains zero language-specific knowledge. Every
`if (lang === 'python')` in core is a bug — it belongs in a pack. This is what
makes the plugin system real rather than decorative, and it's the one review
comment you're most likely to get.

---

## Principles

These are load-bearing. Changes that violate them will be asked to change.

**Never guess silently.** Every edge carries `EXACT` or `INFERRED`. Unresolvable
references go in the `unresolved` table, not `/dev/null`. An agent acting on a
confidently-wrong edge wastes far more than one told "this is a guess".

**Truncate loudly.** A silently shortened answer reads as complete and the agent
stops looking. Every truncation says what was dropped.

**Tokens are the product.** Output is compact text, not JSON — braces and
repeated keys are ~35% of a JSON payload and carry no information. Before adding
a field to any response, ask what an agent does differently because of it.

**The tool list is a permanent tax.** MCP schemas sit in the agent's context on
*every turn*. Adding a tool is a real cost; `test/mcp.test.js` enforces a budget.

**Degrade, don't crash.** One malformed file, one broken third-party pack, or one
unreachable registry must never abort an index.

---

## Testing

```bash
npm test                              # everything
node --test test/resolve.test.js      # one file
```

Tests run the real pipeline against real grammars on real temp repositories.
Mocking a layer hides exactly the class of bug these tests exist to catch — most
real defects here live in the `.scm` files, not the JavaScript.

Use `test/fixture.js` to build a repo and index it:

```js
const fx = await buildFixture({
  'package.json': '{"name":"t"}',
  'src/db.js': 'export function query() {}\n',
  'src/app.js': "import { query } from './db';\nexport function run() { query(); }\n",
});
try {
  assert.equal(fx.edge('run', 'query').confidence, 'EXACT');
} finally { fx.cleanup(); }
```

**Write the test that would have caught the bug**, and say in a comment why it
matters. A test named `it works` teaches nobody why the code is shaped that way.

Tests must not touch `~/.code-graph` — `buildFixture` redirects the cache
automatically.

---

## Pull requests

- Branch from `main`, one logical change per PR.
- Include tests. Bug fixes should include the test that fails without the fix.
- Run `npm test` and `npm run bench` before opening.
- If you change output format, paste before/after in the description — output is
  the product surface here.
- CI runs on Windows, macOS, and Linux across Node 22.13/22/24. Windows failures
  are usually path separators; the rule is that everything entering the index is
  POSIX-style and repo-relative, converted only at the walker boundary.

### Commit messages

Plain imperative subject lines. Explain *why* in the body when it isn't obvious:

```
Snap read() to line start so numbers match content

A definition node begins at `function`, not at `export`, so slicing from the
node offset printed content that didn't match the line number beside it. An
agent editing by line number acts on that mismatch.
```

---

## Reporting bugs

Include:

1. `cgraph doctor --json` output
2. `node --version` and OS
3. The language and a minimal file that reproduces it

For wrong or missing edges, `cgraph doctor` shows the most common unresolved
names — a repeated name there usually means a missing builtin entry or an import
form the pack's query doesn't cover.

---

## Releasing

Maintainers only — see [RELEASING.md](RELEASING.md). In short: `npm run release`
tags from `main`, and the tag triggers a workflow that tests, benchmarks,
smoke-tests the packed tarball, publishes to npm with provenance, and creates the
GitHub Release.

Contributors don't need to touch versions. Add your entry under `## [Unreleased]`
in `CHANGELOG.md`; the release process promotes it.

## License

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
