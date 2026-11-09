# ArcStride

A local-first training workbench — Strava's analytics, planning and map features rebuilt without the paywall, plus the physiology Strava doesn't have. **Every number shows its math. Nothing is uploaded.**

Built on the **ArcArmor Design System (System A — Arc'emX! Product System)**.

* `docs/01-STRAVA-TEARDOWN.md` — research: free vs paid features, how the metrics work, weaknesses
* `docs/02-PRODUCT-SPEC.md` — feature-by-feature status (built / partial / needs a server)

## Run

```bash
npm install
npm run dev            # http://localhost:5173
npm test               # 58 unit tests (parsers, metrics, load model, predictions, segments, plans…)
npm run build          # production build → dist/
npm run build:single   # one self-contained index.html (fonts+JS+CSS inlined) → dist-single/
```

First launch → **Explore with a demo athlete** (a year of clearly-labelled synthetic runs and rides), or drop your own `.gpx` / `.tcx` / `.fit` files — or your whole **Strava bulk-export `.zip`**.

## Screens

Screenshots of every key screen are in `docs/screens/`.

| | |
|---|---|
| **Today** | Readiness (with breakdown + daily check-in), CTL/ATL/TSB/ACWR, rolling 7 days, insights, recent, heatmap preview, race outlook |
| **Activities** | Advanced search/filter/sort over the whole library (free) |
| **Activity** | Synced map + chart stack, drag-to-analyse, create segment from a selection, splits, zones, load three ways, records, power curve, segment efforts, ghost-compare, share card, GPX export |
| **Training** | PMC with forecast, what-if simulator, weekly volume/intensity, polarisation, monotony/strain/spike, calendar, all insights |
| **Performance** | VDOT predictions + ranges, training paces, PRs, power curve + CP/W′, EF/decoupling trends, threshold detection, zones |
| **Routes** | Heatmap + explorer tiles · auto-discovered segments · matched routes |
| **Plan** | Periodised adaptive plan · effort-matched course pacing |
| **Goals** | Goals with projections · personal challenges · gear mileage |
| **Record** | Browser GPS recorder with draft recovery |
| **Settings** | Profile, thresholds, zone model, privacy zones, import/export/delete, every formula |

## Design-system compliance (playbook v1.0, System A)

Applied exactly as written: Geist + Geist Mono (self-hosted via `@fontsource-variable`), weights 400/500/600 only; all colour tokens (`#0A0A0A` bg, `#111/#18181B` surfaces, `#27272A` hairlines, `#FAFAFA`/`#A1A1AA` text, the four signal colours, 8–10 % fill / 35–50 % border chips); radius scale 999/22/16/14 with paired radii on segmented controls; floating translucent pill nav with the single shadow; inverted pill primary CTA; type scale (H1 48 / H2 24 / body 16.8 / mono eyebrow 11.2 px with +1.12 px tracking, negative tracking on headings); **numbered sections `001 / 006`** on every page; **Unicode glyph icons** (✦ ◈ ◎ ⬡ ◷ ◯ …, no icon library); flat design, no card shadows; the hero glow gradient is the **only** gradient (a CSS audit found none other); asymmetric section padding; near-black, never `#000`.

Documented extensions (needed for data-viz, same 400-level colour family): `--c-z5 #FB923C`, `--c-z7 #E879F9` for zones 5/7 and the 7th power zone.

**Chart colours were validated** with the dataviz skill's palette validator against surface `#111111`. The playbook's neon signals fail the validator's *categorical* lightness band by design, so they are used only as **identity-by-role** with secondary encoding: ink↔red 27.3 ΔE, ink↔yellow 20.7, red↔yellow 17.8, lime↔red 15.4 (CVD, worst-case). The one weak pair (green↔red, 7.9 under deuteranopia) is never a series pair; green/red appear only as status with sign, label or position. Every multi-series chart has a legend, direct labels or tooltip, and a **Table** view.

## Honest limits

No global leaderboards / social / Live Segments / Beacon / watch sync (need a server or native), no turn-by-turn route builder (needs a routing engine), no Bluetooth sensors, GPS-only elevation. See `docs/02-PRODUCT-SPEC.md` §4 for what is and isn't verified.

## Privacy

All data lives in this browser (IndexedDB). Map tiles are **off by default** (opt-in CARTO tiles would reveal the viewed area to the tile server). Privacy zones strip points from exports and share cards. Settings → Delete all data erases everything.
