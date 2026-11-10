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

## What it costs to ask

cgraph does not publish a token-savings multiplier. Any such number depends
entirely on what the alternative is assumed to be — how many files a particular
agent would have opened, with how much context — and that assumption does more
work than the measurement. Numbers built that way flatter the tool rather than
inform you.

What can be stated plainly is the size of the answers, measured on this
repository:

| Question | Response |
|---|---:|
| Outline of a 123-line file | ~110 tokens (the file itself is ~1.4k) |
| Locate a symbol by name | ~30 tokens |
| Read one function | ~50-200 tokens |
| Everything affected by changing a symbol | ~100-3k tokens, depending on reach |

Every response reports its own token count, and `--budget` caps it. Whether that
beats your current workflow is a question about your workflow — measure it on
your own repository rather than trusting a headline from mine.

## Install

```bash
npm install -g cgraph
cd your-project
cgraph init
```

`init` indexes the project, writes `.cgraph/`, adds it to `.gitignore`,
registers the MCP server with whatever agents it detects, and writes an
instruction block telling them to use it instead of grep. See
[Connecting your agent](#connecting-your-agent).

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

### Upgrading to 0.7

```bash
npm install -g cgraph@latest
cd your-project
cgraph init        # repairs an MCP entry that could not start; refreshes instructions
```

Three things changed that you may notice:

- **Project packs and embeddings need `cgraph trust`.** If this project has
  packs in `.cgraph/packs/` or `node_modules/cgraph-pack-*`, or enables
  embeddings in `.cgraph/config.json`, run `cgraph trust` once. Until then they
  are skipped, with a message saying so. See [Security](#security).
- **`enableAllProjectMcpServers` is no longer written** to
  `.claude/settings.json`. If an earlier `init` put `true` there and you did
  not want every server in `.mcp.json` auto-approved, delete that line.
- **Git hooks** installed by an earlier version should be rewritten:
  `cgraph hooks uninstall && cgraph hooks install`.

The full list is in the [CHANGELOG](CHANGELOG.md).

## Commands

```
cgraph map [path]        Outline a repo, directory, or file   (replaces ls, glob)
cgraph find <query>      Ranked search: name, description, "text" (replaces grep)
cgraph read <symbol>     Exactly one symbol or line range     (replaces read)
cgraph graph <symbol>    Callers, callees, impact, paths      (no shell equivalent)

cgraph index [--force]   Build or rebuild the index
cgraph update            Re-index only what changed
cgraph watch             Keep the index fresh automatically
cgraph doctor            Resolution quality and coverage gaps
cgraph stats             Index size and what queries have cost
cgraph packs             Inspect or scaffold language packs
cgraph trust             Allow this project's own packs and embeddings to run
cgraph skill install     Add cgraph as a discoverable Agent Skill
```

### Example

```console
$ cgraph map src/core/tokens.js
src/core/tokens.js  L137 ~1.7k
  15 k const CHARS_PER_TOKEN = 3.6
  25 f function estimate(text)
  75 f function fitToBudget(lines, budget)
 118 C class UsageLedger
 119 m   constructor(store)
 129 m   record(tool, returned, source = 0)

~189 tokens  ·  file ~1.7k
```

Both numbers are measured. The difference is left for you to interpret: whether
you would otherwise have read the whole file is a fact about your workflow, not
something cgraph can observe.

An outline shows structure, so object literals written inside a function —
`mkdir(dir, { recursive: true })`, a returned `{ status: 'ok' }` — are left out
and counted in a footer instead:

```
  (+9 object-literal fields inside functions; kinds ["field"] lists them)
```

`cgraph map <file> --kind field` (or `kinds: ["field"]` over MCP) lists them.
Members of classes and of module-level objects are always shown.

```console
$ cgraph graph estimate --dir impact
impact of changing src/core/tokens.js::estimate: 12 symbols

direct:
  src/core/retrieve.js::readSymbol       src/core/retrieve.js:186
  src/core/extract.js::extract           src/core/extract.js:54
2 hops:
  src/packs/registry.js::parseBatch      src/packs/registry.js:128
```

## Connecting your agent

```bash
cgraph init                          # detect what this project uses
cgraph init --agent claude           # or name them
cgraph init --agent copilot,opencode
cgraph init --agent all
```

Two things happen per agent: the MCP server is registered, and an instruction
block is written telling the agent to prefer these tools over grep. **Both
matter.** An agent with the tools available but no guidance keeps reaching for
grep, because that is what its training says to do.

| Agent | MCP config | Key | Instructions |
|---|---|---|---|
| Claude Code | `.mcp.json` | `mcpServers` | `CLAUDE.md` |
| GitHub Copilot | `.vscode/mcp.json` | `servers` | `.github/copilot-instructions.md` |
| opencode | `opencode.json` | `mcp` | `AGENTS.md` |
| Cursor | `.cursor/mcp.json` | `mcpServers` | `AGENTS.md` |
| Windsurf | `.windsurf/mcp.json` | `mcpServers` | `AGENTS.md` |

These formats genuinely differ, and getting one wrong fails silently — VS Code
uses `servers` rather than `mcpServers`, and opencode takes a single `command`
array instead of `command` + `args`. `init` writes the right shape for each.

**Without `--agent`**, only agents the project shows evidence of are wired up,
plus Claude Code (`.mcp.json` is the portable default several tools read).
Directories are never created for agents you don't use. **With `--agent`**,
naming an agent is the evidence — it gets set up regardless.

Restart your agent afterwards to pick up the server.

### What gets written

| File | What | Notes |
|---|---|---|
| `.cgraph/` | index and config | added to `.gitignore` |
| MCP config (table above) | one server entry named `cgraph` | launch command chosen to actually start — see below |
| Instruction file (table above) | a short block between `<!-- cgraph:start -->` markers | your own content is preserved |
| `.claude/settings.json` | approves the `cgraph` server and its `map` / `find` tools | Claude Code only; nothing else is approved |
| `.claude/skills/cgraph/SKILL.md` | the Agent Skill | see below |

A customised MCP entry is never overwritten, files that aren't valid JSON are
left untouched, and re-running updates the instruction block in place rather
than appending a second copy.

**The launch command.** An agent starts the server itself, without a shell and
with its own PATH. So `init` writes a bare `cgraph` only when that will
resolve there; on Windows it goes through `cmd /c`, because the global command
is a `.cmd` shim. When `cgraph` is not on PATH at all — you ran it from a
checkout or through `npx` — it writes `node` plus the absolute path of the
script. Re-running `init` repairs an entry written by a version before 0.7
that could not start.

**The Claude Code approval** exists because a subagent has nobody to click
"allow": without it the tool call is denied and the agent quietly falls back to
grep. It names `cgraph` specifically. It does not set
`enableAllProjectMcpServers`, which in a checked-in file would approve any
server a later commit adds to `.mcp.json`.

```bash
cgraph init --no-instructions   # register MCP only
cgraph init --no-mcp            # index only, touch no agent files
cgraph init --no-skill          # skip the Agent Skill below
```

### As an Agent Skill

`init` also writes a `SKILL.md` into `.claude/skills/cgraph/`. A Skill is the
lightest integration there is: the harness discovers it on its own, with **no
MCP config, no restart, and no permission prompt** — and it teaches the agent to
drive the `cgraph` CLI, so it works even when no MCP server is connected.

Skills use progressive disclosure, the same token discipline as the MCP tool
schemas: a one-line description sits in context every turn, and the full
guidance loads only when a task matches it.

```bash
cgraph skill install             # add SKILL.md to this project
cgraph skill install --global    # add it to your machine, not the repo
cgraph skill status              # where the skill is installed
cgraph skill uninstall           # remove it
```

This is additive to MCP, not a replacement: MCP tools are richer, the Skill is
the path with nothing to connect.

### Manual setup

If your agent isn't listed, register it as a stdio MCP server:

```json
{ "command": "cgraph", "args": ["serve", "--root", "/absolute/path/to/repo"] }
```

That assumes `cgraph` is on the PATH your agent runs with. If it is not — it
was never installed globally, or this is Windows, where the global command is
a `.cmd` shim an agent cannot spawn directly — the server fails to start and
the agent reports only "connection closed". Launch it by absolute path instead,
which is what `cgraph init` writes for you in that situation:

```json
{ "command": "node", "args": ["/path/to/cgraph/bin/cgraph.js", "serve", "--root", "/absolute/path/to/repo"] }
```

`--root` is not optional in practice: agents launch MCP servers with an
unpredictable working directory, and without it the server resolves whichever
index happens to be nearest.

### Troubleshooting the connection

| Symptom | Cause | Fix |
|---|---|---|
| Agent reports **"connection closed"** or "failed to connect" | The command in the MCP config cannot be started: `cgraph` is not on the agent's PATH, or on Windows it is a `.cmd` shim | Run `cgraph init` again (0.7+ repairs the entry), or use the absolute-path form above. Then restart the agent |
| `cannot start: ...` on stderr | No index at `--root` | `cgraph init` in that directory |
| Connects, but the agent never calls the tools | The instruction block is missing | Check `CLAUDE.md` / `AGENTS.md` for the `cgraph:start` block; re-run `cgraph init` |
| Tools are denied in a subagent | Not pre-approved | Check `.claude/settings.json` lists `cgraph` under `enabledMcpjsonServers` |
| A project pack does nothing, or `similar` is missing | The project is not trusted | `cgraph trust` — see [Security](#security) |

To test the server by hand, run exactly what the config says:

```bash
cgraph serve --root .    # prints "serving <path> (N symbols)" to stderr, then waits
cgraph stats             # index size and freshness
cgraph doctor            # resolution quality and coverage gaps
```

## Keeping the index fresh

**By default you don't have to do anything.** The MCP server checks for changes
before it answers, so an agent never reads a graph that disagrees with the
working tree — after an editor save, a `git checkout`, a rebase, or another
agent's edit.

That check is a `stat` of each file, not a read: **~170ms on a 3,000-file repo**,
and only files whose size or mtime moved are read and re-parsed. Repeated tool
calls share one scan (3s throttle by default), so a burst of queries costs one.

```jsonc
// .cgraph/config.json
{ "autoRefresh": { "enabled": true, "throttleMs": 3000 } }
```

Query-time refresh is the default because freshness is only needed at the moment
of use, and a query *is* that moment. No daemon to start, nothing to remember.

### When you want more

| | Command | What it adds |
|---|---|---|
| **Nothing** | — | Already correct. Start here. |
| Instant | `cgraph watch` | Re-indexes on save, so queries never pay the scan. Costs a long-running process. |
| Pre-warm | `cgraph hooks install` | Re-indexes after checkout, merge and rebase — the operations that change hundreds of files at once. |
| Manual | `cgraph update` | Scripts and CI. |

`cgraph hooks install` appends to `.git/hooks/post-checkout`, `post-merge` and
`post-rewrite`, between marker comments, **never replacing an existing hook**.
The hook is backgrounded and silent, so it cannot delay or fail a git command.
`cgraph hooks uninstall` removes only our block.

`post-commit` is deliberately excluded (`--all` adds it): committing doesn't
change the working tree, so the index is already correct and the latency buys
nothing.

None of these are required. They move *when* the cost is paid, not whether the
answer is right.

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

Seven languages extract symbols and resolve cross-file edges: **TypeScript,
JavaScript, Python, Go, Rust, Java, C#**.

Packs load from what the project actually is. `cgraph` reads your manifests —
`*.csproj`, `package.json`, `pom.xml`, `pyproject.toml`, `go.mod`, `Cargo.toml` —
before parsing anything, so a .NET repository never loads the Python pack or
fetches its grammar. A file in an unexpected language still gets its pack loaded
on sight: discovery decides what loads *eagerly*, never what gets ignored.

`init` reports what it found:

```console
$ cgraph init
  detected  dotnet, node  ·  aspnet, entity-framework, angular
  indexed   412 files, 8,203 symbols, 19,447 edges
```

Frameworks are detected from every manifest in the tree, not just the root one —
in a monorepo the root `package.json` holds tooling while Angular or React lives
in `web/package.json`.

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

A pack is code, and loading one runs it. The two locations inside a project
are ignored until you run `cgraph trust` there — after scaffolding a pack, that
is the next step. See [Security](#security).

Upstream tree-sitter grammars ship a `queries/tags.scm` using the same capture
vocabulary, so they can usually be vendored with minimal edits.

## MCP tools

Two tools, not thirty. Every tool schema sits in the agent's context on
**every turn**, so the tool list is itself a permanent token cost — a 30-tool
server spends 3-4k tokens forever to save tokens on retrieval.

| Tool | Replaces |
|---|---|
| `map` | `ls`, `glob`, exploratory reads, **and** callers/callees/impact/path (nothing, previously) — pass `path` for an outline or `symbol` for relationships, never both |
| `find` | `grep` — by name ("login" finds `handleLogin`), by description ("retry failed upload" searches docs and function bodies), or by quoted literal text, reported under the symbol each line is in |

`read` and `status` are deliberately not MCP tools: every harness already has
an exact, line-based file reader, and freshness is handled automatically (a
throttled re-index runs before every call) rather than through a manual check.
Both remain available from the shell — `cgraph read`, `cgraph stats`. Dependency
API documentation is likewise out of scope — pair cgraph with a docs-focused MCP
server such as [Context7](https://github.com/upstash/context7) for that.

`similar` (semantic search) is registered only when embeddings are configured
and the project is trusted, so its schema costs nothing otherwise.

### What is done to keep token cost down

| Where the tokens go | What cgraph does |
|---|---|
| Tool schemas, every turn | Two tools, and a test that fails if their schemas grow past a budget |
| Server instructions, every session | Three sentences. Clients that defer tool schemas keep these in context instead and use them to decide when to load the tools |
| The instruction block in `CLAUDE.md` / `AGENTS.md`, every session | About 350 tokens, also under a test budget |
| Each answer | Compact text, not JSON. Locations and signatures, not bodies. Outlines omit object literals inside functions |
| Oversized answers | Stopped at 10,000 tokens, see below |
| Permission prompts and serial calls | Every tool is marked read-only, so a client can run calls in parallel and without asking |
| Repeated context | Output order is deterministic, so identical questions give byte-identical answers |

**Response size.** Answers are not shortened for brevity: an agent that gets a
partial answer without asking for one treats it as complete and stops looking.
There is one limit. With no `budget`, a response stops at **10,000 tokens** —
ordinary answers are a few hundred — because past that the *client* cuts or
drops the result, after the tokens are spent and without saying what was lost.
When cgraph stops, it says so and counts what it left out:

```
  ... 1840 more symbols (raise --budget to see them)
```

Pass `budget` to choose your own limit, higher or lower. To change the default:

```jsonc
// .cgraph/config.json
{ "maxResponseTokens": 10000 }   // 0 turns it off
```

## Security

cgraph is started by an agent, on whatever repository the agent was pointed at,
with your credentials in its environment. The repository is therefore treated
as untrusted input. Indexing only reads files — with two exceptions a project
can carry, and both are off until you allow them:

| In the project | What it can do | Until trusted |
|---|---|---|
| `.cgraph/packs/*`, `node_modules/cgraph-pack-*` | JavaScript, executed when the pack loads | not loaded; named in a warning |
| `embeddings` in `.cgraph/config.json` | chooses the URL code is sent to, and the environment variable sent as its key | refused; `similar` is not offered |

```bash
cgraph trust status     # is this project trusted, and what would that enable
cgraph trust            # allow it
cgraph trust revoke     # stop
```

```console
$ cgraph trust status
  not trusted  /home/me/some-clone

    runs code   .cgraph/packs/kotlin
    sends code  to http://localhost:11434/v1 (local)
    sends key   from $CGRAPH_EMBEDDING_API_KEY
```

The decision is stored in `~/.cgraph/trusted.json`, outside the project, so a
repository cannot grant it to itself — there is no config-file key for it.
Builtin packs and packs in `~/.cgraph/packs/` are yours and always load. In CI
or a container, where the checkout is all there is, set `CGRAPH_TRUST=1`.

Also by design:

- **Grammars** are WebAssembly fetched from a CDN, and are verified against a
  pinned SHA-256 before they are loaded.
- **No shell.** Nothing in cgraph passes repository content to a shell. The
  optional git hook quotes the project path.
- **Paths from the index** cannot resolve outside the project root.
- **API keys** are read from the environment and never written to config.
- **Symlinks** are not followed during indexing.

Tool output contains text from the repository — symbol names, signatures, and
doc comments with `detail: "full"`. Like any file an agent reads, treat it as
data. Report vulnerabilities privately through the repository's
[Security tab](https://github.com/Ramachandrajoshi/Code-Graph/security) rather than a public issue.

## Optional extras

Both are opt-in and off by default.

**Embeddings** — for "find the code that does X" when the words you would use
appear nowhere in the code. `find` already searches doc comments and the words
used inside function bodies, which answers most such questions with no model
and nothing leaving the machine; try it first. Because these settings decide
where code is sent, they take effect only after `cgraph trust`
([Security](#security)).

Point it at a **local, OpenAI-compatible endpoint** — Ollama, LM Studio,
llama.cpp's server, vLLM, text-embeddings-inference — and nothing leaves your
machine and nothing costs money:

```jsonc
// .cgraph/config.json
{
  "embeddings": {
    "enabled": true,
    "provider": "local",
    "baseUrl": "http://localhost:11434/v1",   // Ollama; LM Studio is :1234/v1
    "model": "nomic-embed-text",
    "dimensions": 768                          // optional
  }
}
```

`baseUrl` accepts the forms these servers document themselves with — with or
without `/v1`, with or without the full path. `model` is required, because a
local server exposes whatever it was started with and there is nothing to guess.

`dimensions` is optional and worth setting: cgraph verifies the server actually
returns that width on the first batch. A silent mismatch corrupts every
similarity score, and the symptom — subtly wrong rankings — is close to
untraceable.

No API key is required for a local server. If yours needs one, set
`CGRAPH_EMBEDDING_API_KEY` (or name your own variable via `apiKeyEnv`).

Hosted providers work too, and cost money per index:

```json
{ "embeddings": { "enabled": true, "provider": "voyage", "apiKeyEnv": "VOYAGE_API_KEY" } }
```

Keys are always read from the environment and never written to config.

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
- **Full-text search is optional.** SQLite's FTS5 is a compile-time option and
  Node's bundled build often omits it (22.14 and 23.11 both do), so it is
  detected at runtime rather than required. Without it, name, signature and doc
  search still work through substring matching — you lose relevance ranking, not
  the capability. `cgraph doctor` tells you which mode you're in, and a Node
  build that has FTS5 is picked up automatically with no re-index.

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
npm test          # 531 tests
npm run bench     # response sizes (regression guard)
```

## License

[Apache License 2.0](LICENSE) © 2026 Ramachandra Joshi
