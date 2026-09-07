# Risks — Sentinel by Aftergraph

**Wedge guardrail:** Sentinel turns pull requests into merge-ready verdicts. First wedge: CLI review on exact HEAD → SHIP / DO NOT SHIP verdict with cited evidence → GitHub App.

1. **False confidence (existential).** A SHIP on a diff with a missed vulnerability destroys the brand permanently. Mitigation: severity-gated language (never "safe", only "no findings under rule pack vX"), conservative default to DO_NOT_SHIP on uncertainty, public miss log.
2. **GitHub ships verdicts into Copilot review (6-12 mo window).** Compresses independence moat to regulated/self-host buyers. Mitigation: CLI-first portability; revisit competitor-analysis quarterly.
3. **Model cost per review.** Deep reviews on large PRs burn tokens; per-PR cost must stay under ~$0.50 at team-tier pricing or unit economics invert. Mitigation: diff-size budgets, incremental re-review (only new hunks), rule pre-filter before model calls.
4. **Noise intolerance.** One noisy week (duplicates, nits) and engineers mute the App forever. Mitigation: resolution memory from day 1, style findings off by default, silence-as-feature.
5. **Single-platform dependence.** GitHub App distribution = GitHub policy risk. Mitigation: CLI works on any git remote; GitLab/Bitbucket adapters post-MVP, not before.
6. **Founder bottleneck.** Reviews, rule packs, and verdict quality all route through Jonas initially. Mitigation: rule packs are data (delegable), verdict quality is measured (miss log), hiring trigger: 10 design partners.
