# Sentinel logo construction

Hand-authored original geometry for Sentinel by Aftergraph. All artwork is
flat vector source (SVG only); every file opens with an `<svg>` root carrying
a `viewBox` and stays well under 200 lines.

## Grid

- Master grid is **96 × 96 units** (`sentinel-mark.svg`, `sentinel-mascot.svg`).
- Pills share a **48-unit height** system (`verdict-pill-*.svg`); the favicon
  is drawn on its own **16 × 16** grid (`favicon.svg`).
- The mark and the mascot use the same shield construction, so the two read
  as one family at any size.

## Key measurements

- Shield boundary: `M48 6 L82 19 V50 C82 69 67 80 48 90 C29 80 14 69 14 50
  V19 Z` — derived from two r=34 construction circles centred at (30,46)
  and (66,46), squared at the top edge (y=19), meeting at (48,90).
- Verification check: polyline `(31,49) → (43,61) → (66,33)`; both arms run
  on exact 45° diagonals; stroke width **11 units**, square caps, miter join.
  Terminals are cut square — the "diagonal cut" signature.
- Mascot: same shield path for the hood; shoulders are the bust arc `M24 96
  C24 84 34 78 48 78 C62 78 72 84 72 96 Z`. Visor slit is `40 × 10` at
  (28,42) with corner radius **5**; nose guard is `5 × 18` at (45.5,38) with
  radius **2**, forming a T-visor (deliberately no eyes). Brow check is
  `(39,30) → (44,35) → (55,23)` at width **4.5**.
- Pills: `44`-high bar on the 48 grid, corner radius **22** (true stadium
  pill); embedded mini-mark is mark geometry at scale **0.3333** placed at
  (14,8). Verdict type is 20px bold system monospace with +2 tracking,
  baseline y=31.
- Favicon: `16 × 16` badge, radius **3**; check `(3.5,8.5) → (7,12) →
  (12.5,4.5)` at width **2.5**, square caps. The badge itself stands in for
  the shield-boundary at this size.

## Clearspace rule

Clearspace on all sides equals the check stroke width scaled to the
rendering: **11 units on the 96 grid** (≈ 11% of mark height). Nothing —
type, rules, page edges — may enter that zone.

## Minimum size

- Mark / favicon geometry: legible down to **16 px**.
- Mascot (visor detail): minimum **32 px**; below that, use the mark.
- Pills: minimum **24 px** height on screen (scale the 48 grid by 0.5×);
  below that, use plain mono text (`SHIP` / `DO NOT SHIP`).

## Color tokens

| Token | Hex | Use |
|---|---|---|
| Ink | `#111827` | Mark body (fixed builds), mascot hood, favicon badge |
| Paper | `#FFFFFF` | Check knock-out, visor slit, mini-mark field |
| SHIP | `#15803D` | Green pill field; check colour inside the green mini-mark |
| SHIP-BRIGHT | `#22C55E` | Brow check on the dark mascot hood only (never on light) |
| NO-SHIP | `#B91C1C` | Red pill field; check colour inside the red mini-mark |

The primary mark ships with `fill="currentColor"` so it inherits context;
a fixed-ink build pins it to `#111827`. Mascot and pills use fixed hex.

## Dark / light usage

- Light backgrounds (default, per brand: dark-on-light certificate feel):
  ink mark, full-colour pills, full mascot.
- Dark backgrounds: set the mark via `currentColor` to paper white; pills
  stay exactly as specified (their fields carry their own contrast); avoid
  the mascot on near-black grounds (hood is ink) — use the mark instead.

## What NOT to do

1. No gradients (the mascot ships with zero), no drop shadows, no outlines
   or recolouring outside the tokens above — flat shapes only.
2. No clip-art eyes, faces, lightning bolts, or borrowed shield/check
   clipart grafted onto the geometry — the T-visor and the 45° square-cut
   check are the only sanctioned details.
3. Do not re-space, re-set (non-monospace), condense, or translate the pill
   strings, and do not separate the mini-mark from its pill.
