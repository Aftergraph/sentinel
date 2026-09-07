# Sentinel by Aftergraph — Mascot Prompts (copy-paste)

Source of truth: `docs/brand-identity.md`. Product: exact-HEAD code-verification → verdicts **SHIP / DO NOT SHIP with cited evidence**.
HONESTY NOTE (read first): no image-generation tool was used here. No image has been rendered. These are **text prompts only** — a human pastes each block into Midjourney / DALL-E / Firefly and renders on their side.

## Shared mascot lock (use for all 5 prompts)

**The Sentinel:** an abstract vigilant guard-construct — minimal geometric watch-figure with a calm radar-eye visor and a shield-lantern silhouette. It embodies "the guard that never sleeps: watches every merge, verifies the exact commit, and only then speaks." Authority through vigilance, not volume.
**Metaphor discipline:** security-vigilance ONLY. Not a random animal, not a superhero, not a robot toy. No animal mascot.
**Continuity string (append to every prompt):** `same character across all renders: minimal geometric sentinel guard, dark navy hooded visor form, single calm radar-eye, shield-lantern chest plate, premium minimal vector-cinematic style`

## Shared style terms (append to every prompt)

`premium, minimal, Sintra-grade mascot quality, clean silhouette, high contrast, no text artifacts, no letters, no numbers, no watermark, no signature, no frame border`

## Shared negative terms (all prompts)

`no generic lightning bolt, no clipart, no photorealistic human, no human face, no text gibberish, no distorted letters, no watermark, no stock icon, no cartoon animal`

---

## (a) 3x3 identity overview board

- **Strategy line:** Category = product identity board / Audience = founders + designer in design sprint / Metaphor = security-vigilance (one guard, nine contexts — watch, verify, judge, certify).
- **Palette:** black/navy base (`#0A0F1E`, `#14224A`) on light certificate ground (`#F7F8FA`); ONE accent per cell — signal green `#16C784` for SHIP-context cells, alert red `#E5484D` ONLY in DO-NOT-SHIP cells, never mixed inside a single cell.
- **Aspect ratio:** 1:1 square.

**Copy-paste prompt:**

```text
3x3 identity overview board for "Sentinel by Aftergraph", exact-HEAD code-verification product, same character across all renders: minimal geometric sentinel guard, dark navy hooded visor form, single calm radar-eye, shield-lantern chest plate, premium minimal vector-cinematic style, nine uniform cells on a light certificate ground: 1 mascot portrait, 2 turnaround mini, 3 four-expression mini, 4 radar watch motif, 5 SHIP verdict pill glow in signal green, 6 DO-NOT-SHIP seal in alert red, 7 evidence-link motif abstract file-line glyphs, 8 app-icon trio, 9 cinematic night-watch hero crop, black navy base #0A0F1E #14224A, signal green accent #16C784 for SHIP cells, alert red #E5484D only in DO-NOT-SHIP cells, premium, minimal, Sintra-grade mascot quality, clean silhouette, high contrast, no text artifacts, no letters, no numbers, no watermark, no signature, no frame border --ar 1:1 --style raw --no generic lightning bolt, clipart, photorealistic human, human face, text gibberish, distorted letters, watermark, stock icon, cartoon animal
```

- **DALL-E / Firefly note:** use square (1024×1024); paste everything before `--ar`/`--no`; put the `--no` list into the tool's "exclude / negative" field if available.

---

## (b) Mascot character turnaround (front / side / back, flat premium vector)

- **Strategy line:** Category = character model sheet / Audience = designer + illustrator / Metaphor = security-vigilance (the night-watch guard, standing at post — front, side, back).
- **Palette:** black/navy base only (`#0A0F1E`, `#14224A`) on off-white; single faint signal-green `#16C784` radar-eye glow (SHIP-family standby, NOT a verdict). No red anywhere in this sheet.
- **Aspect ratio:** 3:2 landscape.

**Copy-paste prompt:**

```text
character turnaround model sheet, three full-body views side by side (front, side, back) of the same character: minimal geometric sentinel guard, dark navy hooded visor form, single calm radar-eye, shield-lantern chest plate, premium minimal vector-cinematic style, flat premium vector look, clean thick silhouette, off-white background #F7F8FA, dark navy figure #0A0F1E #14224A, one faint signal-green radar-eye glow #16C784, consistent proportions across all three views, alignment guides, premium, minimal, Sintra-grade mascot quality, no text artifacts, no letters, no numbers, no watermark, no signature, no frame border --ar 3:2 --style raw --no generic lightning bolt, clipart, photorealistic human, human face, text gibberish, distorted letters, watermark, stock icon, cartoon animal, red color
```

- **DALL-E / Firefly note:** use wide/landscape; add "no red, monochrome navy figure" to the negative field.

---

## (c) 4-expression sheet (approving-SHIP / blocking-DO-NOT-SHIP / verifying-scanning / idle night-watch)

- **Strategy line:** Category = verdict-state expression sheet / Audience = product + designer (verdict-card states) / Metaphor = security-vigilance (the same guard judges: lets pass, blocks, scans, waits).
- **Palette:** black/navy base per panel; ONE accent per panel — signal green `#16C784` for approving-SHIP and verifying/scanning panels; alert red `#E5484D` ONLY in the blocking-DO-NOT-SHIP panel; idle night-watch panel monochrome navy with faint green standby dot. Never red+green in one panel.
- **Aspect ratio:** 16:9 landscape.

**Copy-paste prompt:**

```text
four-panel expression sheet of the same character: minimal geometric sentinel guard, dark navy hooded visor form, single calm radar-eye, shield-lantern chest plate, premium minimal vector-cinematic style, panel 1 approving-SHIP stance open guard posture with signal-green glow #16C784, panel 2 blocking DO-NOT-SHIP stance raised shield-palm barrier with alert-red glow #E5484D in this panel only, panel 3 verifying-scanning pose with radar sweep arc and scanline across visor in signal green, panel 4 idle night-watch resting vigilant pose monochrome navy nearly dark, uniform bust portraits in a row, dark navy base #0A0F1E #14224A on near-black ground, premium, minimal, Sintra-grade mascot quality, clean silhouette, high contrast, no text artifacts, no letters, no numbers, no watermark, no signature, no frame border --ar 16:9 --style raw --no generic lightning bolt, clipart, photorealistic human, human face, text gibberish, distorted letters, watermark, stock icon, cartoon animal
```

- **DALL-E / Firefly note:** use 16:9 wide; if the tool mixes red and green in one panel, re-render with "single accent color per panel" emphasized.

---

## (d) Cinematic hero art (dark navy, radar/watch motif, verdict pill glow)

- **Strategy line:** Category = marketing hero / Audience = developers evaluating the product (landing, README, launch post) / Metaphor = security-vigilance (the night watch over a sleeping codebase; radar sweep = exact-HEAD verification before judgment).
- **Palette:** dark navy field (`#0A0F1E`, `#14224A`); ONE verdict-pill glow — signal green `#16C784` (SHIP-context hero). Do NOT add red to this render.
- **Aspect ratio:** 16:9 cinematic.

**Copy-paste prompt:**

```text
cinematic hero art, the sentinel guard standing night-watch over a dark sleeping abstract codebase city of faint geometric blocks, minimal geometric sentinel guard, dark navy hooded visor form, single calm radar-eye, shield-lantern chest plate, premium minimal vector-cinematic style, vast dark navy night field #0A0F1E #14224A, thin radar sweep arcs overhead, one glowing rounded verdict-pill of signal-green light #16C784 floating beside the guard like a lantern seal, volumetric glow, deep shadows, premium, minimal, cinematic, clean silhouette, high contrast, no text artifacts, no letters, no numbers, no watermark, no signature, no frame border --ar 16:9 --style raw --no generic lightning bolt, clipart, photorealistic human, human face, text gibberish, distorted letters, watermark, stock icon, cartoon animal, red color, daytime, cheerful
```

- **DALL-E / Firefly note:** use 16:9; for a DO-NOT-SHIP variant of this hero, swap ONLY the pill glow to alert red `#E5484D` and keep everything else identical.

---

## (e) App-icon set

- **Strategy line:** Category = app icon / Audience = end users (CLI companion, GitHub App, mobile) / Metaphor = security-vigilance at 48px (visor-eye + shield-lantern reads instantly at small size).
- **Palette:** dark navy tile (`#0A0F1E`) with light glyph; ONE accent — signal green `#16C784` radar-eye (SHIP-family default set). Produce a second red set ONLY for DO-NOT-SHIP notification states, never mixed on one tile.
- **Aspect ratio:** 1:1 square, icon grid.

**Copy-paste prompt:**

```text
app-icon set, six rounded-square icons in a 2x3 grid showing the same minimal geometric sentinel guard head mark: dark navy hooded visor form, single calm radar-eye, shield-lantern hint, premium minimal vector-cinematic style, flat premium vector look, dark navy tiles #0A0F1E with off-white glyph, single signal-green radar-eye dot #16C784, consistent stroke weight, large legible silhouette at small size, plain background, premium, minimal, Sintra-grade mascot quality, clean silhouette, high contrast, no text artifacts, no letters, no numbers, no watermark, no signature --ar 1:1 --style raw --no generic lightning bolt, clipart, photorealistic human, human face, text gibberish, distorted letters, watermark, stock icon, cartoon animal, photo, gradient mesh, red color
```

- **DALL-E / Firefly note:** use square; request "flat vector, no gradients" if the tool adds glossy 3D effects; make the red notification-state variant as a separate render.
