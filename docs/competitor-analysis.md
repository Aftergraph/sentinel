# Competitor analysis — Sentinel by Aftergraph (governance-first)

**Wedge guardrail:** Sentinel turns pull requests into merge-ready verdicts. First wedge: CLI review on exact HEAD → SHIP / DO NOT SHIP verdict with cited evidence → GitHub App.

> Evidence status: vendor-doc quotes below marked **[VERIFY]** must be confirmed against first-party docs before any public publish. No claim here has been checked against live vendor pages.

## Categories (structural, not "us vs everyone")

1. **AI PR reviewers** — CodeRabbit, Greptile, Copilot code review. *Direct layer.*
2. **Rules-based quality gates** — SonarQube/SonarCloud, CodeScene. *Adjacent: compliance buyers.*
3. **General coding agents with review features** — Claude Code, Codex, Jules. *Suppliers/partners, not competitors.*

## Per competitor (governance → distribution → lock-in)

### CodeRabbit
- **Governance:** Probabilistic comments on diffs; no exact-head verdict contract; no tamper-evident audit chain. **[VERIFY]** against docs.
- **Distribution:** GitHub App marketplace — strongest in category.
- **Lock-in:** Review history lives in their cloud; verdicts not exportable as evidence.
- **One word they cannot own: "verified".** Their business model is comment volume per PR; a hard exact-head guarantee would shrink their output and slow their UX.
- **Tag: moat** (their model contradicts verification guarantees).

### Greptile
- **Governance:** Custom rules + AI summaries; verdict authority unclear. **[VERIFY]**.
- **Distribution:** GitHub App, devtool-led growth.
- **Lock-in:** Custom rule packs locked to platform.
- **One word they cannot own: "evidence".** Rules-as-product means findings cite rules, not the verified commit.
- **Tag: moat-leaning** (custom-rules model resists per-commit evidence chains).

### Copilot code review (GitHub)
- **Governance:** Suggestions inside the GitHub permission model; inherits repo roles, no independent verdict layer. **[VERIFY]**.
- **Distribution:** Bundled with Copilot seats — unbeatable reach.
- **Lock-in:** GitHub + Microsoft model stack.
- **One word they cannot own: "independent".** They cannot credibly overrule the platform that hosts them.
- **Tag: moat** (bundling contradicts independence — our wedge for regulated buyers).

### SonarQube / SonarCloud
- **Governance:** Deterministic rules, quality gates that block merges — the closest to verdicts, but rules-only, no semantic review. Strong compliance story.
- **Distribution:** Self-host + cloud; entrenched in enterprise.
- **Lock-in:** Quality profiles and history in their format.
- **One word they cannot own: "semantic".** Rules engines cannot judge intent, only patterns.
- **Tag: feature gap for them, partner surface for us** (Sentinel verdicts + Sonar gates compose; do not compete head-on before distribution exists).

### CodeScene
- **Governance:** Behavioral code analysis (hotspots, coupling) — evidence-flavored metrics, advisory not verdicts. **[VERIFY]**.
- **Distribution:** Niche devtool channel.
- **Lock-in:** Historical analysis data.
- **One word they cannot own: "merge-decision".** Advisory by design.
- **Tag: feature** (complementary; possible integration, not competition).

## Consequences for us (6-12 month window)

If GitHub ships exact-head verdict semantics into Copilot review, our independence moat compresses to regulated/self-hosted buyers only. Mitigation: ship the self-host CLI first ( portable, no platform permission needed) so the product survives any single platform's move. Revisit this section quarterly.

## Dropped deliberately

Pricing tables (stale in months), feature checklists (category placement instead), "better at X" without cited benchmarks.
