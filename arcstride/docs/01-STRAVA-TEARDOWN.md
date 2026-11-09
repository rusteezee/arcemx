# Strava Teardown — what it is, what's paid, how it works, where it's weak

Research date: 2026-11-09. Method: web search (WebSearch). **Strava's own support/engineering pages could not be fetched** (the session's network allowlist blocked `support.strava.com` and `medium.com`), so everything below comes from search-result extracts of those pages plus press, patents and community posts.

Confidence tags: **[S]** = seen in a source this session · **[K]** = background knowledge, *not* re-verified this session · **[?]** = sources disagree or are thin.

> Prices, tier splits and API terms change often. Re-check `strava.com/subscribe` before quoting any of this publicly.

---

## 1. The business in one paragraph

Strava is a freemium social network for GPS workouts. It reportedly passed 150M users in 2025 and is said to exceed 200M by Aug 2026 **[?]**; revenue is estimated near $490M ARR in 2025 with ~90% from subscriptions **[?]** (Sacra estimate, unverified). It reportedly filed confidentially for an IPO in Jan 2026 **[?]**. The strategy is visible in 2025–26 moves: buy a training-plan app (Runna, Apr 2025), rebuild strength training (May + Oct 2026), add hiking tools (Jun 2026), push AI summaries (Athlete Intelligence), and lock down the API (Nov 2024, again Jun 2026). Every new capability ships as **subscriber-only** — the free tier is the social graph; the subscription is the analytics, planning and maps.

## 2. Feature inventory

### 2.1 Free tier **[S/K]**

| Area | What you get |
|---|---|
| Recording | Phone GPS recording, 30+ sport types, device sync (Garmin/Apple/Coros/Wahoo/…) |
| Social | Feed, kudos, comments, follows, clubs, challenges (public ones), photos, group activities |
| Basic stats | Distance, time, pace, elevation, splits, a 30-day summary view **[S]** |
| Segments | Segment discovery, top-10 leaderboard **[S]** |
| Safety | Beacon (live location share to up to 3 contacts) on the phone app **[S — sources conflict on device tier]** |
| Privacy | Privacy zones, hide start/end, per-activity visibility, heatmap/Metro opt-out **[S/K]** |
| Misc | Gear tracking, route *viewing*/saving of others' routes **[K]**, route sync to Apple/Coros/Garmin watches **[S]** |

### 2.2 Subscription (≈ $11.99/mo or $79.99/yr in US; regional prices differ) **[S, third-party, unverified]**

| Category | Features |
|---|---|
| **Training analytics** | **Relative Effort** (HR-based intensity score) · **Fitness & Freshness** (Fitness / Fatigue / Form chart) · **Training Log** (full history, vs. 30-day for free) · **Goals** · **Power analysis** (power curve, zones, distribution, FTP-based training load) · **Pace analysis** (GAP, pace zones) · **Matched Activities** ("Matched Runs/Rides" — repeats of your common routes) · **Advanced filters/search** · **Year in Sport** (moved behind paywall) |
| **Segments** | Full leaderboards + filters (age, weight, date, club) · comparing/analysing your own efforts · **Live Segments** (real-time vs PR / KOM, phone + select devices) · segment goals |
| **Maps & routes** | **Route builder** (web + mobile) · **Suggested routes** from a location · **Route discovery** from heatmaps · **Personal heatmaps** · global heatmap layers incl. **Night** and **Weekly** · **Offline routes** · trail map styles, route saves, **off-route alerts** (Jun 2026) · **Flyover** 3D replay · auto-animated activity replay |
| **AI** | **Athlete Intelligence** — short written post-activity insights, mobile-only, looks at ~30 days for context, "80%+ of polled subscribers find it very helpful" (Strava's own survey) **[S]** |
| **Strength (new)** | Coach-designed guided workouts with live set/rep tracking (Oct 2026), muscle maps, workout log, 14 partner integrations (May 2026) **[S]** |
| **Plans** | Cycling plans on Strava. **Running plans moved to Runna** — not in the standard subscription; **Strava + Runna bundle ≈ $149.99/yr, annual only** **[S]** |
| **Perks** | Partner perks, family plan (shared among several members), student discount, free trial **[S/K]** |

### 2.3 Developer / ecosystem

* **Nov 2024**: API agreement bars third-party apps from showing a user's activities to anyone but that user, and bans using API data in AI models **[S]**.
* **Jun 1, 2026**: new developer program with Standard/Extended tiers; reports say a Strava subscription is required for Standard-tier API access **[S, forum report, unconfirmed against Strava docs]**.
* **Heatmap/privacy history**: the 2017–18 global-heatmap incident exposed military sites; privacy zones and Metro opt-outs are the mitigation, but any *public* activity still feeds the global heatmap **[S]**.

---

## 3. How the key numbers actually work

| Metric | What Strava says / what's known | What we can and cannot know |
|---|---|---|
| **Relative Effort** | Heart-rate time-in-zone, *weighted by intensity*. Zones come from max HR (athlete-entered or estimated). Weights were tuned on ~10k running races to minimise score variance. Swim uses cycling zones with max HR −12 bpm. Customising zones changes the score materially. Requires HR (or perceived-exertion input). Replaced "Suffer Score". **[S]** | Exact coefficients are **not public**. No LTHR support: zones are %max-HR based **[S, third-party]**. |
| **Fitness & Freshness** | Banister impulse–response model, popularised by Coggan. Daily input = Training Load (power) and/or Relative Effort (HR/perceived). Fitness = long-window weighted average (commonly ~42 d), Fatigue = short (~7 d), **Form = Fitness − Fatigue**. **[S, constants from community]** | Constants not published by Strava. Mixed-sport days and missing-data handling are opaque. |
| **Grade Adjusted Pace** | v1 (2014-ish) based on Minetti et al. 2002 energy cost. v2 (Strava engineering "An Improved GAP Model") built from ~6M runs / 240k athletes, 60-second windows, **heart rate as the effort proxy**; downhill benefit bottoms out near **−9 %** (old model: −18 %) and fades back to ×1.0 by −18 %. Patent US 11,623,121. **[S]** | Table of multipliers isn't published; community reverse-engineering exists. |
| **Segment matching** | Patents US 9,116,922 / 9,208,175: an effort is a timestamped GPS series; **two-level (loose then tight) matching**; start/finish found via closest recorded points within a distance, or by virtual-line crossing with extrapolation; R-tree index of segments + bounding-rectangle prefilter. **[S]** | Distance thresholds not public. Poor fix near a line can miss a match (a well-known user complaint). |
| **Power analysis** | Power distribution, zone time from FTP, best-efforts power curve vs all-time, FTP-based training load. **[S, older article]** | FTP estimation method and exact IF/TSS conventions not verified. |
| **Athlete Intelligence** | LLM-style narrative over your recent activity data; mobile only; opaque. **[S]** | Cannot be audited, cannot cite its evidence, not available on web/offline. |

---

## 4. Where Strava is weak (our openings)

1. **Opaque formulas.** Relative Effort, Form, GAP and AI summaries can't be audited. Customise a zone and your history silently changes.
2. **Paywalled basics.** Segment leaderboards beyond top-10, matched runs, full training log, heatmaps, route builder, Year in Sport — all behind ~$80/yr; running plans cost extra on top (≈$150/yr bundle).
3. **No physiology beyond load.** No readiness/recovery model, no HRV/sleep/resting-HR input, no injury-risk or load-spike analytics, no aerobic decoupling/efficiency trend, no critical-power / critical-speed modelling, no race-predictor with uncertainty, no LTHR zones. Competitors (Intervals.icu, TrainingPeaks, Runalyze, GoldenCheetah) cover these; Strava does not.
4. **Closed data.** Tightening API terms (2024, 2026) and a paid gate on API access make Strava a poor *source of truth* for your own history. A bulk export exists but there is no first-class way to keep working with it.
5. **Privacy by exception.** Your public activities feed a global heatmap by default; you opt out, not in. A *local-first* app has no such leak by construction.
6. **Plans are bolted-on.** Running plans moved to a separate app/price; mid-subscription removal angered users **[S]**. Plans don't adapt to an *athlete's measured load* the way a closed-loop system could.
7. **Generic AI.** Insight text is generic; no "show me the evidence", no deterministic repeatability.
8. **Calendar/log gaps.** Users report missing elevation/TSS/monthly totals on the training calendar and thin analytic depth in general **[S, forum]**.

## 5. Strategy for ArcStride ("more advanced than Strava")

**Thesis: Strava is a social network with analytics bolted on. ArcStride is a training-science workbench with your data as the product — local-first, every number explainable, nothing paywalled.**

| Strava capability | ArcStride answer | Beyond Strava |
|---|---|---|
| Relative Effort | **Effort / Load** using power TSS → HR Banister TRIMP → pace rTSS, picked per activity, *all three shown* | Choose zone model (LTHR / HRR / %max), see the math, history recomputes transparently |
| Fitness & Freshness | PMC with CTL/ATL/TSB, ramp rate | **ACWR (EWMA)**, monotony, strain, spike check, **what-if load simulator**, form-aware plan |
| Training Log | Calendar heat + weekly/monthly volume | Zone-stacked weekly load, intensity-distribution (polarisation) analysis |
| GAP / pace analysis | **ArcGAP** (Minetti cost, adjustable downhill credit) + pace zones | Normalised Graded Pace, rTSS, pacing planner for a course |
| Power analysis | Power curve, zones, NP/IF/VI/TSS | **Critical Power + W′**, W′ balance, auto-eFTP, durability |
| Segments + leaderboards | **Auto-discovered segments** from your own history, effort matching, PR timeline | Draw-from-selection segment creation; ghost-compare delta chart. *(Community leaderboards need a server — see §6.)* |
| Matched Runs | **Route matching** across your history, trend of repeats | Per-route progression + compare any two efforts |
| Personal heatmap | Canvas heatmap, filter by sport / year / weekday / time-of-day | **Explorer tiles** (z14 coverage, largest square), no upload to anyone |
| Athlete Intelligence | **Coach Insights**: deterministic rules over your data | Every insight shows its **evidence and formula**; works offline |
| Running plans (via Runna) | **Adaptive plan generator** (VDOT paces, periodisation, deload) | Re-plans from *measured* load/ACWR; compliance tracking |
| Routes / suggested | *Route Lab* via your own repeat routes + course pacing planner | (Online route *builder* needs a routing service — roadmap) |
| Goals / challenges | Goals with pace-to-goal projection; built-in challenges | Projection vs. current run-rate, not just a progress bar |
| Privacy zones | Zones applied to shares & exports | **No cloud**; share cards trim zones; full JSON export |
| (absent) | **Daily check-in** (resting HR, HRV, sleep, soreness) → readiness | Strava has no recovery model at all |
| (absent) | **Race predictor** (Daniels VDOT + personalised Riegel exponent) with range | Strava shows none |
| (absent) | **Strava archive import** (zip/gz/fit/tcx/gpx + activities.csv) | Bring your history in minutes |

## 6. What a client-only app cannot honestly do (and we won't fake)

* **Global/community segment leaderboards, kudos, clubs, follows, feed** — need a backend and users. ArcStride's "leaderboards" are *against your own history*. The data layer is repository-shaped so a sync server can be added.
* **Live Segments / Beacon / watch sync** — need native device APIs and vendor partnerships. The web recorder covers phone GPS only.
* **Turn-by-turn routing/route builder** — needs a routing engine (OSRM/Valhalla/BRouter). Not bundled; roadmap.
* **True barometric elevation / DEM correction, weather, sleep/HRV auto-import** — need device or third-party APIs. GPS elevation is noisy; we smooth and use hysteresis, and say so in the UI.

## 7. Sources

* Biketips — [Strava free vs paid (2026)](https://biketips.com/strava-free-vs-paid/) · Run & Grow — [Is Strava free?](https://www.runandgrow.com/blog/is-strava-free) · Runner's Picks — [Strava pricing 2026](https://www.runnerspicks.com/blog/strava-pricing-is-it-worth-it/)
* Strava Support — [Subscription features](https://support.strava.com/hc/en-us/articles/216917657-Strava-Subscription-Features), [Fitness & Freshness](https://support.strava.com/hc/en-us/articles/216918477-Fitness-Freshness), [Athlete Intelligence](https://support.strava.com/hc/en-us/articles/26786795557005-Athlete-Intelligence-on-Strava), [Training plans for runners](https://support.strava.com/en-us/articles/15401942-training-plans-for-runners) *(seen as search extracts only)*
* Strava Engineering — [Quantifying Effort through Heart Rate Data](https://medium.com/strava-engineering/quantifying-effort-through-heart-rate-data-e6a0e3dd6a52), [An Improved GAP Model](https://medium.com/strava-engineering/an-improved-gap-model-8b07ae8886c3), [Fitness & Freshness Updates](https://medium.com/strava-engineering/fitness-freshness-updates-5d1057d67fac)
* Patents — [US 9,208,175 Defining and matching segments](https://patents.google.com/patent/US9208175), [US 9,116,922](https://patents.google.com/patent/US9116922), [US 11,623,121 GAP model](https://patents.google.com/patent/US11623121)
* The5kRunner — [Relative Effort guide](https://the5krunner.com/2025/11/17/strava-relative-effort-guide-tss-2025), [Strava IPO analysis](https://the5krunner.com/2026/01/09/strava-ipo-filing-3-billion-valuation-analysis/), [Hiking features Jun 2026](https://the5krunner.com/2026/06/12/strava-hiking-features-ipo/), [Guided strength Oct 2026](https://the5krunner.com/2026/10/15/strava-guided-strength-workouts/)
* Wareable — [Strava + Runna combined subscription](https://www.wareable.com/sport/strava-runna-combined-subscription-announcement-price), [Hiking update](https://www.wareable.com/sport/strava-hiking-update-off-route-alerts-offline-route-discovery)
* 9to5Mac — [Coach-designed strength workouts](https://9to5mac.com/2026/10/15/strava-announces-coach-designed-strength-workouts-with-live-set-and-rep-tracking/) · Android Central — [Athlete Intelligence stable](https://www.androidcentral.com/wearables/strava-announces-stable-athlete-intelligence-anti-cheating-and-flyover-sharing) · BikeBiz — [Night & weekly heatmaps](https://bikebiz.com/strava-expands-mapping-tools-with-night-and-weekly-heatmaps/)
* API — [Marathon Handbook](https://marathonhandbook.com/strava-api-changes/), [CyclingNews](https://www.cyclingnews.com/news/strava-plan-to-restrict-third-party-apps-has-users-in-an-uproar), [Intervals.icu forum: Jun 2026 program](https://forum.intervals.icu/t/strava-api-update-new-terms-subs-required-for-api-access/130240)
* Strava history — [2020 paywall: Cycling Weekly](https://www.cyclingweekly.com/news/product-news/strava-overhaul-better-routes-more-training-analysis-leaderboard-for-paying-customers-only-455995) · [Heatmap privacy 2018: The Week](https://theweek.com/91257/strava-fitness-app-reveals-us-military-bases)
* Business — [Sacra](https://sacra.com/research/strava) · [Endurance Sports Wire (IPO)](https://www.endurancesportswire.com/strava-files-for-ipo-as-fitness-apps-chase-subscription-growth/)
