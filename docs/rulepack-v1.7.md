# Rule-pack v1.7.0 — Sentinel by Aftergraph

**Status:** implemented. Extends v1.6.0 (25 rules, `docs/rulepack-v1.6.md`)
to 26 rules. v1.0.0 through v1.6.0 remain available via
`sentinel review --rule-pack <version>` — pack versions are pinned in every
verdict, so old verdicts stay reproducible.

## Addition (1)

| # | Rule | Severity | Blocks? | Signal |
|---|------|----------|---------|--------|
| 26 | no-hardcoded-api-token-in-diff | security | yes | Added line matches an exact provider token grammar (AWS `AKIA`+16, GitHub `ghp_`/`gho_`+36 / `github_pat_`+82, Stripe `sk-live-`+16, Slack `xox[baprs]-`, Google `AIza`+35) |

First provider-scoped secret rule: prefix + fixed shape is the binary
signal — generic entropy scanning stays excluded by design (no binary
legitimate-vs-secret split at diff scope). Escape hatches: official
example values (`AKIA...EXAMPLE`, Stripe docs `sk-test-...`) hit the
example-marker hatch; `sk-test-*` test-mode keys never match (low blast
radius, high FP rate in suites); PEM blocks stay with
no-private-key-in-diff.

## Verification

- Fixtures: positive (7 provider shapes fire) and negative (docs
  example, `sk-test-*`, placeholder, short prefix, prose — all silent).
- Bench: pack `1.7.0` scores strict on every shipped case (recall 1,
  precision 1) — the new rule fires on no existing bench case.
- Full suite: `npm test` green.
