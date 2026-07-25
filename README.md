# cgraph

[![CI](https://github.com/Ramachandrajoshi/Code-Graph/actions/workflows/ci.yml/badge.svg)](https://github.com/Ramachandrajoshi/Code-Graph/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/cgraph.svg)](https://www.npmjs.com/package/cgraph)
[![node](https://img.shields.io/node/v/cgraph.svg)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Token-efficient code retrieval for AI agents.

AI coding agents explore repositories with `grep`, `glob`, `ls`, and whole-file
reads. To answer *"where is login handled and what breaks if I change it"*, an
agent greps, gets forty line hits, reads six files (~12k tokens), and still has
to guess at the cross-file relationships. The information it actually needed was
about 300 tokens.

`cgraph` builds a persistent, queryable graph of your codebase and serves it
over MCP, so the agent asks structural questions and gets exact, minimal answers.

## Measured savings

Benchmarked with `npm run bench`, which compares each answer against a fair
simulation of grep-then-read — because an agent cannot act on grep output alone,
it opens the files those hits point to.

| Question | cgraph | grep + read | saving |
|---|---:|---:|---:|
| What's in this repo? | 9.7k | 446k | **46x** |
| Where is `X` defined? | 725 | 436k | **601x** |
| Who calls `X`? | 1.9k | 563k | **300x** |
| What breaks if I change `X`? | 7.1k | 576k | **81x*** |
| What do we use from `<dep>`? | 36 | 39k | **1091x** |

*Median **81x**, aggregate **63x** on llama.cpp (3,245 files, 727k LOC).
Median **62x** on this repository.*

\* grep cannot actually answer this one; the baseline is a generous approximation.

## Install

```bash
npm install -g cgraph
cd your-project
cgraph init
```

`init` indexes the project, writes `.cgraph/`, adds it to `.gitignore`, and
registers the MCP server in whatever agent configs it finds (`.mcp.json`,
`.cursor/mcp.json`, `.vscode/mcp.json`, `.windsurf/mcp.json`).

Requires **Node >= 22.13**. No native compilation, no build step, no database to
run — the index is SQLite via Node's built-in `node:sqlite`.

**Install size: 6.3 MB.** The 36 tree-sitter grammars total 51 MB, so they are
not bundled — only the ones your repo actually uses are fetched, into a
machine-wide cache, verified against a pinned SHA-256. A TypeScript project pulls
about 2 MB; a JavaScript one, 636 KB.

For air-gapped or offline environments, pre-install all grammars instead:

```bash
npm install -g cgraph tree-sitter-wasms
```

## Commands

```
cgraph map [path]        Outline a repo, directory, or file   (replaces ls, glob)
cgraph find <query>      Ranked symbol search                 (replaces grep)
cgraph read <symbol>     Exactly one symbol or line range     (replaces read)
cgraph graph <symbol>    Callers, callees, impact, paths      (no shell equivalent)
cgraph docs [package]    Dependency API, ranked by your usage

cgraph index [--force]   Build or rebuild the index
cgraph update            Re-index only what changed
cgraph watch             Keep the index fresh automatically
cgraph doctor            Resolution quality and coverage gaps
cgraph stats             Cumulative token savings
cgraph packs             Inspect or scaffold language packs
```

### Example

```console
$ cgraph map src/core/tokens.js
src/core/tokens.js  L123 ~1.4k
  15 k const CHARS_PER_TOKEN = 3.6
  25 f function estimate(text)
  75 f function fitToBudget(lines, budget)
 105 C class SavingsLedger
 106 m   constructor(store)
 110 m   record(tool, returned, baseline)

~112 tokens  ·  1314 saved vs reading this file
```

```console
$ cgraph graph estimate --dir impact
impact of changing src/core/tokens.js::estimate: 12 symbols

direct:
  src/core/retrieve.js::readSymbol       src/core/retrieve.js:186
  src/core/extract.js::extract           src/core/extract.js:54
2 hops:
  src/packs/registry.js::parseBatch      src/packs/registry.js:128
```

## Honest by construction

Every edge carries a confidence, and it is visible in the output:

- **EXACT** — proven, traced through the import table or lexical scope
- **INFERRED** — a name matched and nothing contradicted it (shown as `!`)

References that cannot be resolved are recorded rather than silently dropped, and
`cgraph doctor` reports the ratio per language. A wrong edge presented
confidently costs an agent far more than an honest "this is a guess".

```console
$ cgraph doctor
  resolution quality
  language      files   exact  inferred   unres  quality
  javascript       53    2200       555      55  78% proven

  imports resolved: 100% (0 of 306 unresolved)
```

Truncation is always announced. A silently shortened answer reads as complete,
and the agent stops looking.

## Languages

Six languages extract symbols and resolve cross-file edges: **TypeScript,
JavaScript, Python, Go, Rust, Java**.

Another 30 grammars are detected and listed by `map` but contribute no symbols
until someone writes queries for them — `cgraph doctor` says so explicitly rather
than leaving you to wonder why `find` is empty.

### Adding a language

```bash
cgraph packs scaffold kotlin
```

That writes a working pack into `.cgraph/packs/kotlin/`, which is discovered
at the highest precedence — no fork, no install step. Core contains zero
language-specific knowledge; everything arrives through pack hooks:

```js
export default {
  id: 'kotlin',
  languages: ['kotlin'],
  queries: { tags: '.../tags.scm', imports: '.../imports.scm' },

  // All optional; each buys precision over the generic fallback.
  signature(def, source)              {},
  docComment(def, source)             {},
  resolveImport(spec, fromPath, ctx)  {},   // biggest win: EXACT instead of INFERRED
  builtins: { globals, methods },           // keeps runtime calls out of "unresolved"
  lsp: { command: 'kotlin-language-server' },
};
```

Packs are discovered from, in increasing precedence: builtins,
`node_modules/cgraph-pack-*`, `~/.cgraph/packs/`, `.cgraph/packs/`.

Upstream tree-sitter grammars ship a `queries/tags.scm` using the same capture
vocabulary, so they can usually be vendored with minimal edits.

## MCP tools

Six tools, not thirty. Every tool schema sits in the agent's context on **every
turn**, so the tool list is itself a permanent token cost — a 30-tool server
spends 3-4k tokens forever to save tokens on retrieval. This set costs ~1.3k.

| Tool | Replaces |
|---|---|
| `map` | `ls`, `glob`, exploratory reads |
| `find` | `grep` |
| `read` | whole-file reads |
| `graph` | nothing — new capability |
| `docs` | reading `node_modules`, web search |
| `status` | — |

`similar` (semantic search) is registered only when embeddings are configured,
so its schema costs nothing otherwise.

## Optional extras

Both are opt-in and off by default.

**Embeddings** — for "find the code that does X" when you don't know what X is
called. Costs money per index and sends code to a third party, which cuts against
the point of the tool, so structural search is always tried first.

```json
{ "embeddings": { "enabled": true, "provider": "voyage", "apiKeyEnv": "VOYAGE_API_KEY" } }
```

The API key is read from the environment and never written to config.

**Language servers** — `cgraph graph <symbol> --upgrade` consults a language
server to prove edges tree-sitter could only guess at, then caches the result.
Never runs during indexing: warming a language server on a large repo would
destroy the fast-index property everything else depends on.

## Performance

On llama.cpp (3,245 files, 150 MB, 727k LOC):

| | |
|---|---:|
| Full index | 42s |
| No-op update | 0.7s |
| One file changed | ~1s |

Invalidation is content-hash based, so `touch` correctly changes nothing.

## Notes

- **Grammar/runtime pinning.** `web-tree-sitter` is pinned to `~0.25.10`; the
  0.26 line cannot load the grammars in `tree-sitter-wasms@0.1.13` and fails with
  an *empty* error message from inside the wasm loader. `test/grammars.test.js`
  loads every grammar as a gate on any future bump. `elm` and `ql` are known
  broken in that grammar release and are refused with a clear message.
- **Grammars are lazy.** All 36 total 51 MB; only the ones your repo needs are
  fetched, into a machine-wide cache, verified against a pinned SHA-256. This is
  why `tree-sitter-wasms` is an *optional peer* dependency rather than a normal
  one — npm installs `optionalDependencies` by default, which would have made
  every install 56 MB.
- **Dependency docs are local-first.** Read from `node_modules`/`site-packages`
  where the types match your installed version exactly; the registry is a
  fallback. The cache is keyed on content, so `npm link` and `patch-package`
  don't serve stale docs.

## Programmatic API

The CLI and MCP server are the primary interfaces. For embedding cgraph in
another tool:

```js
import { openProject } from 'cgraph';

const project = await openProject('/path/to/repo');
await project.index();

project.find('handleLogin');            // ranked search
project.read('handleLogin');            // one symbol's source
project.callers('findUser');            // who calls it
project.impact('findUser', { depth: 3 });   // what breaks if it changes
project.path('postLogin', 'findUser');  // shortest call route
project.dependencies();                 // deps ranked by usage

project.close();
```

Pack authors want the smaller, more stable `cgraph/sdk` surface instead —
see [CONTRIBUTING.md](CONTRIBUTING.md#adding-a-language).

## Contributing

Contributions are welcome, especially **new language packs** — that path needs no
changes to core and is documented step by step in
[CONTRIBUTING.md](CONTRIBUTING.md).

```bash
git clone https://github.com/Ramachandrajoshi/Code-Graph.git
cd Code-Graph
npm install
npm test          # 231 tests
npm run bench     # token savings vs grep+read
```

## License

[Apache License 2.0](LICENSE) © 2026 Ramachandra Joshi
