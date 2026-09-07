# Verification policies — Sentinel by Aftergraph

Versioned, fail-closed gate over rule verdicts. A policy file scopes to a
repo (optionally to path globs), names required checks, and selects which
severities block. Source of truth: `lib/policy.js` (header contract);
verdict wiring: `lib/review.js` `computeVerdict` (`meta.policy`); CLI:
`bin/sentinel.js` `review --policy`; read-only agent surface:
`sentinel_policy_evaluate` (`docs/mcp.md`).

## File format

Minimal YAML subset (block maps + scalar-string lists only, spaces — no
tabs; `key: value`, nested `key:` blocks, `- item` lists, quoted scalars,
inline `[]`). Anything else throws — a policy we cannot parse exactly must
never silently weaken. Required top-level keys:

```yaml
apiVersion: sentinel.aftergraph/v1   # must equal exactly
kind: VerificationPolicy             # must equal exactly
metadata:
  name: web-default                  # non-empty string; pinned into verdicts
spec:
  scope:
    repo: acme/web                   # non-empty string, or absent (org-wide)
    paths: []                        # array of globs; [] = whole repo/scope
  required: []                       # required check names (missing => BLOCKED)
  blocking_severity:                 # subset of known severities (see below)
    - security
  approvals:
    required: []                     # parsed but not verdict-enforcing (see below)
```

- `spec` accepts only `scope`, `required`, `blocking_severity`,
  `approvals` — unknown keys throw. `scope` accepts only `repo`, `paths`.
- `blocking_severity` entries must be known severities (the values of
  `SEVERITY_MAP` in `lib/rulepack.js`: `security`, `reliability`,
  `correctness`, `data`, `performance`, `style`). Unknown entries throw.
- `spec.approvals` is parsed and versioned but does not change the
  verdict: `evaluatePolicy` takes no approval evidence (upstream
  enforcement owns approvals).
- `policyVersion` pins `name@<sha16>` (sha256 over canonical JSON) into
  every verdict (`policyEvaluation.policyVersion`).

## Minimal working example

`policies/web-default.yaml` (validated 2026-09-07 with
`node -e "import('./lib/policy.js').then(m => console.log(m.parsePolicy(text).policyVersion))"`
→ `web-default@33d1887f79e34300`):

```yaml
apiVersion: sentinel.aftergraph/v1
kind: VerificationPolicy
metadata:
  name: web-default
spec:
  scope:
    repo: acme/web
    paths: []
  required: []
  blocking_severity:
    - security
  approvals:
    required: []
```

Validate yours the same way before use:

```bash
node -e "import('./lib/policy.js').then(async (m) => {
  const { readFileSync } = await import('node:fs');
  const p = m.parsePolicy(readFileSync(process.argv[1], 'utf8'));
  console.log('OK', p.policyVersion);
})" policies/web-default.yaml
```

Malformed input throws `Invalid policy: <reason>` — never a weakened policy.

## Scope resolution and evaluation

Field contract — verdict-enforcing vs informational:

- Enforcing: `spec.scope.repo` + `spec.scope.paths` (which findings are
  in scope — see below), `spec.required` (missing result ⇒ BLOCKED, ran
  and failed ⇒ DO_NOT_SHIP), `spec.blocking_severity` (in-scope finding
  at one of these severities ⇒ DO_NOT_SHIP). Unknown entries in
  `blocking_severity` throw `Invalid policy: unknown severity` — they
  are never silently ignored.
- Informational only: `metadata.*` (name is pinned into verdicts/audit
  for traceability but changes nothing), `spec.approvals` (parsed and
  preserved, not verdict-enforcing — human approvals live outside the
  deterministic gate).

- `resolvePolicy(policies, { repo, path })` picks the most-specific match:
  longest literal path-prefix wins; repo-scoped beats org-wide on ties;
  a `paths: []` policy is the repo/org default. No match throws
  `No matching policy ...` (fail closed, no verdict).
- `evaluatePolicy(policy, { findings, checks, headSha })` returns
  `{ allowed, verdict, reasons, policyVersion }` plus exactly one
  `policy.evaluated` audit event. Precedence: **BLOCKED** (a required
  check has no result) > **DO_NOT_SHIP** (an in-scope finding with a
  blocking severity, or a required check that ran and failed) > **SHIP**.
  Out-of-scope findings never block; unlocatable findings (no file) stay
  in scope (fail closed).
- Verdict ladder (`lib/review.js` `VERDICT_STRICTNESS`): a policy verdict
  can only **escalate**, never de-escalate — the final verdict is the
  strictest of rule verdict and policy verdict
  (`SHIP < BLOCKED < STALE < DO_NOT_SHIP`; STALE bypasses policy
  entirely). A lenient policy (`blocking_severity: []`) never greens a
  rule-level DO_NOT_SHIP.

## CLI: `review --policy` scoping semantic

```bash
sentinel review --diff <file|-> --repo acme/web --policy policies/web-default.yaml [--format human|json|sarif|gov]
```

- The CLI passes `{ policies: [policy], repo, checks: {} }` with **no path
  context** — it is a repo-wide review. A **repo-wide policy**
  (`paths: []`) matches; human output gains a
  `policy: <name>@<hash8> <verdict>` line and `--format json` gains a
  top-level `policyEvaluation` object (gov/sarif shapes unchanged).
- A **path-scoped policy** (`paths: [src/**, ...]`) matches nothing
  without a path context, so the review **fails closed**: exit 2,
  `Error: policy evaluation failed: No matching policy for repo
  "acme/web"`, no verdict on stdout (verified live 2026-09-07).
  Path-scoped policies are therefore for path-aware consumers
  (`resolvePolicy` with `{ repo, path }`, MCP `sentinel_policy_evaluate`
  with `path`) — not for repo-wide CLI review.
- Missing/unparseable policy file also fails closed (exit 2, nothing on
  stdout). `BLOCKED`/`DO_NOT_SHIP` under `--policy` exit 1 like any
  non-SHIP verdict.
