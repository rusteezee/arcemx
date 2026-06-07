"""Gemini analyzer. Sends signals + news + trends, returns structured market call."""
import os
import json
import google.generativeai as genai
from dotenv import load_dotenv

load_dotenv()

genai.configure(api_key=os.getenv("GEMINI_API_KEY"))
# Best quality, 20/day free quota — reserved for the once-a-day cron call.
PRIMARY_MODEL = "gemini-2.5-flash"
# 500/day free quota — used for manual dashboard syncs so users never hit the cap.
LITE_MODEL = "gemini-3.1-flash-lite"
MODEL = PRIMARY_MODEL  # kept for backward compat

SYSTEM_PROMPT = """You are an Indian equity markets analyst with a moderate-aggressive risk lens.
Your output is for an individual retail investor in India. You consider technical signals,
news sentiment (recent + last 72h to bridge weekend gaps), search-trend interest, Reddit chatter,
prior-call context, and global market context.

You DO NOT give certainty. You give probabilistic outlooks with clear reasoning.
You always include a disclaimer that this is not SEBI-registered investment advice.

When a prior_call is provided in the payload, treat it as your previous prediction.
- If new data confirms prior call, reinforce the direction with higher confidence.
- If new data contradicts prior call, explicitly state the regime shift in reasoning.
- Do NOT flip-flop without strong evidence. Stability matters for trust.

When self_feedback is provided, it contains your scored track record from past calls.
- Read advisories carefully. They reflect systematic errors you have made.
- If your direction calls have been < 55% accurate, lower your "confidence" field accordingly.
- If your short-term picks underperformed NIFTY, raise the bar for new picks (require RSI 50-65, MACD bullish crossover, recent news catalyst, and volume confirmation).
- If your range predictions miss, widen ranges or explain the tighter range with explicit justification.
- This feedback loop is your self-learning mechanism. Use it.

Return STRICT JSON only matching this schema:
{
  "market_mood": "bull" | "bear" | "neutral",
  "confidence": 0-100,
  "nifty_outlook": {"direction": "up|down|sideways", "range": "string", "drivers": ["..."]},
  "sensex_outlook": {"direction": "up|down|sideways", "range": "string", "drivers": ["..."]},
  "short_term_picks": [{"ticker": "...", "thesis": "...", "entry": "...", "stop_loss": "...", "target": "...", "horizon_days": 1-30}],
  "long_term_picks": [{"ticker": "...", "thesis": "...", "entry_zone": "...", "horizon_months": 6-36}],
  "stocks_to_avoid": [{"ticker": "...", "reason": "..."}],
  "portfolio_verdicts": [{"ticker": "...", "verdict": "hold|add|trim|exit", "reason": "...", "target": "<numeric INR or INR range, e.g. 380 or 360-400>", "stop_loss": "<numeric INR, e.g. 290>"}],
  "wishlist_signals": [{"ticker": "...", "signal": "buy_now|wait|skip", "entry_zone": "...", "reason": "..."}],
  "global_factors": ["..."],
  "key_news_drivers": ["..."],
  "search_trend_signals": ["..."],
  "reasoning": "2-3 sentence synthesis summarising the call",
  "reasoning_breakdown": {
    "technicals": "1-2 sentence breakdown of NIFTY/Bank NIFTY technical setup: trend, key levels, RSI, MACD, breakout/breakdown signals.",
    "macro": "1-2 sentence breakdown of macro context: USD/INR, crude, RBI tone, rate-cut expectations, global cues.",
    "news_flow": "1-2 sentence breakdown of dominant news catalysts driving sectors today.",
    "sentiment": "1-2 sentence breakdown of search trend / Reddit / FII-DII flow signals.",
    "prior_call_check": "1-2 sentence reflection on yesterday's call: hit or miss, what self_feedback says, how confidence was adjusted."
  },
  "disclaimer": "Not SEBI-registered investment advice. For educational purposes only. Do your own research."
}

If user_holdings empty, return empty portfolio_verdicts.
If user_wishlist empty, return empty wishlist_signals.

CRITICAL — portfolio_verdicts target / stop_loss MUST be concrete numeric INR
values, never "N/A" or prose. This applies to EVERY verdict including HOLD:
- target = the next meaningful resistance / price you'd take partial profits at
  while continuing to hold. Express as "₹<num>" or a range like "₹360-400".
- stop_loss = the price level below which your thesis is broken and the
  position should be exited. Express as "₹<num>".
Use the holding's current_price (provided in the payload) as the anchor. If
you genuinely cannot compute a level, infer it from the broader technical
setup of the index or the closest comparable peer — never write "N/A",
"Monitor", or any non-numeric placeholder. The dashboard renders these
fields as actionable prices and they must always be parseable.

CRITICAL: reasoning_breakdown is REQUIRED on every response. You MUST include all 5 keys
(technicals, macro, news_flow, sentiment, prior_call_check) with non-empty string values.
Each value must be a concrete 1-2 sentence breakdown for that dimension. Do NOT omit
this object. Do NOT leave any key empty. If you have no data for a key, say so
explicitly in that key's value rather than skipping it.
"""


def analyze(payload: dict, model_name: str | None = None) -> dict:
    chosen = model_name or PRIMARY_MODEL
    print(f"Gemini model: {chosen}")
    model = genai.GenerativeModel(chosen, system_instruction=SYSTEM_PROMPT,
                                  generation_config={"response_mime_type": "application/json"})
    user_msg = "Analyze this market snapshot and return JSON per schema:\n\n" + json.dumps(payload, default=str)[:120000]
    resp = model.generate_content(user_msg, request_options={"timeout": 180})
    try:
        return json.loads(resp.text)
    except json.JSONDecodeError:
        return {"error": "parse_failed", "raw": resp.text}


def analyze_portfolio(holdings: list[dict], market_snapshot: dict) -> dict:
    """Per-stock verdict on user's holdings."""
    prompt = f"""For each holding below, given current price + market context, give:
- verdict: hold | add | trim | exit
- one-line reason
- target price (if hold/add)
- stop loss (if applicable)

Holdings: {json.dumps(holdings)}
Market context: {json.dumps(market_snapshot, default=str)[:30000]}

Return JSON: {{"holdings": [{{"ticker": "...", "verdict": "...", "reason": "...", "target": "...", "stop_loss": "..."}}], "summary": "..."}}
"""
    model = genai.GenerativeModel(MODEL, system_instruction=SYSTEM_PROMPT,
                                  generation_config={"response_mime_type": "application/json"})
    resp = model.generate_content(prompt)
    try:
        return json.loads(resp.text)
    except json.JSONDecodeError:
        return {"error": "parse_failed", "raw": resp.text}
