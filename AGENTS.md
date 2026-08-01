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

This repository has a cgraph index. Use it — not just shell search — whenever
you haven't already pinpointed the lines you need; it returns exact locations
instead of whole files. `map` takes either a `path` (outline) or a `symbol`
(relationships), never both.

| Instead of | Use | Returns |
|---|---|---|
| `ls`, `glob`, opening a file to see what's in it | `map` (path) | symbol outline with line numbers |
| grepping/searching for a symbol | `find` | ranked definitions; matches camelCase parts, so "login" finds "handleLogin" |
| — no shell equivalent — | `map` (symbol) | callers, callees, transitive impact, call paths |

Working rules:

- Call `map` on a file before opening it: an outline is a fraction of the
  file's size and tells you which symbol is worth reading in full.
- Before changing anything shared, call `map` on the symbol with
  `direction=impact` to see what depends on it.
- Edges marked `!` are **inferred** from a name match, not proven through an
  import. Verify before relying on them.
- The index refreshes itself before every call; if it still looks stale, run
  `cgraph update`.
- Use your own reader for whole-file or line-range reads; `find`/`map` only
  index definitions and call/import edges, not plain text — fall back to grep
  for that.

The same data is available from the shell, which also keeps `read` and
`graph` as separate commands: `cgraph map|find|graph|read`.
<!-- cgraph:end -->
