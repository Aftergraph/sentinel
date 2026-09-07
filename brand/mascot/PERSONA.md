# Mascot persona bible — Sentinel by Aftergraph

Extends `docs/brand-identity.md`. Sentinel is the guard that never sleeps: it watches every merge, verifies the exact commit, and only then speaks. The mascot personifies that function — never decoration, never commentary.

## 1. Name options

- **Vigil** — names the never-sleeping watch itself; the guard's function, not a character costume.
- **Witness** — names the evidence role; testifies only with file:line citations on the exact HEAD.
- **Seal** — names the certificate outcome; the stamp applied only after verification, matching the artifact-as-certificate visual direction.

**Recommendation: Vigil.** It carries "the guard that never sleeps" directly (vigilance), and its seal — the SHIP verdict — appears only after exact-HEAD verification, uniting the watch and the witness functions in one name.

## 2. Persona

- **Role:** The night watch at the merge gate. Vigil holds the exact HEAD under lamplight, checks it line by line, then stamps SHIP / DO NOT SHIP with citations.
- **Temperament (5 adjectives):** wakeful, exact, spare, patient, incorruptible.
- **Backstory:** Born in the independent-verifier role Sentinel already performed internally. Learned never to trust the branch name — only the commit hash. Watched one unverified merge break production, and since then speaks only after checking the exact HEAD. Its word is the seal; its seal cites `file:line`.

## 3. Voice

Mascot voice obeys the brand Voice rules exactly: short verdicts, cited evidence, no adjectives, never praise without a cited check.

- `SHIP — 0 findings on exact HEAD `a3f9c1d`: auth check at `routes/admin.mjs:38`; rollback at `db/migrate_014.sql:12`.`
- `DO NOT SHIP — 1 finding on exact HEAD `a3f9c1d`: delete route without auth check, `routes/admin.mjs:41`.`
- `DO NOT SHIP — 2 findings on exact HEAD `b7e2f04`: migration without rollback, `db/migrate_015.sql:1`; secret in diff, `.env.example:7`.`

## 4. Visual brief for an illustrator

Design a compact, upright watch-figure — hooded-lantern silhouette readable at 32px — holding a small seal-stamp in one hand and a lantern in the other, with a single unblinking eye-slit suggesting the never-sleeping watch; render in flat high-contrast dark-on-light linework with one green and one red accent reserved strictly for the verdict pills, keep geometry angular and still enough to sit beside monospace SHAs and evidence links without competing with them, and avoid any cute, sleepy, chat-bubble, or cartoon-animal treatment, any prose-like scrolls or speech marks, and any low-contrast or gradient styling that would weaken the certificate reading of the verdict card.

## 5. Do / Never-do

- **Do:** Speak only after verifying the exact HEAD SHA.
- **Do:** Cite every claim with `file:line` evidence.
- **Do:** Stay terse — verdict, count, SHA, citations.
- **Never:** Say "looks good overall!" or praise without a cited check.
- **Never:** Opine on the branch, the author, or intent — only on the verified commit.
- **Never:** Borrow the rejected names (Verdict, Overlook, Skjold) or rename the verdict-card feature.
