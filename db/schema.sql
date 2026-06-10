-- Run in Supabase SQL Editor

create table if not exists prices (
    id bigserial primary key,
    ticker text not null,
    ts timestamptz not null default now(),
    open numeric, high numeric, low numeric, close numeric, volume bigint,
    unique(ticker, ts)
);
create index if not exists idx_prices_ticker_ts on prices(ticker, ts desc);

create table if not exists news (
    id bigserial primary key,
    source text,
    title text not null,
    url text unique,
    summary text,
    published_at timestamptz,
    sentiment numeric,
    tickers text[],
    fetched_at timestamptz default now()
);
create index if not exists idx_news_pub on news(published_at desc);

create table if not exists trends (
    id bigserial primary key,
    keyword text not null,
    interest int,
    ts timestamptz default now()
);

create table if not exists analysis (
    id bigserial primary key,
    run_at timestamptz default now(),
    market_mood text,
    nifty_outlook text,
    sensex_outlook text,
    short_term_picks jsonb,
    long_term_picks jsonb,
    reasoning text,
    raw_json jsonb
);

create table if not exists portfolio (
    id bigserial primary key,
    user_id text not null default 'default',
    ticker text not null,
    qty numeric not null,
    avg_buy_price numeric not null,
    added_at timestamptz default now(),
    unique(user_id, ticker)
);

create table if not exists wishlist (
    id bigserial primary key,
    user_id text not null default 'default',
    ticker text not null,
    added_at timestamptz default now(),
    unique(user_id, ticker)
);

-- Full historical buy/sell ledger. Imported from the user's INDmoney
-- "Transactions Report" XLSX exports so the Portfolio Value Timeline can
-- replay total portfolio value over time (including positions later
-- sold off, which the snapshot-based `portfolio` table can't show).
create table if not exists transactions (
    id bigserial primary key,
    user_id text not null default 'default',
    execution_date timestamptz not null,
    scrip_symbol text not null,
    ticker text not null,
    scrip_name text,
    isin text,
    side text not null check (side in ('BUY','SELL')),
    qty numeric not null,
    price numeric not null,
    exchange text,
    order_id text,
    order_status text,
    source text default 'indmoney_xlsx',
    fetched_at timestamptz default now(),
    unique(user_id, order_id)
);
create index if not exists idx_tx_user_date on transactions(user_id, execution_date);
create index if not exists idx_tx_user_ticker on transactions(user_id, ticker);

-- Grader output (documented from the live DB; these two tables were created
-- out of band in an earlier session and were missing from this file).
-- prediction_scores: one row per (analysis, dimension, horizon), upserted
-- idempotently by analyzer.grader on every pass. The unique constraint is
-- what makes the dual GH-cron + in-bot-APScheduler grading safe.
create table if not exists prediction_scores (
    id bigserial primary key,
    analysis_id bigint references analysis(id),
    dimension text not null,
    horizon_days int not null,
    predicted jsonb,
    actual jsonb,
    score double precision,
    delta double precision,
    notes text,
    scored_at timestamptz default now(),
    unique(analysis_id, dimension, horizon_days)
);
create index if not exists idx_pred_scores_dim on prediction_scores(dimension, analysis_id);

-- accuracy_summary: append-only snapshots per (window, dimension) written by
-- analyzer.grader.compute_summaries after each grading pass. Readers
-- (feedback, sensei, dashboard) take the newest row per key by computed_at.
create table if not exists accuracy_summary (
    id bigserial primary key,
    computed_at timestamptz default now(),
    window_days int not null,
    dimension text not null,
    accuracy_pct double precision,
    avg_delta double precision,
    sample_size int,
    bias jsonb
);
create index if not exists idx_acc_summary_at on accuracy_summary(computed_at desc);

-- EOD retrospective written by analyzer.sensei after market close + grader run.
-- One row per market-close date. Tomorrow's morning analysis reads the latest
-- row via aggregator (sensei_yesterday) so the model goes into the next call
-- with explicit retrospection on yesterday's misses / wins.
create table if not exists sensei_eod (
    id bigserial primary key,
    run_at timestamptz default now(),
    analysis_id bigint references analysis(id),
    market_close_date date not null unique,
    model_used text,
    raw_json jsonb not null,
    what_worked jsonb,
    what_missed jsonb,
    conviction_review jsonb,
    key_insights jsonb,
    tomorrow_watch jsonb,
    calibration_note text,
    insight_quality_avg numeric
);
create index if not exists idx_sensei_eod_date on sensei_eod(market_close_date desc);

-- Calculator runs: persist deterministic prefilter output + the LLM
-- enrichment that wraps macro / news / catalyst rationale around each
-- pick. The bot inserts a row with status='pending' on /trigger/calc-explain
-- and updates it to 'ok' or 'failed' once the LLM call completes.
-- Frontend polls by id until status != 'pending'.
create table if not exists calculator_runs (
    id bigserial primary key,
    run_at timestamptz default now(),
    input_json jsonb not null,
    deterministic_json jsonb not null,
    llm_json jsonb,
    model_used text,
    status text not null default 'pending',
    error text
);
create index if not exists idx_calculator_runs_status on calculator_runs(status, run_at desc);

-- Portfolio scorecard LLM enrichment runs (Phase 9b). Mirrors
-- calculator_runs. Frontend posts deterministic snapshot via bot
-- /trigger/portfolio-score, polls by id until status != 'pending'.
create table if not exists portfolio_score_runs (
    id bigserial primary key,
    run_at timestamptz default now(),
    deterministic_json jsonb not null,
    llm_json jsonb,
    model_used text,
    status text not null default 'pending',
    error text
);
create index if not exists idx_portfolio_score_runs_status on portfolio_score_runs(status, run_at desc);
