"""Gemini analyzer. Sends signals + news + trends, returns structured market call."""
import os
import json
import google.generativeai as genai
from dotenv import load_dotenv

load_dotenv()

genai.configure(api_key=os.getenv("GEMINI_API_KEY"))
MODEL = "gemini-2.5-flash"

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
  "portfolio_verdicts": [{"ticker": "...", "verdict": "hold|add|trim|exit", "reason": "...", "target": "...", "stop_loss": "..."}],
  "wishlist_signals": [{"ticker": "...", "signal": "buy_now|wait|skip", "entry_zone": "...", "reason": "..."}],
  "global_factors": ["..."],
  "key_news_drivers": ["..."],
  "search_trend_signals": ["..."],
  "reasoning": "2-3 paragraph synthesis",
  "disclaimer": "Not SEBI-registered investment advice. For educational purposes only. Do your own research."
}

If user_holdings empty, return empty portfolio_verdicts.
If user_wishlist empty, return empty wishlist_signals.
"""


def analyze(payload: dict) -> dict:
    model = genai.GenerativeModel(MODEL, system_instruction=SYSTEM_PROMPT,
                                  generation_config={"response_mime_type": "application/json"})
    user_msg = "Analyze this market snapshot and return JSON per schema:\n\n" + json.dumps(payload, default=str)[:120000]
    resp = model.generate_content(user_msg)
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
