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
