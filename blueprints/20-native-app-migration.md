# Blueprint 20: native app migration (widgets, biometric, push, Telegram elimination)

BUILDER: not yet - this blueprint is at the RESEARCH stage, not build-ready. Unlike
every other blueprint in this folder, the STEP-BY-STEP PLAN section below is
deliberately incomplete: real architecture decisions (notification backend, widget
data flow, command-by-command Telegram replacement, cutover sequencing) haven't been
made yet. Written 2026-08-16 to capture platform-capability research done so far,
so nothing has to be re-researched cold when this gets picked up later.

---

GOAL
Replace the PWA-only web dashboard + Telegram bot with a native-wrapped app that adds
interactive push notifications (informational + actionable, e.g. trade-proposal
Execute/Skip), biometric/PIN unlock, and home-screen interactive widgets - and moves
every Telegram-only control action (buy/sell, wishlist edit, halt/resume execution,
real-order approval, token refresh) into the app itself, so Telegram is no longer
needed at all.

CONTEXT THE BUILDER NEEDS (it has no memory of the planning chat)

- Files to read first: `web/` (existing Next.js 16 PWA - already has `manifest.ts`,
  `proxy.ts` owner-only auth wall, `sw.js` service worker, built 2026-08-15/16),
  `bot/telegram_bot.py` (current control surface + notification sender).
- The full Telegram command surface being replaced (`bot/telegram_bot.py`, handler
  registrations at the bottom of `main()`): `/start /help /today /nifty /sensex
  /stock /portfolio /wishlist /buy /sell /add_wish /rm_wish /alert /alerts /rm_alert
  /import /sync_indmoney /sync /trade_status /trade /backtest /token_ind /exec_status
  /halt /resume /real_open /close_order`, plus two `CallbackQueryHandler`s (exec
  proposal Execute/Skip, close-position confirm) and a document-upload handler.
  Some of these already have web equivalents (read-only pages exist for portfolio/
  wishlist/backtest/etc); the WRITE actions and the interactive trade-approval flow
  currently exist ONLY in Telegram.
- The bot was just hardened 2026-08-16 (commit `2911377`): every handler is now
  gated behind a single owner-only guard (`_owner_only_guard`, `group=-1`,
  `TELEGRAM_CHAT_ID` env var). Whatever cutover plan gets built here should assume
  that hardening stays in place as a safety net during a transition period, not a
  flag-day switch that kills Telegram before the app has full parity.
- Platform capability research done 2026-08-16 (WebSearch, current at that date -
  re-verify before building, this space moves fast):
  - **Push notifications with action buttons** - mature, well-supported on Android
    Chrome PWA via the Notifications API's `actions` field + service worker
    `notificationclick` event handling. This is the mechanism that can replicate
    Telegram's inline Execute/Skip buttons on trade proposals. No native wrapper
    required for this piece alone.
  - **Biometric/PIN unlock** - WebAuthn platform authenticators (fingerprint/face)
    are mature on Android Chrome PWA via `navigator.credentials`. No native wrapper
    required for this piece alone.
  - **Device sensors** - researched and explicitly ruled out. The only real fintech
    sensor use case found is insurance telematics (accelerometer/gyroscope/GPS
    fused to detect driving behavior for usage-based premiums) - doesn't apply to a
    stock-market dashboard. Do not build sensor features; no genuine use case
    exists for this app.
  - **Home screen interactive widgets** - confirmed NOT possible in the web
    platform at all, no manifest spec, nothing shipping as of 2026. Real Android
    home screen widgets require a native App Widget provider (Kotlin/Java). This is
    the one piece that forces a native wrapper - likely a TWA (Trusted Web
    Activity) via Bubblewrap (Google's official TWA scaffolding tool), wrapping the
    existing PWA rather than a full rewrite, with a genuinely native widget
    provider talking to the same backend.

CONSTRAINTS
- Must stay inside: `web/` for the wrapped PWA content; a new native shell project
  (TWA via Bubblewrap) for the widget provider specifically - don't rewrite the
  whole app natively, only what widgets require.
- Must not regress: the owner-only auth wall (`web/proxy.ts`, RLS policies in
  `db/schema.sql`) built 2026-08-15/16, or the Telegram bot's owner-only guard
  (`bot/telegram_bot.py`, commit `2911377`) - keep both until the app has proven
  parity.
- Stack to respect: Next.js 16 App Router, Supabase (Postgres + Auth), existing PWA
  service worker pattern.
- Non-negotiables: ₹0 recurring cost is a hard rule (see repo-wide facts below).
  TWA/Bubblewrap itself is free; a Play Store developer account is a one-time $25
  fee, not recurring, but still must be flagged to the user and approved, never
  assumed.

STEP-BY-STEP PLAN (in build order)
NOT WRITTEN YET - open questions below need answers first. Once resolved, expect
this to become a real phased plan roughly in this shape: (1) push notification
backend + service worker actions, replacing Telegram's proactive pushes, (2)
web-UI equivalents for the currently-Telegram-only write actions, (3) biometric
unlock on top of the existing Google/password auth, (4) TWA wrap + native widget
provider, (5) monitored dual-channel transition period, (6) Telegram cutover.

OPEN QUESTIONS (resolve before this is build-ready)
- Notification backend: does the Python backend (analyzer/grader) send Web Push
  directly (VAPID keys + a `pywebpush`-style library) replacing `bot.send_message`
  calls, or route through a separate service? Needs its own research pass.
- Exact widget content/design - what does the home screen widget actually show
  (today's mood call? open positions? nothing decided yet).
- Command-by-command mapping: for each of the ~25 Telegram commands above, what's
  the app-side equivalent UI, and which (if any) genuinely don't need one?
- Cutover sequencing: how long does Telegram stay live in parallel once the app has
  nominal parity, and what's the actual go/no-go bar before turning it off?
- TWA/Bubblewrap setup specifics - signing key management, Play Store listing
  process, update mechanism (TWA still needs Play Store review turnaround, unlike
  a PWA's instant redeploy).

EXACT INPUTS TO USE
Not applicable yet - no builder kickoff prompt until the open questions above are
resolved.

DEFINITION OF DONE (checklist. every box pass or fail)
Not applicable yet - this blueprint isn't build-ready. Revisit this section once
the open questions are resolved and a real step-by-step plan exists.

IF SOMETHING IS UNCLEAR (anti-stall)
Not applicable at the research stage - if picking this up to move it toward
build-ready, resolve the OPEN QUESTIONS above with the user rather than guessing;
they involve real product decisions (what a widget shows, how long Telegram stays
live), not implementation details a builder should invent.

---

## Repo-wide facts every builder must know (restated from `_TEMPLATE.md`)

- Repo: `C:\Users\rahul\Downloads\Arc'emX!`, GitHub `rusteezee/arcemx`, branch `master`.
  (Renamed from `stock-ai` 2026-08-15 - older blueprints may still say the old path.)
- Python 3.11 via `.venv\Scripts\python.exe` (system python is 3.14. never use bare `python`).
- Supabase Postgres; Python/JS clients CANNOT run DDL. Any `CREATE TABLE`/`ALTER` goes in
  `db/schema.sql` AND is given to the user to paste into Supabase's SQL Editor.
- ₹0 recurring cost is a hard rule. One-time spends must be flagged to the user, never assumed.
- Verify live after deploy, don't just trust compiled/committed code - established doctrine,
  reinforced repeatedly across this project's sessions.
