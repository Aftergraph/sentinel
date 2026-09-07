# Context graph — Sentinel by Aftergraph

Deterministic JS/TS + Python symbol + import + call-reference graph over
exact file contents, powering blast-radius queries ("what does this finding
touch?"). S2 slice 1: engine ships in-tree and is surfaced via CLI + MCP
(read-only); S2 slice 2: review + console wiring; S2 slice 3: Python.

## Contract

Source of truth: `lib/context-graph.js` (header contract). Pure core:

- `parseModule(path, text)` — top-level symbols (function/class/binding),
  static/require/dynamic imports, call references per line.
- `resolveImport(fromPath, spec, hasFile)` — relative-only resolution;
  bare specifiers and `node:` builtins return `null` (external, never
  guessed).
- `buildGraph(entries, { hasFile })` — files + importer→target edges.
- `blastRadius(graph, { file, symbol?, line? })` — file + transitive
  importers + name-based callers; cycles terminate; unknown file → empty.
- `buildRepoGraph({ repoDir, maxFiles })` — checkout walk (skips
  `node_modules`/`.git`/hidden dirs; truncates past cap with
  `stats.truncated`, never silently).
- `resolveRepoFile(repoDir, file)` — normalizes and rejects `..` escapes.

## Scope limits (precision over recall)

Top-level symbols only (methods attribute to their file); call
attribution is by bare name (common names over-approximate — the file
list is the reliable signal); full-line comments are not code; no AST,
no types, no control flow. Over-approximation is documented, callers
decide. Verdicts never depend on the graph (additive context only).

## Surfaces

- CLI: `sentinel context blast-radius --repo-dir <dir> --file <path>
  [--symbol <name>] [--line <n>] [--format human|json]` (read-only,
  executes nothing; exit 1 on usage/resolution errors).
- MCP: `sentinel_blast_radius` (read-only; every failure returns
  `isError`, never throws).
- Tests: `test/context-graph.test.mjs` (synthetic repos + tmpdir
  checkouts + CLI spawn + traversal rejection), MCP dispatch cases in
  `test/mcp.test.mjs`.
- Review (S2 slice 2): `formatHuman`/`toJson` accept `blastGraph` (or
  findings pre-attached via `withBlastContext`); each finding gains
  advisory `blastContext` (top files, symbols, tests — capped at 5
  each, labeled non-verdict). `sentinel review --repo-dir <dir>`
  builds the graph read-only. Receipt hashes exclude `blastContext`
  (stripped in `makeReceipt`/`verifyReceipt` — the same diff yields
  the identical receipt). Tests: `test/review-blast.test.mjs`.
- Console (S2 slice 2): `GET /api/context/blast?repoDir=&file=
  [&symbol=&line=]` (read-only; `..` escapes and bad dirs return
  error JSON, never throw); Context view (`#/context`). Tests:
  `test/console-blast.test.mjs`.

## Python (S2 slice 3)

Same contract, `parsePythonModule` behind the `parseModule` dispatch
(`.py` paths only). Covered grammar: `import x[.y] [as z]`, comma and
semicolon lists, `from x import a[, b] [as c]`, paren-joined and
star imports, relative `from .[.mod] import y` (level = dot count),
`try/except ImportError`, `if TYPE_CHECKING:`, `sys.version_info`
guards (kind `conditional`, recorded never pruned), string-literal
`__import__`/`importlib.import_module` (kind `dynamic`; non-literal
skipped), top-level `def`/`async def`/`class`/assignments, nested defs
attributed to file, decorators skipped as call sites. Full-line `#`
comments and `"""`/`'''` docstring spans are not code; inline `#`
strips whitespace-prefixed only. Resolution: relative-only with
package semantics (`mod.py`, `mod/__init__.py`); bare/absolute/stdlib
return `null` (external, never guessed). Mixed JS+Python graphs emit
zero cross-language edges (pinned by test). Walk skips
`__pycache__/`, `.venv/`, `venv/` plus the JS skip set; `stats` shape
unchanged. Limits: no `__all__` honoring, no f-string/dynamic-name
resolution, conditional imports are edges like any other (callers read
the `kind` flag).

## Open (later S2 slices)

Test/Route/Commit/PullRequest nodes, TESTS/CHANGED_BY edges, and
schema/migration/infra expansion.
