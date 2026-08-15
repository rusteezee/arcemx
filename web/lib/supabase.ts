import { createBrowserClient } from "@supabase/ssr";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Session-aware browser client. Reads/writes the auth cookie so queries
// carry the signed-in user's JWT instead of the bare anon key - RLS is
// scoped to the authenticated owner (see db/schema.sql), so an anon-only
// client would get empty results back from every gated table.
export const sb = createBrowserClient(url, key);

export const DEFAULT_UID = process.env.NEXT_PUBLIC_DEFAULT_USER_ID || "default";

export interface Analysis {
  id: number;
  run_at: string;
  market_mood: string;
  nifty_outlook: string;
  sensex_outlook: string;
  short_term_picks: any;
  long_term_picks: any;
  reasoning: string;
  raw_json: any;
}

export interface Holding {
  ticker: string;
  qty: number;
  avg_buy_price: number;
}

export interface WishlistRow {
  ticker: string;
}
