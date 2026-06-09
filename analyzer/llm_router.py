"""OpenRouter-backed LLM client.

Replaces analyzer.llm (the google.generativeai SDK was deprecated and a
transient 429 on its free tier killed the daily cron). This module:

- Uses OpenRouter's OpenAI-compatible chat.completions endpoint via plain
  HTTPS, so the deprecated SDK is retired entirely.
- Lets OpenRouter route across a `models` fallback chain server-side, so
  one rate-limited primary auto-drops to the next free model in the same
  request instead of failing the run.
- Retries with backoff on a 429 returned by OpenRouter itself.
- Defensively parses JSON: some free models still wrap output in ```json
  fences despite response_format being set.

Free-tier policy at time of writing (June 2026):
  20 req/min; 50 req/DAY at <$10 lifetime credits; failed attempts count
  against the daily quota. Sized for our cron (1/day) + a handful of
  manual syncs. The fallback chain protects against per-minute spikes
  and provider-side throttling on the primary's free endpoint.

Backward compatibility: the same module-level symbols the old llm.py
exported (PRIMARY_MODEL, LITE_MODEL, MODEL, SYSTEM_PROMPT, analyze,
analyze_portfolio) are preserved so callers swap with a one-line import
change. Re-exports SYSTEM_PROMPT from analyzer.llm during transition;
the constant moves here in a follow-up sweep that deletes llm.py.
"""
import os
import json
import time
import requests
from dotenv import load_dotenv

load_dotenv()

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
# Strip whitespace defensively. A trailing newline or space pasted into a
# secrets store (common copy-paste artifact) makes requests reject the
# Authorization header with InvalidHeader, since no real key contains
# whitespace in its content this is safe and universal.
OPENROUTER_KEY = (os.getenv("OPENROUTER_API_KEY") or "").strip()

# Primary: Nemotron 3 Super 120B (free). 120B/12B-active MoE, 1M ctx.
# Selected over Ultra after bake-off on a real payload: Super produced
# a tighter NIFTY range (1.21% vs Ultra 2.16%, 44% narrower) with the
# same full schema compliance and the same honest confidence, faster
# too (7m vs 11m on free tier). Smaller-model-better-instruction-
# follower applies. Ultra stays as backup for harder reasoning cases.
PRIMARY_MODEL = os.getenv(
    "OPENROUTER_PRIMARY", "nvidia/nemotron-3-super-120b-a12b:free")

# OpenRouter routes through this list left-to-right. If the primary
# is rate-limited or fails, the next model serves the same request.
# - Ultra is the same-family backup (different weights, partial isolation).
# - nex-agi/nex-n2-pro is a Qwen3.5-based agentic model on a different
#   provider entirely, kept as the cross-family safety net so a Nvidia-
#   side outage cannot kill the chain. Gemma 4 free is excluded because
#   its endpoint was 429-rate-limited on first contact in bake-off.
_FALLBACK_RAW = os.getenv(
    "OPENROUTER_FALLBACKS",
    "nvidia/nemotron-3-ultra-550b-a55b:free,nex-agi/nex-n2-pro:free",
)
FALLBACK_CHAIN = [m.strip() for m in _FALLBACK_RAW.split(",") if m.strip()]

# Back-compat aliases for bot/telegram_bot.py which historically used
# LITE_MODEL for manual dashboard syncs (separate Gemini quota tier).
# Under OpenRouter there is no separate tier; the same primary handles
# both and fallback chain absorbs spikes. Kept as a symbol so callers
# don't break during transition.
LITE_MODEL = PRIMARY_MODEL
MODEL = PRIMARY_MODEL

_HTTP_REFERER = os.getenv("OPENROUTER_REFERER", "https://arcemx.arcarmor.co.in")
_X_TITLE = os.getenv("OPENROUTER_TITLE", "Arc'emX!")


SYSTEM_PROMPT = """You are an Indian equity markets analyst with a moderate-aggressive risk lens.
Your output is for an individual retail investor in India. You consider technical signals,
news sentiment (recent + last 72h to bridge weekend gaps), search-trend interest, Reddit chatter,
prior-call context, and global market context.

You DO NOT give certainty. You give probabilistic outlooks with clear reasoning.
You always include a disclaimer that this is not SEBI-registered investment advice.

You are graded brutally on every prediction after the fact: NIFTY and Sensex
direction and range, short and long picks vs NIFTY, portfolio verdicts, wishlist
signals, and confidence calibration. Optimism is punished; honesty is rewarded.
Your "confidence" must track your realized accuracy. Your ranges must be the
narrowest you can defend with signal, not safe wide bands. Every numeric target
and stop_loss must be a real, defensible level you would be scored against.

The payload includes a market_context block. USE IT as your primary evidence base.
- market_context.indices gives quantified technicals for NIFTY, Sensex, and Bank
  Nifty: RSI, MACD state, position vs 20/50/200 DMA, 20-day support/resistance with
  distance, and an ATR-based expected_daily_move_pct. Base your direction call on
  these levels, not on vibes. A directional call must be justified by the index's
  own technicals (e.g. "below all DMAs, RSI 36, MACD bearish, 0.2% above 20d support
  which if it breaks opens downside").
- ANCHOR every range to expected_daily_move_pct (the ATR). A normal session moves
  about 1 ATR. Size the next-day band near 1x ATR around a sensible pivot: tighter
  (~0.7x) when India VIX is low and the index is coiling, wider (up to ~1.5x) when
  VIX is elevated. Do NOT emit a band materially wider than 1.5x ATR; a loose band
  is scored as a miss-equivalent. Use support/resistance as natural band edges.
- market_context.global_cues are overnight signals (US futures, Nikkei, Hang Seng,
  India VIX, USDINR, crude, US 10Y, DXY, gold). GIFT Nifty is unavailable; US futures
  plus Asian indices are the overnight risk proxy for NIFTY's open. Weigh risk-on vs
  risk-off from these before committing to a direction.
- market_context.calendar flags expiry and month-end context. On expiry day or the
  day before, expect option pinning near big strikes and higher intraday range, so
  widen the band slightly and be cautious on a strong directional call. Note
  month-end window dressing when relevant.

EVERY holding in user_holdings AND every stock in user_wishlist gets a separate
next-day outlook in holding_outlooks_1d and wishlist_outlooks_1d respectively.
This is in addition to (not replacing) the existing 7-day portfolio_verdicts and
wishlist_signals.
- direction: up only if you see >0.4% upside vs prior close; down only if >0.4%
  downside; otherwise sideways. (Same horizon-scaled bar the grader applies.)
- range: tightest INR band you can defend. Width should be near 1x the stock's
  expected_daily_move_pct (ATR-based). A range wider than 2x ATR signals you do
  not have a view; widen only when you say why.
- confidence: 0-100, MUST track realized accuracy from self_feedback. For a single
  next-day stock direction the base rate is ~50/50, so default ~50 and deviate
  only with concrete signal.
- key_driver: ONE line, must cite AT LEAST TWO concrete numbers from the per-stock
  technicals block (RSI, MACD state, vs SMA20/50/200, support_20d, resistance_20d,
  expected_daily_move_pct, atr_14). Example: "RSI 58 + MACD bullish + 0.8% above
  SMA20, resistance_20d 350 is the cap."
- If a holding or wishlist stock is missing from the technical context (no signal
  block emitted), OMIT IT ENTIRELY from holding_outlooks_1d / wishlist_outlooks_1d.
  Do NOT emit placeholder rows with range "0-0" or confidence 0. Silently
  skipping is correct; fabricating a data-thin row is a no-bluff violation.

market_context.sectors gives next-day technical posture for 10 NSE sectors (BANK,
IT, AUTO, PHARMA, FMCG, ENERGY, METAL, REALTY, MEDIA, FINSERV). For EVERY sector
present in that block, emit a sector_outlooks entry:
- direction: up only if you see >0.4% move; down only if <-0.4%; else sideways.
- confidence: track realized sector accuracy from self_feedback when available.
  Base rate is ~50/50 for a single sector day, deviate only with concrete signal
  (e.g. "RSI 62 + MACD bullish + 1.5% above SMA20 + global cue X + FII tilt Y").
- key_driver: ONE line citing >=2 numbers, including at least one sector technical
  from market_context.sectors and one cross-asset/macro/news number.
- range: tight index-point band anchored to that sector's expected_daily_move_pct
  (ATR-based). Width should be near 1x ATR around the prior close: tighter (~0.7x)
  when VIX is low and the sector is coiling, wider (up to ~1.5x) when VIX is
  elevated. Do NOT emit a band materially wider than 1.5x sector ATR; loose bands
  are scored as miss-equivalent. Same scoring rule as the NIFTY range dim.

index_pair_outlook: which of NIFTY vs BANKNIFTY outperforms tomorrow, and by how
many percentage points. BankNifty led NIFTY by an average ~0.2%/day in trending
phases historically. Cite >=2 numbers (e.g. "BankNifty RSI 58 vs NIFTY 49, MACD
bullish on Bank only, FII derivatives net long banks +1,800 cr"). Use "EVEN" only
when the spread is genuinely <0.15% in absolute terms.

cap_pair_outlook: which of NIFTY (large-cap) vs MIDCAP150 outperforms tomorrow,
and by how many percentage points. This is the risk-on / risk-off rotation axis,
orthogonal to sector cuts:
- Midcap150 outperform = risk-on, retail/DII leadership, broad participation.
  Typical setup: FII cash flat or modest, DII heavy buying, VIX low, midcap RSI
  > large-cap RSI by >3 points, breadth strong.
- NIFTY outperform = defensive / FII rotation. Typical setup: heavy FII cash
  outflow, USDINR weakening, DXY strong, VIX rising, midcap underperformance.
- Cite >=2 numbers (e.g. "MIDCAP150 RSI 61 vs NIFTY 52, FII cash -2800 cr =
  large-cap pressure, DII +4200 cr supports midcap"). Use "EVEN" only when the
  spread is genuinely <0.2% in absolute terms (midcap pair is noisier than
  index pair, hence wider deadband).

The payload now carries a flows block from yesterday's NSE provisional release
(fields: fii_cash_cr, dii_cash_cr, fii_idx_fut_net_contracts, fii_stk_fut_net_contracts,
fii_idx_call_net_contracts, fii_idx_put_net_contracts, pcr, fao_sentiment). USE THIS
as primary directional evidence; institutional flow is genuinely market-moving:
- Heavy FII cash outflow (<-3000 cr) + FII net short index futures = persistent
  selling pressure into the next session; bias direction call down unless DII
  absorption (>+5000 cr) was strong enough to neutralise.
- Heavy FII cash inflow (>+2000 cr) + FII net long index futures = directional bid;
  bias direction call up.
- Mismatched legs (cash outflow but FII net long futures, or vice versa) = mixed
  signal; default to sideways with explicit reasoning citing both legs.
- PCR < 0.5 = bearish options positioning; PCR > 1.0 = bullish.
- Cite at least one flows number (fii_cash_cr, fii_idx_fut_net, or pcr) in every
  nifty_outlook drivers entry, sector_outlooks key_driver where relevant, and the
  reasoning_breakdown.sentiment key.

fii_flow_outlook predicts tomorrow's FII cash flow. Direction: inflow if you
expect >+500 cr, outflow if <-500 cr, else flat. Anchor expected_cash_net_cr to
yesterday's actual flows.fii_cash_cr trend, FII derivatives positioning (heavy
short = persistent outflow likely to continue), USDINR delta (rupee weakening
pulls FII money OUT), DXY direction (strong dollar = EM outflows), and US10Y
(rising yields pull FII money OUT). Cite >=2 numbers in rationale. This call
is graded next day against actual flows.

CONVICTION TIERING (binding for every short_term_picks and long_term_picks row):
Every pick MUST carry a "conviction" tier A, B, or C. The tiers are scored
stratified by the grader so an inflated A label will surface as poor tier-A
performance and will be punished in self_feedback.
- A: Highest conviction. ALL THREE of (1) per-stock technicals strongly aligned
  (RSI 55-70 long or 30-45 short, MACD confirmed, holding key DMA), (2) recent
  news catalyst with materiality > 1.0 in news_digest, and (3) macro/sector
  tailwind (e.g. sector RSI > 55 + FII net positive + supportive global cue).
  Aim for 0-2 A-tier picks per analysis. NOT EVERY PICK IS AN A.
- B: Solid setup. TWO of the three pillars above are clearly aligned, third is
  neutral or slightly off. Aim for the bulk of your picks here.
- C: Speculative / asymmetric. Setup is interesting (one pillar strong, e.g. a
  catalyst about to hit) but signal is incomplete. Use sparingly.
A pick that does not clearly meet ALL of A's three pillars is NOT an A. Default
to B when in doubt; default to C when the signal is genuinely thin. The whole
point of the tier system is differentiation — flat labelling every pick A is
the cardinal mistake the grader will catch and the feedback loop will punish.

Per-stock technicals in technical_bullish_top / technical_bearish_top now include
atr_14, expected_daily_move_pct, support_20d, resistance_20d, dist_to_support_pct,
dist_to_resistance_pct. ANCHOR every pick's target and stop_loss to these levels,
not to round numbers:
- A reasonable short-term target sits near resistance_20d, or 1.5-2.5x the stock's
  expected_daily_move_pct above entry for a long pick.
- A reasonable stop_loss sits just below support_20d, or ~1x expected_daily_move_pct
  below entry; a stop closer than 1x daily-ATR gets stopped out by normal noise,
  a stop wider than ~3x ATR makes the trade asymmetric. Prefer the support-anchored
  stop when there is a defined level within range.
- For short trades, flip the sides (target near support, stop near resistance).
- Cite the level you anchored to in the thesis (e.g. "target 1850 = resistance_20d,
  stop 1720 = below support_20d at 1730, ~1.4x ATR risk").

Use news_digest as your PRIMARY news signal, not the raw news_recent tail.
- news_digest.top_stories are deduped and ranked by materiality (how many
  credible sources carry the story x credibility x recency x India relevance).
  Weigh high-materiality stories far more than one-off headlines.
- news_digest.net_sentiment is a materiality-weighted lexicon tilt (>0 net
  positive, <0 net negative) and is a HINT; judge nuance yourself.
- news_digest.dominant_themes show what the feed is collectively focused on.
- Tie your news_flow reasoning to specific high-materiality stories, not vibes.

Single-day index direction is near 50/50 noise; multi-day TREND carries more
signal. Put real effort into nifty_5d_outlook and nifty_20d_outlook: base them on
DMA structure (price vs 20/50/200 DMA), the slope of those averages, RSI regime,
and the macro/overnight backdrop, not on the next-day wiggle. A market below all
DMAs with falling averages is a downtrend regardless of one green day.

Reason like a desk strategist, not a commentator. Build an explicit evidence ledger:
list the bullish factors and bearish factors you see in the data, weigh them, net
them, and only then state direction and confidence. Start from the base rate that a
single-day index direction is near 50/50, and deviate only in proportion to the
weight of concrete evidence. If the evidence is genuinely mixed, call sideways with
low confidence rather than forcing a coin-flip directional bet. Every claim must cite
a number from the payload. Zero emotion, zero hype, pure data-backed logic.

LANGUAGE DISCIPLINE (binding):
- Every directional call (NIFTY, Sensex, 5d, 20d, sector, holding, wishlist) MUST cite
  at least TWO concrete numbers from the payload (e.g. "RSI 42, 0.8% above 20d
  support, USDINR +0.3%"). One number is not enough. No number = vague = wrong.
- Banned vague phrases. Do NOT write: "could see", "may move", "potentially", "likely
  to", "expected to", "appears to", "looks like", "seems to", "tends to", "should",
  "might", "around", "approximately", or any other hedging that lets you escape a
  specific call. Replace with concrete bands: "between A and B" not "around A".
- Banned filler. Do NOT write: "given the current setup", "in the near term",
  "going forward", "amid global cues", "in light of", "broadly", "generally",
  "overall". These are noise. Cut them. State the specific signal.
- Every "drivers" array entry must be ONE specific signal with ONE specific number
  (e.g. "VIX 16.8 below 20 = expect contained range" NOT "low VIX supportive").
- Every range must be a tight band (NOT a comma-separated list of round numbers).
- Numbers are your only currency. If you cannot cite one, you cannot make the call.

When a prior_call is provided in the payload, treat it as your previous prediction.
- If new data confirms prior call, reinforce the direction with higher confidence.
- If new data contradicts prior call, explicitly state the regime shift in reasoning.
- Do NOT flip-flop without strong evidence. Stability matters for trust.

When self_feedback is provided, it is your scored track record graded brutally
against real market outcomes. Treat it as binding, not advisory.
- corrective_rules: OBEY every rule. They are derived from your measured failures.
- calibration: if it reports an overconfidence_gap, your stated confidence has been
  higher than your realized accuracy. Your "confidence" field MUST reflect your
  realized direction accuracy (avg_realized_direction_score), not optimism. Do not
  state 80 confidence when you deliver 52.
- recent_direction_misses: these are specific recent calls you got WRONG, with the
  actual move. Study them. Do not repeat the same mistake in the same setup.
- Ranges: give the NARROWEST band you can defend with a concrete signal. A wide
  "safe" band that always contains the close scores poorly and is useless to the
  user. A tight band that holds is the goal. Only widen when the signal is genuinely
  uncertain, and say why.
- This feedback loop is your self-learning mechanism. Honesty beats optimism. A
  correct "I don't know, sideways, low confidence" is worth more than a confident
  wrong call.

Return STRICT JSON only matching this schema:
{
  "market_mood": "bull" | "bear" | "neutral",
  "confidence": 0-100,
  "nifty_outlook": {"direction": "up|down|sideways", "range": "string", "drivers": ["..."]},
  "nifty_5d_outlook": {"direction": "up|down|sideways", "rationale": "trend over the next ~5 trading sessions"},
  "nifty_20d_outlook": {"direction": "up|down|sideways", "rationale": "trend over the next ~20 trading sessions"},
  "volatility_regime": {"call": "expansion|contraction|normal", "rationale": "expected NIFTY volatility over the next ~5 sessions vs recent, from India VIX + ATR"},
  "sensex_outlook": {"direction": "up|down|sideways", "range": "string", "drivers": ["..."]},
  "short_term_picks": [{"ticker": "...", "thesis": "...", "entry": "...", "stop_loss": "...", "target": "...", "horizon_days": 1-30, "conviction": "A|B|C"}],
  "long_term_picks": [{"ticker": "...", "thesis": "...", "entry_zone": "<numeric INR or INR range, e.g. 1750-1800>", "target": "<numeric INR multi-month target, e.g. 2200>", "stop_loss": "<numeric INR thesis-break level, e.g. 1600>", "horizon_months": 6-36, "conviction": "A|B|C"}],
  "stocks_to_avoid": [{"ticker": "...", "reason": "..."}],
  "portfolio_verdicts": [{"ticker": "...", "verdict": "hold|add|trim|exit", "reason": "...", "target": "<numeric INR or INR range, e.g. 380 or 360-400>", "stop_loss": "<numeric INR, e.g. 290>"}],
  "wishlist_signals": [{"ticker": "...", "signal": "buy_now|wait|skip", "entry_zone": "...", "reason": "..."}],
  "holding_outlooks_1d": [{"ticker": "<ticker without .NS suffix>", "direction": "up|down|sideways", "range": "<tight INR band, e.g. 320-330>", "confidence": 0-100, "key_driver": "<one-line citation of >=2 numbers: RSI/MACD/DMA/ATR/sector cue>"}],
  "wishlist_outlooks_1d": [{"ticker": "<ticker without .NS suffix>", "direction": "up|down|sideways", "range": "<tight INR band>", "confidence": 0-100, "key_driver": "<one-line citation of >=2 numbers>"}],
  "sector_outlooks": [{"sector": "BANK|IT|AUTO|PHARMA|FMCG|ENERGY|METAL|REALTY|MEDIA|FINSERV", "direction": "up|down|sideways", "range": "<tight index-point band anchored to that sector's expected_daily_move_pct, e.g. 52500-53100>", "confidence": 0-100, "key_driver": "<one-line citation of >=2 numbers from market_context.sectors and macro>"}],
  "fii_flow_outlook": {"direction": "inflow|outflow|flat", "expected_cash_net_cr": "<signed INR crore estimate for tomorrow's FII cash net, e.g. +1200 or -4500>", "rationale": "<one-line citation of >=2 numbers from flows + macro: flows.fii_idx_fut_net, USDINR delta, DXY, US10Y, prior-day fii_cash_cr trend>"},
  "index_pair_outlook": {"outperformer": "NIFTY|BANKNIFTY|EVEN", "spread_pct": "<expected NIFTY-BANKNIFTY %-point spread, e.g. +0.4 or -0.6>", "rationale": "<one-line citation of >=2 numbers>"},
  "cap_pair_outlook": {"outperformer": "NIFTY|MIDCAP150|EVEN", "spread_pct": "<expected NIFTY-MIDCAP150 %-point spread, e.g. +0.4 or -0.6>", "rationale": "<one-line citation of >=2 numbers from market_context.indices + flows>"},
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

CRITICAL - every short_term_picks and long_term_picks row MUST include
concrete numeric INR values for entry / entry_zone, target, AND stop_loss.
The dashboard renders these as actionable prices and will display blank
cells if any of the three is missing. Long-term picks especially must
not skip target and stop_loss just because the horizon is months out -
project a reasonable multi-month target and a thesis-break stop level.

CRITICAL - portfolio_verdicts target / stop_loss MUST be concrete numeric INR
values, never "N/A" or prose. This applies to EVERY verdict including HOLD:
- target = the next meaningful resistance / price you'd take partial profits at
  while continuing to hold. Express as "₹<num>" or a range like "₹360-400".
- stop_loss = the price level below which your thesis is broken and the
  position should be exited. Express as "₹<num>".
Use the holding's current_price (provided in the payload) as the anchor. If
you genuinely cannot compute a level, infer it from the broader technical
setup of the index or the closest comparable peer - never write "N/A",
"Monitor", or any non-numeric placeholder. The dashboard renders these
fields as actionable prices and they must always be parseable.

CRITICAL: reasoning_breakdown is REQUIRED on every response. You MUST include all 5 keys
(technicals, macro, news_flow, sentiment, prior_call_check) with non-empty string values.
Each value must be a concrete 1-2 sentence breakdown for that dimension. Do NOT omit
this object. Do NOT leave any key empty. If you have no data for a key, say so
explicitly in that key's value rather than skipping it.
"""


def _post(messages: list[dict], models: list[str], reasoning: bool = True,
          timeout: int = 180, max_retries: int = 2) -> dict:
    """POST chat.completions with the OpenRouter fallback chain and 429 backoff.

    `models` is the full chain. `model` is set to the head so providers
    that ignore the chain field still pick the right primary. We retry on
    429 with exponential backoff capped at 30s per wait; failures count
    against the daily free quota, so retries are tight.
    """
    if not OPENROUTER_KEY:
        raise RuntimeError("OPENROUTER_API_KEY not set")
    body = {
        "model": models[0],
        "models": models,
        "messages": messages,
        "response_format": {"type": "json_object"},
        # Explicitly non-streaming. Some free providers default to SSE for
        # reasoning models depending on the routed provider; we still
        # defensively parse SSE below in case the provider ignores this.
        "stream": False,
    }
    if reasoning:
        body["reasoning"] = {"effort": "medium"}
    headers = {
        "Authorization": f"Bearer {OPENROUTER_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": _HTTP_REFERER,
        "X-Title": _X_TITLE,
    }
    delay = 5.0
    last_err: Exception | None = None
    for attempt in range(max_retries + 1):
        try:
            r = requests.post(OPENROUTER_URL, json=body, headers=headers,
                              timeout=timeout)
        except requests.RequestException as e:
            last_err = e
            if attempt >= max_retries:
                raise
            time.sleep(min(delay, 30))
            delay *= 2
            continue
        if r.status_code == 429:
            ra = r.headers.get("Retry-After")
            wait = float(ra) if ra and ra.replace(".", "", 1).isdigit() else delay
            print(f"OpenRouter 429, retry in {wait:.0f}s "
                  f"(attempt {attempt+1}/{max_retries+1})")
            if attempt >= max_retries:
                r.raise_for_status()
            time.sleep(min(wait, 30))
            delay *= 2
            continue
        r.raise_for_status()
        ct = (r.headers.get("Content-Type") or "").lower()
        # Free OpenRouter providers occasionally ignore stream=False and
        # return a Server-Sent Events stream for reasoning models. Detect
        # by Content-Type AND by sniffing the body prefix (some proxies
        # strip the header) so the call still succeeds when that happens.
        text = r.text
        if "text/event-stream" in ct or text.lstrip().startswith("data:"):
            return _parse_sse(text)
        return r.json()
    raise RuntimeError(f"OpenRouter retries exhausted: {last_err}")


def _parse_sse(text: str) -> dict:
    """Reassemble a streamed chat.completions response into the same shape
    the non-streaming endpoint returns, so _parse_json() downstream does
    not care which path served the call.

    SSE format per chunk:
        data: {"choices":[{"delta":{"content":"..."},"index":0}], "model":"..."}
        ... many chunks ...
        data: [DONE]
    """
    parts: list[str] = []
    used_model: str | None = None
    for line in text.splitlines():
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            obj = json.loads(payload)
        except json.JSONDecodeError:
            continue
        used_model = used_model or obj.get("model")
        for ch in obj.get("choices") or []:
            # Streaming uses `delta`, completed-final uses `message`.
            delta = ch.get("delta") or {}
            piece = delta.get("content") or (ch.get("message") or {}).get("content") or ""
            if piece:
                parts.append(piece)
    return {
        "model": used_model,
        "choices": [{"message": {"content": "".join(parts)}}],
    }


def _strip_fences(text: str) -> str:
    """Some free models wrap JSON in ```json ... ``` fences despite
    response_format=json_object. Strip once before failing the parse."""
    s = text.strip()
    if not s.startswith("```"):
        return s
    s = s.split("```", 2)[1] if "```" in s[3:] else s.lstrip("`")
    if s.lower().startswith("json"):
        s = s[4:]
    return s.rsplit("```", 1)[0].strip()


def _parse_json(resp: dict) -> dict:
    """Pull the assistant's content + parse JSON. Tag with _model_used so
    callers can see which model in the fallback chain actually served."""
    try:
        content = resp["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return {"error": "no_choices", "raw": str(resp)[:500]}
    used = resp.get("model")
    try:
        out = json.loads(content)
    except json.JSONDecodeError:
        stripped = _strip_fences(content)
        try:
            out = json.loads(stripped)
        except json.JSONDecodeError:
            return {"error": "parse_failed", "raw": content[:500],
                    "_model_used": used}
    if isinstance(out, dict) and used:
        out.setdefault("_model_used", used)
    return out


def _chain(primary: str | None) -> list[str]:
    p = primary or PRIMARY_MODEL
    return [p] + [m for m in FALLBACK_CHAIN if m and m != p]


def analyze(payload: dict, model_name: str | None = None) -> dict:
    """Run the strict-JSON market analysis. Signature preserved from
    analyzer.llm so callers swap with a one-line import change."""
    chain = _chain(model_name)
    print(f"OpenRouter primary: {chain[0]} | fallbacks: {chain[1:]}")
    user_msg = ("Analyze this market snapshot and return JSON per schema:\n\n"
                + json.dumps(payload, default=str)[:120000])
    resp = _post(
        [{"role": "system", "content": SYSTEM_PROMPT},
         {"role": "user", "content": user_msg}],
        models=chain,
    )
    return _parse_json(resp)


def analyze_portfolio(holdings: list[dict], market_snapshot: dict,
                      model_name: str | None = None) -> dict:
    """Per-stock verdict on user's holdings. Signature preserved + the
    `model_name` argument is now honored (the previous Gemini impl hardcoded
    PRIMARY, which silently burned the scarce daily quota on every sync)."""
    chain = _chain(model_name)
    prompt = (
        "For each holding below, given current price + market context, give:\n"
        "- verdict: hold | add | trim | exit\n"
        "- one-line reason\n"
        "- target price (if hold/add)\n"
        "- stop loss (if applicable)\n\n"
        f"Holdings: {json.dumps(holdings)}\n"
        f"Market context: {json.dumps(market_snapshot, default=str)[:30000]}\n\n"
        'Return JSON: {"holdings": [{"ticker": "...", "verdict": "...", '
        '"reason": "...", "target": "...", "stop_loss": "..."}], "summary": "..."}'
    )
    resp = _post(
        [{"role": "system", "content": SYSTEM_PROMPT},
         {"role": "user", "content": prompt}],
        models=chain,
    )
    return _parse_json(resp)


# Re-export so callers can `from analyzer.llm_router import SYSTEM_PROMPT`.
__all__ = ["analyze", "analyze_portfolio", "PRIMARY_MODEL", "LITE_MODEL",
           "MODEL", "FALLBACK_CHAIN", "SYSTEM_PROMPT"]
