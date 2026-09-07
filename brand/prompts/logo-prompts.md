# Sentinel by Aftergraph — Logo Prompts (copy-paste)

Source of truth: `docs/brand-identity.md`. Product: exact-HEAD code-verification → verdicts **SHIP / DO NOT SHIP with cited evidence**.
HONESTY NOTE (read first): no image-generation tool was used here. No image has been rendered. These are **text prompts only** — a human pastes each block into Midjourney / DALL-E / Firefly and renders on their side.

## Shared logo lock (use for all 3 prompts)

**Mark concept:** a vigilance seal — abstract shield-lantern fused with a radar-eye arc. Geometry a human can redraw: circle + single eye-slit + one shield notch. No animal, no superhero, no generic bolt.
**Continuity string:** `same mark in every render: minimal shield-lantern seal with single radar-eye arc, geometric, reproducible, premium minimal identity`
**Wordmark rule:** generators mangle text — request the mark WITHOUT lettering, then set "Sentinel by Aftergraph" in real type afterward (see `brand/BRAND-KIT.md`).

## Shared style terms (append to every prompt)

`premium, minimal, flat vector identity, geometric, high contrast, no text artifacts, no letters, no numbers, no watermark, no signature`

## Shared negative terms (all prompts)

`no generic lightning bolt, no clipart, no photorealistic human, no text gibberish, no distorted letters, no watermark, no stock icon, no cartoon animal, no gradient mesh`

---

## 1. Primary mark construction sheet

- **Strategy line:** Category = logo construction / Audience = designer finalizing the mark / Metaphor = security-vigilance (the seal that certifies an exact commit — a certificate stamp, not a chat avatar).
- **Palette:** black/navy construction on light ground (`#0A0F1E` on `#F7F8FA`); single signal-green `#16C784` eye accent to show the SHIP-state usage. No red on this sheet.
- **Aspect ratio:** 3:2 landscape.

**Copy-paste prompt:**

```text
logo construction sheet for a code-verification product, same mark in every render: minimal shield-lantern seal with single radar-eye arc, geometric, reproducible, premium minimal identity, large primary mark left, then grid showing clearspace, stroke-weight steps, and minimum-size row, dark navy linework #0A0F1E on light certificate ground #F7F8FA, one signal-green radar-eye accent #16C784, thin precise construction guides, premium, minimal, flat vector identity, geometric, high contrast, no text artifacts, no letters, no numbers, no watermark, no signature --ar 3:2 --style raw --no generic lightning bolt, clipart, photorealistic human, text gibberish, distorted letters, watermark, stock icon, cartoon animal, gradient mesh, red color
```

- **DALL-E / Firefly note:** use wide/landscape; move the `--no` list into the negative/exclude field; re-set any lettering in real type afterward.

---

## 2. Monochrome seal / badge variant

- **Strategy line:** Category = certificate seal / Audience = developers receiving verdict artifacts (merge certificates, receipts) / Metaphor = security-vigilance (the wax-seal that says "verified on exact HEAD" — must survive fax-grade reproduction: one color, no glow).
- **Palette:** pure monochrome — solid black `#000000` (or navy `#0A0F1E`) on white, OR reversed white on navy. No green, no red on this sheet.
- **Aspect ratio:** 1:1 square.

**Copy-paste prompt:**

```text
monochrome seal and badge variants, same mark in every render: minimal shield-lantern seal with single radar-eye arc, geometric, reproducible, premium minimal identity, four circular stamp badges in a 2x2 grid (solid black on white, white on solid navy #0A0F1E, outline line version, micro small-size version), engraved certificate-stamp feel, crisp edges, flat vector, one-color reproduction, premium, minimal, flat vector identity, geometric, high contrast, no text artifacts, no letters, no numbers, no watermark, no signature --ar 1:1 --style raw --no generic lightning bolt, clipart, photorealistic human, text gibberish, distorted letters, watermark, stock icon, cartoon animal, gradient mesh, color, glow, green, red
```

- **DALL-E / Firefly note:** use square; add "single color, no gradients, no glow" to negatives; test the smallest badge at 32px — redraw by hand if strokes collapse.

---

## 3. Mascot-as-app-icon

- **Strategy line:** Category = mascot-driven app icon / Audience = end users (dock, home screen, GitHub App listing) / Metaphor = security-vigilance at 48px (the guard's visor-eye, cropped close so it reads next to other dev-tool icons).
- **Palette:** dark navy tile `#0A0F1E` with off-white glyph; ONE accent — signal-green `#16C784` radar-eye (SHIP-family default). Red variant rendered separately, never on the same tile.
- **Aspect ratio:** 1:1 square.

**Copy-paste prompt:**

```text
app icon, tight close crop of the sentinel guard head mark: minimal shield-lantern seal with single radar-eye arc, geometric, reproducible, premium minimal identity, single rounded-square tile, dark navy tile #0A0F1E, off-white glyph, one signal-green radar-eye dot #16C784, flat premium vector look, generous padding, instant silhouette at small size, plain background, premium, minimal, Sintra-grade mascot quality, high contrast, no text artifacts, no letters, no numbers, no watermark, no signature --ar 1:1 --style raw --no generic lightning bolt, clipart, photorealistic human, human face, text gibberish, distorted letters, watermark, stock icon, cartoon animal, photo, gradient mesh, red color, words, letters
```

- **DALL-E / Firefly note:** use square; render the DO-NOT-SHIP notification badge (alert-red `#E5484D` dot) as a separate second run with everything else identical.
