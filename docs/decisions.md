# Decisions — Sentinel by Aftergraph

**Wedge guardrail:** Sentinel turns pull requests into merge-ready verdicts. First wedge: CLI review on exact HEAD → SHIP / DO NOT SHIP verdict with cited evidence → GitHub App.

| # | Decision | Rationale | Needs owner approval to reverse |
|---|---|---|---|
| 1 | Name: **Sentinel by Aftergraph** | Grows out of the existing verifier role; guard-not-chatter semantics | Yes (brand) |
| 2 | Wedge order: CLI/skill → GitHub App → hosted team tier | Distribution where incumbents cannot follow; dogfood from sprint 1 | Yes (strategy) |
| 3 | Verdict bound to exact HEAD; base move = auto-stale | The entire moat; without it we are another comment bot | Yes (product contract — never silently) |
| 4 | No auto-fix, no auto-approve in MVP | Unverified actions destroy trust faster than missing features | Yes |
| 5 | Free for public repos, paid team tier later | OSS is distribution, not revenue | Yes (pricing) |
| 6 | Interviews/pilot optional later, not next | Prototype-first; validation via desk research + 5-PR prototype runs | Jonas only |
| 7 | Docs before code; no scaffolding in this repo | Strategy must survive contact with prototype results before LOC | Jonas only |
| 8 | Vendor-doc claims marked [VERIFY], unpublished until confirmed | One caught fabrication discounts the whole comparison | No (process rule, permanent) |
| 9 | v0 verdict path fully deterministic, no LLM as judge | "Verified" and probabilistic output cannot share a sentence; LLM allowed in v1 as explanation layer only | Yes (product contract) |
| 10 | Pack v1.2.0 adopts upstream destructive-migration rule; swallowed-exceptions stays out of all packs | Migration rule passed the precision audit (gap #13); the catch rule promises critical-path scoping its regex cannot deliver (CUT gap #7) — shipping it would trade precision for rule count | Yes (precision is the moat) |
| 11 | Pack v1.3.0 adds retry-with-backoff rule (gap #8); gaps #9/#10/#12/#14/#19 stay out with written entry criteria | Retry rule has a binary presence signal (single-line .catch re-invocation, delay-token hatch); the other five are absence/schema checks no diff regex can prove at ≥80% precision | Yes (precision is the moat) |
| 12 | Pack v1.4.0 promotes gap #10 (k8s probe rule, lockfile-shaped same-file signal); gap #9 stays out | Probe absence scoped to the file's added lines is a binary file-local signal; replicas:1/Recreate have wide legitimate use with no binary signal | Yes (precision is the moat) |
