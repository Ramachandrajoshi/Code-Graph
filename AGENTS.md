# Working on cgraph

Guidance for AI agents contributing to this repository. Human contributors want
[CONTRIBUTING.md](CONTRIBUTING.md), which covers the same ground in more depth.

## What this project is

cgraph builds a queryable graph of a codebase and serves it over MCP, so agents
answer structural questions for a fraction of the tokens that grep and
whole-file reads cost. Every design decision is subordinate to that.

## Principles that are load-bearing

Changes violating these will be asked to change.

- **Never guess silently.** Every edge carries `EXACT` or `INFERRED`.
  Unresolvable references go in the `unresolved` table, not `/dev/null`.
- **Truncate loudly.** A silently shortened answer reads as complete, and the
  agent stops looking.
- **Tokens are the product.** Output is compact text, not JSON. Before adding a
  field to a response, ask what an agent does differently because of it.
- **The MCP tool list is a permanent tax.** Schemas sit in context on every
  turn; `test/mcp.test.js` enforces a budget.
- **Degrade, don't crash.** One malformed file, one broken third-party pack, or
  one unreachable registry must never abort an index.
- **`core/` holds no language-specific knowledge.** Every `if (lang === 'x')` in
  core belongs in a pack instead. This is the most common review comment.

## Layout

```
src/core/    engine: walker, parse, extract, resolve, rank, store, retrieve
src/packs/   language packs — all language-specific knowledge lives here
src/mcp/     MCP server (2 tools, stdio JSON-RPC)
src/sdk/     public API for pack authors
```

## Testing

```bash
npm test                            # everything
node --test test/resolve.test.js    # one file
npm run bench                       # response sizes (regression guard)
```

Tests run the real pipeline against real grammars on real temp repositories.
Most defects here live in the `.scm` query files, not the JavaScript, so mocking
a layer hides exactly what the tests exist to catch.

Write the test that would have caught the bug, and say in a comment why it
matters.

## Two traps that have cost real time

- **Backticks in `src/core/schema.js`.** The SQL lives in a template literal; a
  backtick in a comment terminates it and the error points nowhere near the
  cause. `test/schema.test.js` guards this.
- **`@definition` captures on `(program)` or `(module)`.** That gives the symbol
  the byte range of the entire file, silently making every later definition its
  child. Attach captures to the declaration itself.

<!-- cgraph:start -->
## Code navigation: use cgraph, not grep

This repo has a cgraph index. Unless you already know the exact lines you need:

- `find <name>` instead of grep for a symbol: ranked definitions with exact
  locations. Matches camelCase parts ("login" finds "handleLogin").
- `map <path>` instead of ls/glob or opening a file: a symbol outline with
  line numbers, a fraction of the file's size. Then read only those lines.
- `map <symbol>` for callers, callees and call paths. Use `direction=impact`
  before changing anything shared.

`map` takes a `path` or a `symbol`, never both. Edges marked `!` are
**inferred** from a name match, not proven — verify them. Only definitions and
call/import edges are indexed: use grep for plain text and your own reader for
file contents. The index refreshes itself; `cgraph update` forces it. Without
the MCP tools, the shell has the same data: `cgraph map|find|graph|read`.
<!-- cgraph:end -->
