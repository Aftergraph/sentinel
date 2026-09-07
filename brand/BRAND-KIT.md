# BRAND-KIT — Sentinel by Aftergraph

Source of truth: `docs/brand-identity.md` (voice, name, visual direction). This file is a working kit for the prompt pack — anything it adds (hex values, typeface names) is a **proposal pending the design sprint**, not brand fact.
HONESTY NOTE: no image has been rendered. All artwork is human-side work (see "Still needed"). This kit contains text prompts + tokens only.

## Product in one line

Sentinel by Aftergraph turns pull requests into merge-ready verdicts — CLI review on exact HEAD → **SHIP / DO NOT SHIP with cited evidence** → GitHub App.

## Palette tokens (working values for prompts; direction per brand-identity.md)

`brand-identity.md` specifies: monospace SHAs, green/red verdict pills, dark-on-light high contrast, certificate-not-chat. It gives **no hex**, so the values below are proposed working tokens. One-accent rule: exactly one chromatic accent per render — signal green for SHIP-contexts, alert red ONLY for DO-NOT-SHIP contexts, never both in one mark/panel.

| Token | Hex | Role |
|---|---|---|
| `--sentinel-ink` | `#0A0F1E` | Base: near-black navy, primary mark / body text |
| `--sentinel-navy` | `#14224A` | Base: dark navy field (hero night ground, icon tile) |
| `--sentinel-paper` | `#F7F8FA` | Base: light certificate ground (verdict artifact bg) |
| `--sentinel-white` | `#FFFFFF` | Base: pure light for seals / reversed type |
| `--sentinel-signal` | `#16C784` | Accent + success: SHIP states, radar-eye, verdict-pill glow |
| `--sentinel-alert` | `#E5484D` | Danger ONLY: DO-NOT-SHIP states, never decorative |
| `--sentinel-slate-500` | `#5B6478` | Neutral: secondary text, construction guides |
| `--sentinel-slate-200` | `#E3E7EF` | Neutral: hairlines, clearspace guides, borders |
| `--sentinel-black` | `#000000` | Neutral: single-color seal reproduction |

## Typography pairing

- **Verdicts / SHAs / evidence (first):** monospace — `JetBrains Mono`, fallback `IBM Plex Mono`, system `ui-monospace, SFMono-Regular, Menlo, monospace`. SHAs, verdict labels, and `file:line` citations are ALWAYS monospace (per brand-identity.md).
- **Text face (one):** `Inter` (proposal, pending design sprint) for body/labels; wordmark "Sentinel by Aftergraph" set in real type, never generated lettering.

## Voice recap (2 lines)

Short verdicts, cited evidence, no adjectives — e.g. `DO NOT SHIP — 2 findings on exact HEAD a3f9c1d: (1) …, routes/admin.mjs:41; (2) …, db/migrate_014.sql.` Never praise without a cited check.
Full voice + naming rationale: `docs/brand-identity.md` is the source of truth.

## Asset inventory

| File | Purpose |
|---|---|
| `brand/BRAND-KIT.md` | This kit: tokens, type, voice pointer, inventory |
| `brand/mascot/PERSONA.md` | Mascot persona bible (sibling deliverable): name options, persona, voice examples, illustrator brief — extends brand-identity.md |
| `brand/prompts/mascot-prompts.md` | 5 copy-paste mascot prompts: (a) 3x3 overview board, (b) turnaround, (c) 4-expression sheet, (d) cinematic hero, (e) app-icon set |
| `brand/prompts/logo-prompts.md` | 3 copy-paste logo prompts: primary construction sheet, monochrome seal/badge, mascot-as-app-icon |

## Still needed (human-side work — nothing here is rendered)

- [ ] Raster renders: paste each prompt in `brand/prompts/` into Midjourney / DALL-E / Firefly and save outputs (e.g. `brand/renders/*.png`); pick winners, downselect to one mascot + one mark.
- [ ] Vector redraw: designer retraces winning mark/mascot as SVG (`brand/vector/`); generator output is reference only, never the final logo.
- [ ] Verdict-pill + certificate specimen: real-type specimen showing SHIP / DO-NOT-SHIP pills, monospace SHA, `file:line` evidence links on `--sentinel-paper`.
- [ ] Design-sprint sign-off: lock final hex, typeface, and seal; update this kit and archive rejected directions.
