# Verdict override — Sentinel by Aftergraph

Break-glass surface: a human operator may replace a computed verdict with
`SHIP` or `DO_NOT_SHIP`, with the actor and reason recorded. Sources of
truth: `lib/review.js` (`computeVerdict` override block, `formatHuman`
`OVERRIDDEN` line), `bin/sentinel.js` (`cliOverrideFromFlags`, `--help`);
behavioral contract: `test/override.test.mjs` (17 tests). Overrides never
touch `docs/policy.md` — policy gates and overrides compose (override wins
for the verdict, the policy evaluation is preserved).

## CLI flags

```bash
sentinel review --diff <file|-> --repo a/b --override SHIP|DO_NOT_SHIP --override-reason <text> [--override-actor <name>]
```

| Flag | Meaning |
|---|---|
| `--override SHIP\|DO_NOT_SHIP` | replacement verdict (must differ from the computed verdict) |
| `--override-reason <text>` | required, non-empty — why the verdict is replaced |
| `--override-actor <name>` | optional — who overrides; defaults to `whoami`, else `USER`/`USERNAME` env |

Works on both `review` paths (plain and `--policy`); `--help` lists the
shape on one line (verified against `node bin/sentinel.js --help`).

## What an override records

- `result.overriddenFrom` keeps the computed verdict; `result.overridden`
  is `{ actor, reason, from, to }`.
- One append-only audit event (`verdict.overridden`) with actor, reason,
  from/to, and `headSha`.
- The receipt records the **overridden** verdict; without an override the
  result shape is byte-identical to before (no `overridden` /
  `overriddenFrom` keys, no audit event).
- Human output appends one receipt line (and only when overridden):

```text
OVERRIDDEN by alice (incident-123) — was SHIP
```

- JSON output gains top-level `overridden` + `overriddenFrom`;
  `verdict.decision` carries the overridden verdict.
- Observed quirk (do not document otherwise): the human findings section
  still reflects the un-overridden findings — e.g. an override
  `SHIP -> DO_NOT_SHIP` prints `SHIP — 0 findings` plus the `OVERRIDDEN`
  line and exits 1; `DO_NOT_SHIP -> SHIP` prints the finding list plus
  the `OVERRIDDEN` line and exits 0. Gate automation on the exit code /
  `verdict.decision`, not on the human first line.

## Fail-closed rejections (all observed live, exit 2, nothing on stdout)

```text
Error: --override requires --override-reason
Error: --override must be SHIP or DO_NOT_SHIP (got "MAYBE")
Error: override rejected: override must change the verdict
```

| Case | Observed |
|---|---|
| `--override` without `--override-reason` (or empty reason) | exit 2, `Error: --override requires --override-reason`, no verdict on stdout |
| `--override MAYBE` (or any non-`SHIP`/`DO_NOT_SHIP` value, incl. `STALE`) | exit 2, `Error: --override must be SHIP or DO_NOT_SHIP (got "…")` |
| rubber-stamp override (replacement equals the computed verdict) | exit 2, `Error: override rejected: override must change the verdict` |
| malformed override (missing/empty actor or reason, bad verdict) | throws `Invalid override …` / `Invalid override verdict …`, no verdict, no audit event |

Rejected overrides append no `verdict.overridden` audit event.

## STALE (code intent, not exercised live)

`lib/review.js` holds the guard `override never applies to STALE
(freshness gate wins)` — the exact-head freshness gate bypasses
`computeVerdict` entirely, so a STALE verdict always stands. This path is
not reachable from local `--diff` mode (no remote to drift, STALE cannot
occur) and was not exercised live here (GitHub PR drift needs `gh` auth +
network) — treat as [VERIFY]/manual before relying on it.
