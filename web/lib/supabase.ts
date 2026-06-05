import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const sb = createClient(url, key, {
  auth: { persistSession: false },
});

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
