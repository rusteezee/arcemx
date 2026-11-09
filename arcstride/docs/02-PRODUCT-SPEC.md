# ArcStride — product spec & honest status

Working name: **ArcStride** (single constant in `index.html` / `App.tsx` / `share.ts` if you want to rename it).
Design system: **ArcArmor System A — "Arc'emX! Product System"** (see `README.md` → *Design-system compliance*).
Research basis: `01-STRAVA-TEARDOWN.md`.

Status legend: **Built** = implemented and exercised by tests or the browser walkthrough · **Partial** = works with a stated limit · **Needs server/native** = cannot be done honestly client-side · **Roadmap**.

## 1. Strava feature → ArcStride

| Strava feature (free / paid) | ArcStride | Status | Notes |
|---|---|---|---|
| Record activity (phone GPS) | `/record` — browser Geolocation, auto-pause, wake-lock, crash-recovery draft | **Built** (tested with mocked GPS in Chromium) | Not tested on a physical phone or iOS Safari. Phone GPS only; no BLE sensors. |
| Upload / sync from devices | GPX, TCX, FIT (Garmin's official SDK), `.gz`, **Strava bulk-export `.zip` + `activities.csv`** (names, sport, gear, notes), duplicate skipping | **Built** | Strava archive format reproduced from the documented layout; not tested against a real archive. No cloud/device sync. |
| Activity page: map + splits + charts | Synced map ↔ multi-panel charts (elevation, pace/speed, HR, power, cadence, W′ bal), hover readout, km/mi splits, colour-by pace/HR/power/grade | **Built** | |
| Relative Effort (paid) | **Load**: power TSS → HR (Banister TRIMP → hrTSS) → pace rTSS → duration fallback; all methods shown side by side | **Built** | Open formulas, user-set zones, history recomputes instantly. |
| Fitness & Freshness (paid) | CTL/ATL/TSB, 6 m–all ranges, forecast | **Built** | Also ACWR, monotony, strain, ramp rate, single-run spike check. |
| Training Log (paid, 30 d free) | Full history; calendar heat; weekly volume by sport and by intensity | **Built** | No paywall. |
| Goals (paid) | Weekly/monthly/yearly goals with projection, needed-per-day, status | **Built** | |
| Power analysis (paid) | NP/IF/VI/TSS, 7 power zones, power curve vs 90 d, **CP + W′**, W′ balance, eFTP | **Built** | |
| Pace analysis / GAP (paid) | **ArcGAP** (Minetti + damped downhill, user-adjustable), NGS, pace zones | **Partial** | Not Strava's proprietary table; formula documented in-app. |
| Segments + leaderboards (paid) | Auto-discovered repeat stretches, effort matching, PR/rank, trend; draw a segment from any chart selection | **Built** for *personal* leaderboards | Community leaderboards **Need a server**. |
| Matched runs/rides (paid) | Route grouping + per-route trend + **ghost compare** (time delta vs distance) | **Built** | |
| Live Segments (paid) | — | **Needs native/watch** | |
| Personal heatmap (paid) | Canvas heatmap; filters: sport, year, time-of-day, weekday; **explorer tiles** (z14 count, largest square) | **Built** | Basemap tiles are opt-in (CARTO); untested here because the sandbox blocks tile hosts. |
| Night / weekly heatmaps (paid) | Time-of-day and weekday filters | **Built** | |
| Route builder / suggested routes / offline (paid) | — (course *pacing* planner from any GPX/past run is built) | **Needs external routing** | Roadmap: BRouter/OSRM adapter. |
| Athlete Intelligence (paid, mobile) | **Coach Insights**: rule-based, ranked, each with evidence + formula | **Built** | Deterministic by design; not an LLM. |
| Training plans (Runna, extra $) | Periodised plan generator (5K → marathon), VDOT paces, deloads, taper, **adaptive re-plan** from ACWR/Form/compliance | **Built** | Running only. No strength/cycling plans. |
| Beacon (safety) | — | **Needs native** | |
| Privacy zones | Zones applied to GPX export and share cards; local-only storage | **Built** | |
| Gear tracking | Shoes/bikes, mileage from assigned activities, retirement flag | **Built** | |
| Share (stat stickers) | 1080×1350 PNG share card with privacy zones applied | **Built** | |
| Clubs, kudos, feed, challenges (social) | Personal challenges only | **Needs server** | |
| Strength workouts (new 2026) | — | **Roadmap** | |
| Flyover / Year in Sport | — | **Roadmap** | |

## 2. Beyond Strava (not in its paid tier at all)

| Capability | Where | Status |
|---|---|---|
| Daily readiness with transparent score breakdown + check-in (resting HR, HRV, sleep, soreness, mood) | Today | Built (heuristic) |
| Injury-risk signals: ACWR, monotony/strain, single-run spike (Nielsen) | Training | Built |
| What-if load simulator (14 days; presets incl. "my plan") | Training | Built |
| Intensity-distribution analysis (polarised / pyramidal / grey-zone) | Training | Built |
| Aerobic decoupling + efficiency-factor trend | Activity, Performance | Built |
| Race predictor: VDOT + Riegel + *personal exponent*, with range & confidence | Performance | Built |
| Threshold auto-detection that only ever *raises* (never lowers from sub-max data) | Performance | Built |
| LTHR / %HRR / %max zone models | Settings | Built |
| Effort-matched course pacing (cost-weighted splits, negative-split, downhill credit) | Plan → Pacing | Built |
| "Show the math" on every insight/metric; full formula page | everywhere / Settings | Built |
| Full export: CSV, GPX zip (privacy-zoned), JSON backup; delete-everything | Settings | Built |

## 3. Architecture

```
src/lib/parse      gpx · tcx · fit (Garmin SDK, lazy chunk) · archive (zip/gz/csv)
src/lib/analyze    process (streams→summary) · gap · zones · load (TSS, PMC, ACWR…) · efforts (best efforts, MMP, CP/W′)
                   predict (VDOT, Riegel, thresholds) · segments · routes (matching, tiles) · coach (readiness, goals, insights)
                   plan (generator + adapt) · pacing
src/lib/store      db (IndexedDB, in-memory fallback) · store (external store + actions)
src/lib/demo       synthetic athlete (road network, physics rides, Minetti runs, HR drift)
src/ui             kit · charts (Panel, LineChart, BarChart, ZoneBars…) · MapView (canvas, Web-Mercator)
src/pages          Dashboard · Activities · ActivityDetail · Training · Performance · Routes · Plan · Goals · Record · Settings
```

Key design decision — **profile-independent facts are stored; profile-dependent numbers are derived.** Each activity stores histograms (HR per bpm, power per 10 W, GAP per 0.1 m/s), NP/NGS, best efforts and mean-max curves. Load, zone time and the entire PMC are recomputed in milliseconds when a threshold changes. Only the GAP model parameter needs a "Recompute history" (it reads streams from IndexedDB).

## 4. Known limitations and unverified areas

* Demo data is **synthetic**; algorithm outputs on it demonstrate behaviour, not real-athlete accuracy. Reference-value tests cover VDOT (Daniels table at VDOT 50), TSS = 100 at FTP, hrTSS ≈ 100 at LTHR, CP/W′ recovery, CTL steady state.
* GPS elevation is noisy; gain uses smoothing + 2.5 m hysteresis and can differ from barometric totals.
* FIT support is verified via a Garmin-encoder round trip, not with files from every device. Developer fields are ignored.
* Segment/route matching thresholds (30 m / 35 m / 45 m) are reasonable defaults, not tuned on a large real corpus.
* Readiness and injury flags are transparent heuristics — not medical advice.
* Storage is per-browser. Clearing site data deletes the library (export a backup).
