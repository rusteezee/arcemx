# BLUEPRINT 19: INDstocks Execution Layer (real-money orders, staged and gated)

BUILDER: Claude Sonnet, working alone, cold start, cannot ask questions.
(Sonnet because this handles a live-money broker API, credential storage and Telegram
callback flows; precision matters more than speed here.)

GOAL
The bot can place REAL orders on the user's INDstocks account, but only in a staged,
gated way: Stage 1 (read-only: funds, holdings, quotes, instrument lookup) and Stage 2
(manual-confirm: every new paper trade produces a Telegram "Execute / Skip" button; an
order fires ONLY when the user taps Execute). Stage 3 (full auto) is NOT built; it stays
locked behind the Phase B Tier-1 gate and is documented as a future flag only.

CONTEXT THE BUILDER NEEDS (it has no memory of the planning chat)
- Repo: `C:\Users\rahul\Downloads\stock-ai`, branch `master`. Python 3.11 via
  `.venv\Scripts\python.exe` (system python is 3.14, never use bare `python`).
- Files to read first:
  1. `bot/telegram_bot.py`: python-telegram-bot `Application` with `CommandHandler`
     registrations near line 1346; APScheduler already runs an 8:00 AM IST daily sync
     job. You will add commands, a `CallbackQueryHandler`, and two scheduler jobs.
  2. `analyzer/paper_trader.py`: produces `paper_trades` rows (fields used here:
     `id`, `ticker`, `side`, `entered_at`, `fill_px`, `qty`, `target_px`, `stop_px`,
     `status`). Do NOT modify this file.
  3. `db/schema.sql` lines 242-268 (`paper_trades`) and 399-410 (`mcp_tokens`:
     `provider text, user_id text default 'default', tokens jsonb, updated_at`,
     unique(provider, user_id), RLS enabled, no anon policy). Token storage reuses
     this exact table with `provider = 'indstocks'`.
  4. `fetchers/indmoney_mcp.py`: naming conventions for INDmoney-adjacent code.
- INDstocks Trading API facts (verified live 2026-07-13 from api-docs.indstocks.com):
  - Base URL `https://api.indstocks.com`. Headers: `Authorization: <access_token>`
    (raw token, no "Bearer"), `Content-Type: application/json`.
  - Access token: generated MANUALLY at indstocks.com/app/api-trading (no programmatic
    login API); expires every 24 hours; the portal's Access Tokens page also lets the
    user whitelist a static IP.
  - Costs: API access free; brokerage flat ₹5 per order. Rate limits: 10 orders/sec,
    100 API calls/sec.
  - Endpoints used here:
    - `GET /funds` (available/utilized balance)
    - `GET /portfolio/holdings`
    - `GET /market/quotes/ltp` (last traded price)
    - `GET /market/instruments` (instrument master CSV; maps symbol to `security_id`)
    - `POST /smart/order` (multi-leg GTT: entry + stop-loss + target in one order)
    - `POST /smart/order/cancel` (`{"order_id", "segment"}`)
    - `GET /order-book`
  - `POST /smart/order` request body (exact field names):
    ```json
    {
      "txn_type": "BUY", "exchange": "NSE", "segment": "EQUITY", "product": "CNC",
      "order_type": "LIMIT", "validity": "DAY", "security_id": "<from instrument master>",
      "qty": 1, "algo_id": "99999", "limit_price": 0.0,
      "sl_trigger_price": 0.0, "sl_limit_price": 0.0,
      "tgt_trigger_price": 0.0, "tgt_limit_price": 0.0
    }
    ```
    `algo_id` is the literal string "99999" for NSE. If `sl_trigger_price` is sent,
    `sl_limit_price` is mandatory; same for the tgt pair. Response:
    `{"status": "success", "data": {"order_data": [{"order_id": "EQ-...",
    "order_status": "CREATED", "child_order_details": {...}}]}}`. Pure MARKET orders
    are auto-converted to LIMIT at live price by the broker.
- Ticker mapping: repo tickers are yfinance-form (`RELIANCE.NS`). INDstocks instrument
  master keys on the NSE symbol root (`RELIANCE`). Root = `ticker.split(".")[0]`.
- Gotchas:
  - Supabase clients cannot run DDL; new tables go in `db/schema.sql` AND the final
    report tells the user to paste them into Supabase SQL Editor.
  - Telegram legacy Markdown: no literal underscores in display text. No emojis, no
    em dashes (U+2014) anywhere (AGENTS.md).
  - paper_trader runs in GitHub Actions; the bot runs on Render/Oracle. They share no
    process. The confirm flow therefore POLLS `paper_trades` from the bot side; do not
    touch the Actions workflows.
  - Short-side paper trades (blueprint 11, `side` values other than long) are
    honesty-tagged idealized trades and must NEVER produce a real order proposal.

CONSTRAINTS
- Must stay inside: `fetchers/indstocks_api.py` (new), `bot/telegram_bot.py`,
  `db/schema.sql` (append only), `.env.example`, `README.md` (one new section).
- Must not change: `analyzer/paper_trader.py`, `analyzer/backtest.py`, any workflow,
  any existing table, the INDmoney MCP sync code.
- Stack to respect: requests, supabase-py, python-telegram-bot, APScheduler (all already
  in requirements.txt). No new dependencies.
- Non-negotiables (safety rails, hard-coded, not configurable away):
  - `INDSTOCKS_EXEC_MODE` env: `off` (default) | `confirm`. The value `auto` must be
    REJECTED at startup with a log line naming the Phase B Tier-1 + DSR gate. Do not
    implement auto execution.
  - Long side only. `product` locked to `CNC`, `segment` to `EQUITY`, `exchange` to
    `NSE`, `is_amo` never set. No DERIVATIVE, no MARGIN, no INTRADAY.
  - Per-order notional cap `INDSTOCKS_MAX_ORDER_INR` (default 5000). Daily placed-order
    cap `INDSTOCKS_MAX_DAILY_ORDERS` (default 3).
  - Every order requires an explicit button tap in this design. No code path may place
    an order without a fresh human tap.
  - The access token is a live trading credential: never log it, never echo it back,
    never write it to a file; it lives only in `mcp_tokens` (RLS, no anon policy).
  - No em dashes; run `python scripts/strip_emdash.py` when done.

STEP-BY-STEP PLAN (in build order)

1. `db/schema.sql`. Append:
   ```sql
   -- Blueprint 19: symbol root -> INDstocks security_id, filled lazily from the
   -- instrument master CSV so we never bulk-load ~100k rows into Supabase.
   create table if not exists instrument_map (
       id bigserial primary key,
       symbol_root text not null unique,
       security_id text not null,
       exchange text not null default 'NSE',
       updated_at timestamptz default now()
   );

   -- Blueprint 19: every real-order proposal and its outcome. One row per
   -- paper_trade proposed; status: proposed | skipped | placed | failed | cancelled.
   create table if not exists real_orders (
       id bigserial primary key,
       paper_trade_id bigint references paper_trades(id) on delete set null,
       ticker text not null,
       security_id text,
       qty integer,
       limit_price numeric,
       sl_price numeric,
       tgt_price numeric,
       order_id text,
       status text not null default 'proposed',
       error text,
       proposed_at timestamptz default now(),
       acted_at timestamptz,
       meta jsonb
   );
   create index if not exists idx_real_orders_status on real_orders(status, proposed_at desc);

   -- Blueprint 19: single-row runtime halt switch for the execution layer.
   create table if not exists exec_state (
       id int primary key default 1,
       halted boolean not null default false,
       updated_at timestamptz default now()
   );
   insert into exec_state (id, halted) values (1, false) on conflict (id) do nothing;

   alter table instrument_map enable row level security;
   alter table real_orders    enable row level security;
   alter table exec_state     enable row level security;
   ```
   No anon policies (service key bypasses RLS; nothing here is dashboard-facing).

2. `fetchers/indstocks_api.py` (NEW). Thin client, requests only, ~150 lines:
   - `BASE = "https://api.indstocks.com"`.
   - `class IndstocksClient:` constructed with a supabase client. Methods:
     - `_token(self) -> str | None`: read `mcp_tokens` where provider='indstocks',
       user_id='default'; return `tokens["access_token"]`; None if missing or
       `updated_at` older than 24h (stale token = act as unauthenticated).
     - `_headers(self)`: `{"Authorization": token, "Content-Type": "application/json"}`.
     - `store_token(self, token: str)`: upsert `{"provider": "indstocks",
       "user_id": "default", "tokens": {"access_token": token},
       "updated_at": now_iso}` on conflict `provider,user_id`.
     - `token_age_hours(self) -> float | None`.
     - `funds(self) -> dict`, `holdings(self) -> list`, `order_book(self) -> list`:
       simple GET wrappers, 15s timeout, raise `IndstocksError(str)` on non-200 with
       the response text TRUNCATED to 200 chars (tokens never appear in responses,
       but truncate anyway).
     - `ltp(self, security_id: str) -> float | None`: GET `/market/quotes/ltp`.
       The exact query param name is undocumented in our notes; try
       `params={"security_id": security_id, "exchange": "NSE", "segment": "EQUITY"}`
       first and tag `ASSUMPTION:` in the build report with whatever shape worked
       against the real API (the builder may not be able to verify without a token;
       then keep the shape above and the ASSUMPTION tag).
     - `resolve_security_id(self, symbol_root: str) -> str | None`: check
       `instrument_map` first; on miss, download `GET /market/instruments` (CSV),
       stream-parse WITHOUT loading into Supabase, find the row where the symbol
       column equals `symbol_root`, exchange NSE, equity series; upsert into
       `instrument_map`; return the id. CSV column names are undocumented in our
       notes: detect the symbol / security_id columns by header inspection at runtime
       (look for headers containing "symbol"/"trading" and "security"/"id"); tag
       `ASSUMPTION:` with the actual headers found.
     - `place_gtt_buy(self, security_id, qty, limit_price, sl, tgt) -> dict`:
       POST `/smart/order` with the exact body from CONTEXT: txn_type BUY, exchange
       NSE, segment EQUITY, product CNC, order_type LIMIT, validity DAY,
       algo_id "99999", limit_price, sl_trigger_price=sl, sl_limit_price=round(sl*0.998, 1),
       tgt_trigger_price=tgt, tgt_limit_price=round(tgt*0.998, 1), qty. Return the
       first element of `data["order_data"]`.
     - `cancel_order(self, order_id: str) -> dict`: POST `/smart/order/cancel` with
       `{"order_id": order_id, "segment": "EQUITY"}`.

3. `bot/telegram_bot.py`. Add module-level: `EXEC_MODE = os.getenv("INDSTOCKS_EXEC_MODE",
   "off").lower()`, `MAX_ORDER_INR = float(os.getenv("INDSTOCKS_MAX_ORDER_INR", "5000"))`,
   `MAX_DAILY_ORDERS = int(os.getenv("INDSTOCKS_MAX_DAILY_ORDERS", "3"))`. At startup,
   if `EXEC_MODE == "auto"`: log
   `"INDSTOCKS_EXEC_MODE=auto is locked behind the Phase B Tier-1 + DSR gate; falling back to off"`
   and set EXEC_MODE to "off".

4. `bot/telegram_bot.py`. New commands (register in the handler block near line 1346):
   - `/token_ind <TOKEN>`: store via `IndstocksClient.store_token`, then IMMEDIATELY
     `await update.message.delete()` (the token must not sit in chat history), then
     send: `"INDstocks token stored. Valid ~24h. Never share this token; if leaked,
     revoke it at indstocks.com/app/api-trading."` If no argument: reply with usage
     `"Usage: /token_ind YOURTOKEN (message is auto-deleted after storing)"`.
   - `/exec_status`: show EXEC_MODE, token age (hours, or "no token"), halted flag,
     orders placed today vs cap, funds available (or "auth failed").
   - `/halt`: set exec_state.halted=true, reply "Execution halted. /resume to re-arm."
   - `/resume`: set halted=false, reply "Execution re-armed."

5. `bot/telegram_bot.py`. Proposal poller, APScheduler job every 5 minutes between
   09:15 and 15:30 IST, Monday-Friday (use the same scheduler instance as the existing
   8 AM sync job). Body, in order, all-or-skip per trade:
   1. Return immediately unless EXEC_MODE == "confirm".
   2. Return if exec_state.halted.
   3. Return if `IndstocksClient.token_age_hours()` is None or > 24.
   4. Count today's real_orders with status='placed'; return if >= MAX_DAILY_ORDERS.
   5. Select paper_trades where status='open', side='long' (accept 'long'/'buy'
      spellings; check what paper_trader actually writes and match it), entered_at
      within the last 45 minutes, and id NOT already present in real_orders
      (any status). For each:
      - qty = floor(min(MAX_ORDER_INR, fill_px * qty_paper) / fill_px); skip with a
        real_orders row status='skipped', error='above cap' if qty < 1.
      - Insert real_orders row status='proposed' (ticker, paper_trade_id, qty,
        limit_price=fill_px, sl_price=stop_px, tgt_price=target_px).
      - Send Telegram message (legacy Markdown, no emoji):
        ```
        *Trade Proposal {real_order_id}*
        BUY {SYMBOL_ROOT} x {qty} at ~₹{fill_px}
        Target ₹{target_px} · Stop ₹{stop_px}
        Notional ₹{qty*fill_px:,.0f} + ₹5 brokerage
        ```
        with `InlineKeyboardMarkup` of two buttons:
        `InlineKeyboardButton("Execute", callback_data=f"exec:{real_order_id}")` and
        `InlineKeyboardButton("Skip", callback_data=f"skipexec:{real_order_id}")`.

6. `bot/telegram_bot.py`. `CallbackQueryHandler` (register with
   `app.add_handler(CallbackQueryHandler(exec_callback, pattern=r"^(exec|skipexec):"))`):
   - Parse action + real_order_id. Load the row; if status != 'proposed', answer
     callback with "Already handled." and stop.
   - `skipexec`: set status='skipped', acted_at=now; edit message appending "Skipped."
   - `exec`, in order:
     1. Re-check: EXEC_MODE == confirm, not halted, token fresh, daily cap not hit.
        Any failure: status='skipped', error=reason, edit message with the reason.
     2. If `proposed_at` older than 45 minutes: status='skipped', error='expired',
        edit message "Proposal expired."
     3. `resolve_security_id(root)`; failure: status='failed', error, edit message.
     4. Fresh `ltp(security_id)`; if |ltp - limit_price| / limit_price > 0.02:
        status='skipped', error='moved >2%', edit message
        "Price moved more than 2% since proposal. Skipped."
     5. `place_gtt_buy(security_id, qty, limit_price=ltp, sl=sl_price, tgt=tgt_price)`.
        Success: store order_id, status='placed', acted_at; edit message appending
        "Placed. Order {order_id}." Failure: status='failed', error (truncated);
        edit message "Order failed: {error}".
   - Always `await query.answer()` first (Telegram requirement).

7. `bot/telegram_bot.py`. Token reminder job: APScheduler daily 08:15 IST; if
   EXEC_MODE != "off" and token missing or older than 20h, send:
   `"INDstocks token is stale. Generate a new one at indstocks.com/app/api-trading and send /token_ind NEWTOKEN"`.

8. `.env.example`. Append:
   ```
   INDSTOCKS_EXEC_MODE=off
   INDSTOCKS_MAX_ORDER_INR=5000
   INDSTOCKS_MAX_DAILY_ORDERS=3
   ```

9. `README.md`. Add a section "Real-order execution (INDstocks)" after the INDmoney
   import section, stating exactly: staged design (off / confirm; auto locked behind
   the Phase B Tier-1 + DSR gate), the daily token routine (portal generates, /token_ind
   stores, message auto-deleted, ~24h validity), the IP note ("if the API rejects calls
   from the bot host, whitelist the host's static IP on the portal's Access Tokens
   page"), the caps, /halt /resume /exec_status, ₹5 flat brokerage per order, and the
   existing not-SEBI-registered disclaimer applies doubly to real orders.

10. Run `python scripts/strip_emdash.py` from repo root, then
    `.venv\Scripts\python.exe -m py_compile fetchers/indstocks_api.py bot/telegram_bot.py`.

EXACT INPUTS TO USE
- Files to open or create, by name: `fetchers/indstocks_api.py` (create),
  `bot/telegram_bot.py`, `db/schema.sql`, `.env.example`, `README.md`,
  `analyzer/paper_trader.py` (read only), `fetchers/indmoney_mcp.py` (read only).
- The one prompt to hand the builder: "Open blueprints/19-indstocks-execution-layer.md
  in C:\Users\rahul\Downloads\stock-ai and build it exactly as written, steps 1-10 in
  order. Read the files under CONTEXT first. NEVER place a real order during the build;
  test the placement path only with a mocked requests.post. Do not touch files outside
  CONSTRAINTS."
- Values verbatim: base URL, header shape, the /smart/order body, algo_id "99999",
  caps 5000 / 3, the 45-minute expiry, the 2% move abort, the 24h/20h token thresholds,
  all message texts above, the DDL block.

DEFINITION OF DONE (checklist, every box pass or fail)
[ ] `.venv\Scripts\python.exe -m py_compile` passes on both Python files.
[ ] NO real order was placed during the build (the placement path was exercised only
    with a mocked requests.post; state this explicitly in the report).
[ ] With EXEC_MODE unset (off), the poller and callbacks are inert: /exec_status says
    mode off, no proposals are generated.
[ ] /token_ind stores the token, the user's message is deleted, and the token string
    appears nowhere in logs or replies.
[ ] /halt makes the poller skip; /resume re-arms (verify via exec_state row flips).
[ ] A paper_trades row older than 45 minutes never produces a proposal; a short-side
    row never produces a proposal.
[ ] The mocked-place test proves: daily cap enforced, 2% move abort works, sl_limit
    and tgt_limit are auto-derived, algo_id "99999" present in the body.
[ ] db/schema.sql has the three tables + RLS; final report tells the user to paste the
    DDL into Supabase SQL Editor and to generate the first token from
    indstocks.com/app/api-trading.
[ ] EXEC_MODE=auto falls back to off with the gate-naming log line.
[ ] No emoji, no em dash in the diff; nothing outside CONSTRAINTS touched.

IF SOMETHING IS UNCLEAR (anti-stall)
Make the smallest safe assumption, write it at the top of the output as "ASSUMPTION: ...",
and keep going. EXCEPTION: anything that would place, modify, or cancel a real order
outside the mocked test is not a permissible assumption; leave it unbuilt and flag it.
Never stall, never ask, never invent big new scope.
