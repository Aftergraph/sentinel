# Sentinel by Aftergraph

## Your PRs, judged on the exact commit.

Sentinel turns pull requests into merge-ready verdicts — cited evidence, file:line anchors, no hand-waving.

- **Verdicts, not vibes.** `SHIP` or `DO NOT SHIP` on a pinned HEAD SHA. If the base moves, the verdict is auto-invalidated — no stale approvals slip through.
- **Evidence you can click.** Every finding cites rule + file:line. No "looks good overall" — only checks that passed or failed, with the line that proved it.
- **CLI-first, App-second.** Run it locally on your branch before you push. The GitHub App posts the same verdict card as a single top-level comment, updated in place.

```
┌─ Sentinel Verdict ─────────────────────────────────────────┐
│ DO NOT SHIP                               HEAD a3f9c1d     │
│ rule-pack v0.1                                             │
├────────────────────────────────────────────────────────────┤
│ 1. [security]  Unauthenticated DELETE route                │
│                routes/admin.mjs:41                         │
│ 2. [reliability] Migration without rollback                │
│                db/migrate_014.sql                          │
├────────────────────────────────────────────────────────────┤
│ 4 checks passed: secrets-scan, lockfile-consistency,       │
│ test-status(ci#8812 green), diff-size(312 lines).          │
└────────────────────────────────────────────────────────────┘
```

**CLI first. App second.** Review locally on exact HEAD; let the App carry the same verdict into the PR thread.

---

### Join the waitlist

We're not launching yet. If you want to see it when it's ready, leave your email — we'll send one message when the CLI is open.

`[ email@example.com ]  [ notify me ]`

*No ads. No drip campaign. One email, when there's something real to show.*
