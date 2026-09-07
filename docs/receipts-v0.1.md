# Receipts + gov surface v0.1 — Sentinel by Aftergraph

**Status:** implemented in v0.1.0. This is the contract registration for
`sentinel.receipt/0.1` and `sentinel.gov/0.1`.

## Why receipts exist

CodeRabbit, Copilot review, and Sonar all produce output that cannot answer
"What exactly did you verify, and can I check it without trusting you?"
A verdict printed to stdout is a claim. A **verdict receipt** is a claim
anyone can re-verify offline: `receipt_id` is the sha256 of the canonical
receipt body, so `sentinel verify --receipt <file>` recomputes one hash and
answers VALID or INVALID with no network and no trust required.

## sentinel.receipt/0.1

Emitted by every `review` run — including STALE runs (a recorded "no
verdict" is itself audit evidence):

| Field | Meaning |
|---|---|
| `contract` | `sentinel.receipt/0.1` (pinned) |
| `repo`, `prNumber`, `headSha`, `baseSha` | exact-head binding (40-hex SHAs) |
| `rulePackVersion` | pack that produced the verdict; `1.0.0` replays the original 6-rule pack |
| `verdict` | `SHIP` \| `DO_NOT_SHIP` \| `STALE` |
| `findings` | `{blocking, silenced, nonBlocking, excluded}` in fixed key order (hash-stable) |
| `counts` | lengths of each bucket |
| `configHash` | short hash of the applied `sentinel.config.json`, or null |
| `receipt_id` | sha256 over the body above — identical inputs always yield the identical id |
| `prev_receipt_id` | previous receipt for the same repo+PR (hash chain), or null |
| `run_id`, `timestamp`, `source`, `environment` | execution identity (never hashed, so reruns stay idempotent) |

Ledger: append-only JSONL, default `~/.sentinel/ledger.jsonl`
(`--ledger-path` overrides, `--no-ledger` disables write + delta read).
Malformed lines are skipped, never fatal.

## Evidence-layer position (governance honesty)

The ledger is a **local claim log**. It is not L1 action audit and not an
L2 execution quittance: it proves what *this runner* computed, nothing
more. Per platform governance, no layer upgrades another — a receipt does
not establish AIE conformance, scientific validity, or runtime authority.
It composes *upward*: receipts are shaped so platform consumers can ingest
them, never so Sentinel can claim their status.

## sentinel.gov/0.1 (`--format gov`)

The verdict expressed in the shape of Aftergraph `ci-result/1.0`: one
source's complete verdict for one exact SHA plus an environment
fingerprint (`runner`, `versions: {node, sentinel, rulepack}`). Deliberate
deltas from `ci-result/1.0`, documented here rather than hidden:

- the SHIP/DO_NOT_SHIP verdict rides as a `sentinel/verdict` context entry
  (`success`/`failure`); each rule rides as `sentinel/<rule-id>`;
- STALE has no enum state upstream, so it emits a single
  `{context: 'sentinel/review', status: 'cancelled'}` entry;
- `prNumber`, `baseSha`, `rulePackVersion` are Sentinel extensions the
  upstream schema does not define.

`--source` validates against the upstream source enum
(`github-actions`, `self-hosted`, `works-control-plane`, `manual`,
`agent`); unset means auto-detect (`GITHUB_ACTIONS=true` → first value,
else `manual`).

## Competitor-inspired, determinism-preserving

- **CodeRabbit-style summary + delta:** human output opens with a computed
  diffstat (`PR: N file(s), +A/-R — top: …`); when the ledger holds a prior
  receipt for the same PR at a different HEAD, a `Since <sha>: +N new,
  -M fixed` section follows. Both are pure functions of diff + ledger.
- **Sonar-style per-rule results:** the gov `results[]` array gives every
  rule an explicit pass/fail — the machine-readable Quality-Gate equivalent.
- **Copilot-style repo config:** `sentinel.config.json` (`rulePack`,
  `exclude[]` with `**`/`*`/`?` globs). Excluded findings are *reported*,
  never block. Malformed config fails closed (exit 1) — a config that
  silently weakens a verdict would break the product contract (`decisions.md` #3).

## Verification

- `test/receipts.test.mjs`: idempotency, tamper detection, chain linkage,
  gov shapes (verdict + STALE), delta math, glob semantics, fail-closed
  config, human sections — 13 tests.
- Full suite: `npm test` → 70 pass.
- Round-trip proof: `sentinel verify --receipt` on a tampered copy prints
  `INVALID` and exits 1.
