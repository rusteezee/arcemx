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


def _load_keys() -> list[str]:
    """SINGLE-MODEL key pool. Returns only the primary OPENROUTER_API_KEY,
    which is reserved for the Nemotron Super single-model path and the
    bot's individual one-off calls. The ensemble fan-out has its own
    separate pool (`_load_ensemble_keys`) so the primary key is never
    burned by a 6-model fan-out and stays fully available for the
    single-model fallback path it serves.
    """
    keys: list[str] = []
    if OPENROUTER_KEY:
        keys.append(OPENROUTER_KEY)
    return keys


def _load_ensemble_keys() -> list[str]:
    """ENSEMBLE-ONLY key pool. Reads the numbered slots
    OPENROUTER_API_KEY_1 ... OPENROUTER_API_KEY_9 and the legacy
    OPENROUTER_API_KEYS comma-separated var. Deliberately EXCLUDES the
    primary OPENROUTER_API_KEY so the single-model path retains its own
    quota. Numbered slots are the recommended form; comma-separated is
    kept for backward compat. Deduped, whitespace-stripped.
    """
    keys: list[str] = []
    for i in range(1, 10):
        v = (os.getenv(f"OPENROUTER_API_KEY_{i}", "") or "").strip()
        if v and v not in keys:
            keys.append(v)
    extra = os.getenv("OPENROUTER_API_KEYS", "")
    for k in extra.split(","):
        k = k.strip()
        if k and k not in keys:
            keys.append(k)
    return keys


def _key_fingerprints(keys: list[str]) -> list[str]:
    """Stable, non-reversible fingerprint per key (8 hex chars of SHA-256)
    for safe logging. The user can compute the same fingerprint locally
    from any candidate key to identify which slot it occupies in the log,
    without the log itself revealing any portion of the secret."""
    import hashlib
    return [hashlib.sha256(k.encode("utf-8")).hexdigest()[:8] for k in keys]


# Per-key cooldown registry: key -> monotonic timestamp until which the
# key is considered rate-limited and skipped. Populated on a 429.
_KEY_COOLDOWN: dict[str, float] = {}


def _pick_key(keys: list[str], attempt: int) -> str | None:
    """Return the next usable key for this attempt, skipping any in
    cooldown. Falls back to round-robin over all keys (ignoring cooldown)
    when every key is cooling down, so a call still goes out rather than
    failing outright."""
    if not keys:
        return None
    now = time.monotonic()
    usable = [k for k in keys if _KEY_COOLDOWN.get(k, 0) <= now]
    pool = usable or keys
    return pool[attempt % len(pool)]

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
  expected_daily_move_pct, atr_14). When the per-stock fundamentals or news block
  carries a relevant anchor for the next-day move (an earnings beat in the last 24h,
  a major recommendation change, a debt/equity at extreme, a forward P/E re-rate),
  cite ONE number from there too instead of repeating two technicals; the model
  catalyst plus a technical confirmation reads as a stronger thesis than two
  indicator readings alone. Example: "RSI 58 + MACD bullish + 0.8% above SMA20,
  resistance_20d 350 is the cap." Or: "Earnings YoY +24% headline + RSI 61,
  resistance_20d 1180 is the cap."
- If a holding or wishlist stock is missing from the technical context (no signal
  block emitted), OMIT IT ENTIRELY from holding_outlooks_1d / wishlist_outlooks_1d.
  Do NOT emit placeholder rows with range "0-0" or confidence 0. Silently
  skipping is correct; fabricating a data-thin row is a no-bluff violation.

holding_fundamentals[TICKER] and wishlist_fundamentals[TICKER] carry yfinance
valuation, growth, profitability, leverage, and beta when available. holding_news
[TICKER] and wishlist_news[TICKER] carry the 5 most-recent headlines per stock
(title + publisher + published_at). USE THEM. A stock with earnings_growth_qoq_pct
above +20 and a positive headline in holding_news today is a different next-day
setup than one with a debt_to_equity above 200 and a negative headline; ranges
and directions must reflect that. Never invent fundamentals or news that are not
in the payload. If the block is empty for a ticker, fall back to technicals only.

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

CONVICTION TIERING (binding for every top_performers and worst_performers row):
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
point of the tier system is differentiation. flat labelling every pick A is
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

When sensei_yesterday is provided (it will be on every weekday session after the
first), it is the EOD retrospective written after the previous session closed by a
separate synthesis pass over the actual closes and the grader's scores. Treat it as
binding homework, not advisory.
- Read sensei_yesterday.tomorrow_watch and sensei_yesterday.key_insights BEFORE
  forming your direction call. Levels and events flagged there are the first thing
  you check against today's market_context.
- If sensei_yesterday.what_missed lists a setup similar to today's, do NOT repeat
  the same mistake; explicitly call out the prior miss in reasoning_breakdown.
  prior_call_check and explain how today's call differs (or why you are holding
  the same view despite the miss).
- Cite at least ONE item from sensei_yesterday.tomorrow_watch or key_insights in
  reasoning_breakdown.prior_call_check by name. No paraphrase-only references; quote
  the specific level / event / number.
- sensei_yesterday.calibration_note tells you whether your last stated confidence was
  calibrated. If it flags overconfidence, lower your confidence on today's call
  accordingly. If it flags underconfidence (rare), only raise confidence when today's
  evidence is genuinely stronger, not because you got punished.

When self_feedback is provided, it is your scored track record graded brutally
against real market outcomes. Treat it as binding, not advisory.
- corrective_rules: OBEY every rule. They are derived from your measured failures.
- calibration: if it reports an overconfidence_gap, your AGGREGATE stated
  confidence across many calls has been higher than your AGGREGATE realized
  accuracy. The fix is NOT to anchor every individual call to the mean realized
  number. The fix is to make each call's confidence reflect THAT call's evidence
  strength per the CONFIDENCE ANCHOR doctrine below: strong evidence pushes
  the number up, weak evidence pushes it down, so that across many calls the
  MEAN of your confidences converges to your realized accuracy via DISTRIBUTION,
  not via collapse. Every call landing at 50-55 is the failure mode this rule
  is meant to prevent, not the cure. A model where confidence stdev is < 10
  across its last 10 calls has lost all information value; the calibration
  problem is unsolved no matter how close the mean is to realized accuracy.
- recent_direction_misses: these are specific recent calls you got WRONG, with the
  actual move. Study them. Do not repeat the same mistake in the same setup.
- Ranges: give the NARROWEST band you can defend with a concrete signal. A wide
  "safe" band that always contains the close scores poorly and is useless to the
  user. A tight band that holds is the goal. Only widen when the signal is genuinely
  uncertain, and say why.
- This feedback loop is your self-learning mechanism. Honesty beats optimism. A
  correct "I don't know, sideways, low confidence" is worth more than a confident
  wrong call.

market_mood (bull / bear / neutral) is the headline call on tomorrow's NIFTY
session and is graded against the same +/-0.4% noise band the direction call
uses. Decision rule, no exceptions:
- bull: you expect NIFTY to close >+0.4% above its prior close. Requires
  concrete bullish evidence (e.g. price above all DMAs + RSI > 55 + FII cash
  net inflow + supportive global cue). nifty_outlook.direction MUST be "up".
- bear: you expect NIFTY to close <-0.4% below its prior close. Requires
  concrete bearish evidence (e.g. price below 20/50 DMA + RSI < 45 + FII
  cash net outflow + risk-off global cue). nifty_outlook.direction MUST be
  "down".
- neutral: you expect the move to stay inside +/-0.4% (noise / coiling /
  expiry pinning). nifty_outlook.direction MUST be "sideways".
market_mood and nifty_outlook.direction MUST agree. A bull mood with a
sideways direction call is a self-contradiction the grader will catch.
Default to neutral whenever evidence is genuinely mixed; do not force a
directional mood to look decisive.

CONFIDENCE ANCHOR (applies to EVERY confidence field below — nifty_outlook,
sensex_outlook, holding_outlooks_1d, wishlist_outlooks_1d, sector_outlooks):
Default-anchoring to 50-55 because the call feels uncertain is a failure
mode, not calibration. Map evidence -> confidence band BEFORE writing the
number:

  80-92 : all three pillars (technicals + flow + macro) agree, no active
          red flag. Reserve 90+ for textbook setups with prior >=70 wins.
  65-78 : 2/3 pillars agree, third is neutral not opposed.
  50-62 : mixed (one agrees, two neutral or one opposed). Coin-flip with
          light tilt.
  30-48 : weak / opposed evidence base. Issuing call on single decisive
          driver (catalyst, sector flow). Material downside acknowledged.
  10-28 : speculative asymmetric R:R bet, not conviction.

Discipline check: confidence stdev across your full output (all dim
confidence fields together) should be >=10. Tight cluster around 55 is
anchor-bound, not calibrated. Push the strong cases UP and the weak
cases DOWN.

TOP / WORST PERFORMERS DOCTRINE (this is your primary daily output — own it):
You are an INDEPENDENT market analyst. Each day you predict the stocks most
likely to be the day's TOP PERFORMERS (largest positive move vs NIFTY) and
WORST PERFORMERS (largest negative move vs NIFTY) over the stated horizon.

UNIVERSE = the WHOLE liquid NSE market, not a handed-to-you shortlist. The
technical_bullish_top / technical_bearish_top blocks are a SCREENED STARTING
POINT (momentum + technicals on a base universe), not your boundary. You MUST
also draw on your own knowledge of any liquid NSE-listed stock (NIFTY 500
breadth) when the news_digest, sector rotation, FII flows, or a catalyst points
somewhere the screen did not surface. Do NOT restrict picks to user_holdings or
user_wishlist — those are the user's existing exposure, a SEPARATE concern from
"who wins today". A good day's top_performers list should mostly be names the
user does NOT already hold; that is the engine doing independent research.

Each top_performers / worst_performers entry MUST quote:
- ticker (NSE symbol, with or without .NS)
- thesis (one line, cite >=2 concrete data points: a technical + a catalyst/flow)
- horizon_days (1 for same-day; 1-10 for a short swing)
- expected_move_pct (signed: + for top, - for worst, the move vs prior close you expect)
- conviction A|B|C (per the tiering doctrine below)
- win_prob (probability the directional call is right; A->0.65-0.80, B->0.50-0.65,
  C->0.35-0.50), loss_prob (1 - win_prob)
- expected_return_pct (upside magnitude if right), expected_loss_pct (downside if wrong)
- expected_edge_pct (signed = expected_return_pct * win_prob - expected_loss_pct * loss_prob)
- reasons_could_be_wrong (>=1 concrete failure mode citing the data field that contradicts)
Aim for 8-15 names in EACH list. The paper trader consumes top_performers
directly as long entries and scores every call against the next session's actual
move, so an unaudited or vague entry is a wasted, ungraded signal.

Return STRICT JSON only matching this schema:
{
  "market_mood": "bull" | "bear" | "neutral",
  "confidence": 0-100,
  "nifty_outlook": {"direction": "up|down|sideways", "range": "string", "confidence": 0-100, "drivers": ["..."]},
  "nifty_5d_outlook": {"direction": "up|down|sideways", "rationale": "trend over the next ~5 trading sessions"},
  "nifty_20d_outlook": {"direction": "up|down|sideways", "rationale": "trend over the next ~20 trading sessions"},
  "volatility_regime": {"call": "expansion|contraction|normal", "rationale": "expected NIFTY volatility over the next ~5 sessions vs recent, from India VIX + ATR"},
  "sensex_outlook": {"direction": "up|down|sideways", "range": "string", "confidence": 0-100, "drivers": ["..."]},
  "top_performers": [{"ticker": "...", "thesis": "...", "horizon_days": 1, "expected_move_pct": float (positive), "entry": "<numeric INR>", "target": "<numeric INR>", "stop_loss": "<numeric INR>", "conviction": "A|B|C", "expected_return_pct": float, "expected_loss_pct": float, "win_prob": 0.0-1.0, "loss_prob": 0.0-1.0, "expected_edge_pct": float, "reasons_could_be_wrong": ["concrete failure mode citing data field"]}],
  "worst_performers": [{"ticker": "...", "thesis": "...", "horizon_days": 1, "expected_move_pct": float (negative), "conviction": "A|B|C", "win_prob": 0.0-1.0, "loss_prob": 0.0-1.0, "reasons_could_be_wrong": ["concrete failure mode citing data field"]}],
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

CRITICAL - every top_performers row MUST include concrete numeric INR values
for entry, target, AND stop_loss (worst_performers are short-side calls scored
on direction, so they need expected_move_pct but not a tradeable entry/stop).
The dashboard + paper trader render these as actionable prices and will skip
the row if any of the three is missing on a top_performers entry.

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

VERDICT DISCIPLINE (portfolio_verdicts):
Default-anchoring to "hold" is the laziest failure mode and the most
common one. Grader data over the last 90 days: 89% holds, 10% adds,
1% trim, 0% exits. Hold mean 7d return was +4.15% — i.e. the model
said "stay flat" while holdings were rallying. That is NOT calibrated
"don't crater", that is missed conviction. Force yourself to engage
the 7d directional view explicitly:

  add  : holding's own 7d trend is bullish (RSI > 55, price above
         20/50 DMA, sector flow positive, no fundamental red flag).
         The verdict cost of being wrong here is small (you bought a
         bit more on a rally); the cost of holding through a rally is
         missed upside.
  hold : the call only when the stock is genuinely sideways AND
         neither pillar is screaming change. Defaulting to hold
         because you cannot decide is a graded loss, not a safe play.
  trim : holding's 7d trend is softening (RSI rolling over, broke 20
         DMA, sector flow stalling). Take partial off before the
         stop.
  exit : thesis fully broken (broke 50 DMA + sector bear + fundamental
         hit). Stop saying "monitor" or "hold and watch" when the
         setup says exit.

Distributional check across user_holdings: if you emit "hold" for
every holding, you have not done the work. At least one verdict in
any non-trivial portfolio should be add OR trim OR exit unless every
holding is genuinely flat-and-neutral, which is statistically rare.
Cite the dim that drove a non-hold call in the reason field.

CRITICAL: reasoning_breakdown is REQUIRED on every response. You MUST include all 5 keys
(technicals, macro, news_flow, sentiment, prior_call_check) with non-empty string values.
Each value must be a concrete 1-2 sentence breakdown for that dimension. Do NOT omit
this object. Do NOT leave any key empty. If you have no data for a key, say so
explicitly in that key's value rather than skipping it.
"""


# Models that natively support OpenAI-style response_format=json_object.
# Sending it to a provider that does not recognize the field returns a
# 400 Bad Request (observed: meta-llama/llama-3.3-70b-instruct,
# nousresearch/hermes-3-llama-3.1-405b on certain OpenRouter routes).
# Default to NO response_format for any model not on this list; the
# system prompt already instructs JSON output so well-behaved models
# still comply. Single-model path keeps response_format on because the
# primary Nemotron checkpoint supports it.
_JSON_FORMAT_OK = ("nemotron-3-ultra", "nemotron-3-super",
                   "qwen3-next", "gpt-5", "o1", "gemma-4")
# Note: gpt-oss-120b removed from this list. On the large ensemble
# payload it returned choices[0].message.content == None on every
# call (verified across runs 27862505785, 27863570663, 27864450733).
# Hypothesis: gpt-oss is an open-weights reasoning model and its
# internal reasoning chews max_tokens before any final content is
# emitted when response_format=json_object forces a strict schema.
# Dropping json_format lets it emit free-form text containing JSON
# which _parse_json's fence-stripper recovers cleanly.


def _post(messages: list[dict], models: list[str], reasoning: bool = True,
          timeout: int = 180, max_retries: int = 2,
          api_key: str | None = None,
          json_format: bool = True,
          max_tokens: int | None = None,
          no_rotate: bool = False) -> dict:
    """POST chat.completions with the OpenRouter fallback chain and 429 backoff.

    `models` is the full chain. `model` is set to the head so providers
    that ignore the chain field still pick the right primary. We retry on
    429 with exponential backoff capped at 30s per wait; failures count
    against the daily free quota, so retries are tight.

    Key handling: `api_key` now seeds the FIRST attempt but subsequent
    retries fall back to the full key pool. Pinning indefinitely meant a
    single 429'd key would absorb every retry and never rotate to a
    sibling key with quota left. The ensemble caller still expresses
    per-model key affinity via the first attempt, but a stuck key
    cascades to others instead of dead-ending.
    """
    pool = _load_keys()
    if api_key and api_key not in pool:
        pool = [api_key] + pool
    if not pool:
        raise RuntimeError("OPENROUTER_API_KEY not set")
    # First attempt uses the caller's pinned key when given; subsequent
    # attempts rotate over the full pool starting one index after the
    # cooldown registry filters out anything still 429'd.
    seed_key = api_key or pool[0]
    body = {
        "model": models[0],
        "models": models,
        "messages": messages,
        # Explicitly non-streaming. Some free providers default to SSE for
        # reasoning models depending on the routed provider; we still
        # defensively parse SSE below in case the provider ignores this.
        "stream": False,
    }
    if json_format:
        body["response_format"] = {"type": "json_object"}
    if reasoning:
        body["reasoning"] = {"effort": "medium"}
    if max_tokens is not None:
        body["max_tokens"] = max_tokens
    delay = 5.0
    last_err: Exception | None = None
    for attempt in range(max_retries + 1):
        # First attempt honors the caller's seed key; later attempts
        # rotate over the full pool when no_rotate=False, otherwise stick
        # to the seed key. Ensemble fan-out uses no_rotate=True so each
        # model stays tied to its assigned key: a 429 from one model
        # (e.g. Gemma hitting the provider's per-model throttle) must
        # not cascade retries onto a sibling key meant for a different
        # model, which would idle the third key and overload the others.
        if attempt == 0 or no_rotate:
            key = seed_key
        else:
            key = _pick_key(pool, attempt) or seed_key
        headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "HTTP-Referer": _HTTP_REFERER,
            "X-Title": _X_TITLE,
        }
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
            # Cool this key only when the 429 likely came from OpenRouter
            # itself (Retry-After header present), not from a per-model
            # upstream provider throttle. Cooling the key for any 429
            # caused Gemma's instant provider-side throttle to lock out
            # an entire key for 60s even though the key had RPM quota
            # left for other models; that wasted the third key while
            # the other two absorbed all retries.
            if key and no_rotate is False and ra:
                _KEY_COOLDOWN[key] = time.monotonic() + max(wait, 60)
            n_keys = len(pool)
            words = ["zero","one","two","three","four","five","six","seven","eight"]
            pool_label = words[n_keys] if 0 <= n_keys < len(words) else f"n={n_keys}"
            print(f"OpenRouter 429 pool={pool_label} attempt {attempt+1}, "
                  f"retry in {wait:.0f}s")
            if attempt >= max_retries:
                r.raise_for_status()
            # Longer back-off when sticky-pinned: rotation can't bail us
            # out, so we must wait for the actual rate window to clear.
            sleep_for = min(wait, 30) if (no_rotate or len(pool) == 1) else min(wait, 5)
            time.sleep(sleep_for)
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
    # Some free providers (observed: openai/gpt-oss-120b:free under
    # large reasoning load) return choices[0].message.content == None
    # instead of an empty string. json.loads(None) raises TypeError
    # which the caller logged as "non-dict / empty". Treat as a clean
    # empty-content error so the ensemble path classifies it under the
    # "empty" status with a real reason.
    if content is None or (isinstance(content, str) and not content.strip()):
        # When content is empty but the model returned a reasoning trace,
        # try pulling the trace as a last-ditch parse target. Reasoning
        # models occasionally emit JSON inside the trace when the final
        # message content is dropped.
        rtrace = None
        try:
            rtrace = resp["choices"][0]["message"].get("reasoning")
        except (KeyError, IndexError, TypeError):
            pass
        if isinstance(rtrace, str) and rtrace.strip():
            try:
                out = json.loads(_strip_fences(rtrace))
                if isinstance(out, dict) and used:
                    out.setdefault("_model_used", used)
                return out
            except json.JSONDecodeError:
                pass
        return {"error": "empty_content",
                "raw": "content was None / empty",
                "_model_used": used}
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


# Lowest-leverage payload fields first. When the serialized payload
# exceeds the size budget, whole fields are dropped in this order until
# it fits, so the model always receives VALID JSON. The old approach
# sliced the JSON string at a fixed offset, which handed the model a
# malformed tail. news_recent goes first since news_digest already
# carries that signal in distilled form.
_PAYLOAD_DROP_ORDER = (
    # Cheapest first (already-distilled news lives in news_digest), then
    # ambient signal, then per-ticker enrichments (wishlist before
    # holdings since holdings are the user's actual money), then the
    # broader technical screen. self_feedback, sensei_yesterday,
    # market_context, holding/wishlist technicals, and prior_call are
    # never droppable: lose them and the reasoning loop collapses.
    "news_recent", "reddit_hot", "google_trends", "indices",
    "wishlist_news", "wishlist_fundamentals",
    "holding_news",
    "technical_bearish_top", "technical_bullish_top",
    "holding_fundamentals",
)


def _payload_json(payload: dict, max_chars: int = 120000) -> str:
    s = json.dumps(payload, default=str)
    if len(s) <= max_chars:
        return s
    trimmed = dict(payload)
    for field in _PAYLOAD_DROP_ORDER:
        if field not in trimmed:
            continue
        trimmed[field] = "dropped_for_size"
        s = json.dumps(trimmed, default=str)
        print(f"payload over budget; dropped {field} ({len(s)} chars now)")
        if len(s) <= max_chars:
            return s
    # Still over budget with everything droppable gone: hard-truncate as
    # the last resort, same behavior as before.
    return s[:max_chars]


_SHORT_PICK_BEAR_PROMPT = """You are an adversarial bear auditor for a list of intraday-to-30d short-term equity picks. Each pick has a thesis, entry, stop, target, horizon_days, conviction tier (A=highest, B=mid, C=speculative), expected_return_pct, expected_loss_pct, win_prob, loss_prob, expected_edge_pct, and a reasons_could_be_wrong list the bull analyst already produced.

Your job: for each pick (only conviction A and B — skip C since C is explicitly speculative), find 1-3 CONCRETE additional failure modes the bull missed, citing payload fields they did not address. Be skeptical by default. Each failure mode must:
- Be concrete: cite a number (RSI, DMA, sector index, FII flow, P/E, etc.) from the payload or the pick itself
- Be distinct: do not echo entries already in the pick's reasons_could_be_wrong
- Be material: plausibly cost more than the pick's expected_loss_pct over its horizon
- Be anti-hindsight: never reference data dated after run_at

Output STRICT JSON only:
{
  "by_ticker": {
    "TICKER1": ["concrete failure mode 1 citing data field", "concrete failure mode 2"],
    "TICKER2": ["..."]
  }
}

Empty list per ticker is allowed if the bull case is airtight. Lying about an airtight case to please the validator is worse than admitting it."""


def _short_pick_bear_pass(short_picks: list[dict], payload_excerpt: dict,
                          model_chain: list[str]) -> dict:
    """One LLM call covering the entire short_term_picks list. Returns
    dict[ticker -> list[failure_mode_str]]. Empty dict on any failure."""
    if not isinstance(short_picks, list) or not short_picks:
        return {}
    audit_picks = [p for p in short_picks if isinstance(p, dict)
                   and (p.get("conviction") or "").upper() in ("A", "B")]
    if not audit_picks:
        return {}
    try:
        slim = {
            "picks": audit_picks,
            "market_snapshot_excerpt": {
                "indices": payload_excerpt.get("indices"),
                "flows": payload_excerpt.get("flows"),
                "sectors": payload_excerpt.get("sectors"),
            },
        }
        resp = _post(
            [{"role": "system", "content": _SHORT_PICK_BEAR_PROMPT},
             {"role": "user", "content": json.dumps(slim, default=str)}],
            models=model_chain,
        )
        parsed = _parse_json(resp)
        if not isinstance(parsed, dict):
            return {}
        out_raw = parsed.get("by_ticker")
        if not isinstance(out_raw, dict):
            return {}
        out: dict[str, list[str]] = {}
        for k, v in out_raw.items():
            if isinstance(k, str) and isinstance(v, list):
                out[k.upper()] = [str(x) for x in v if isinstance(x, str)]
        return out
    except Exception as e:
        print(f"  short_pick bear pass skipped: {type(e).__name__}: {str(e)[:120]}")
        return {}


def _apply_short_pick_bear(short_picks: list[dict], bear_by_ticker: dict) -> None:
    """Splice bear findings into each pick's reasons_could_be_wrong (skip
    near-duplicates) and dampen win_prob + recompute expected_edge_pct
    per added material finding. Modifies short_picks in place.

    Dampen schedule: 0.04 per material (>=20 char) added entry, capped at
    -0.12 absolute. A pick that goes from win_prob 0.65 -> 0.53 after a
    strong bear pass yields a recalibrated edge that may then fail the
    paper trader's edge floor — exactly the discipline the bear is meant
    to enforce."""
    for p in short_picks or []:
        if not isinstance(p, dict):
            continue
        tk = (p.get("ticker") or "").strip().upper()
        if not tk:
            continue
        bear_list = bear_by_ticker.get(tk) or []
        if not bear_list:
            continue
        existing = p.get("reasons_could_be_wrong") or []
        merged: list[str] = list(existing)
        added = 0
        for r_new in bear_list:
            if not isinstance(r_new, str) or len(r_new.strip()) < 20:
                continue
            if any(r_new.strip().lower()[:60] in e.lower() for e in merged):
                continue
            merged.append(r_new.strip())
            added += 1
        if not added:
            continue
        p["reasons_could_be_wrong"] = merged
        p["bear_pass_added"] = added
        # Dampen win_prob; recompute loss_prob; recompute expected_edge_pct.
        wp_orig = p.get("win_prob")
        if isinstance(wp_orig, (int, float)):
            dampen = min(0.12, 0.04 * added)
            p["win_prob_raw"] = float(wp_orig)
            p["win_prob"] = max(0.0, float(wp_orig) - dampen)
            p["loss_prob"] = 1.0 - p["win_prob"]
            R = p.get("expected_return_pct")
            L = p.get("expected_loss_pct")
            if isinstance(R, (int, float)) and isinstance(L, (int, float)):
                p["expected_edge_pct_raw"] = p.get("expected_edge_pct")
                p["expected_edge_pct"] = float(R) * p["win_prob"] - float(L) * p["loss_prob"]


def analyze(payload: dict, model_name: str | None = None) -> dict:
    """Run the strict-JSON market analysis. Signature preserved from
    analyzer.llm so callers swap with a one-line import change.

    Routes to analyze_ensemble when OPENROUTER_ENSEMBLE=1 so the env
    flag actually flips the pipeline. Without this guard the ensemble
    helpers existed but the entry point never called them. An explicit
    model_name override always uses the single-model path so a caller
    that pins a specific model (e.g. portfolio_score_llm) gets exactly
    what it asked for, not a 6-model fan-out."""
    if _ENSEMBLE_ON and model_name is None:
        print(f"OpenRouter ensemble mode ON; fanning out to "
              f"{len(_ENSEMBLE_MODELS)} models")
        return analyze_ensemble(payload)
    chain = _chain(model_name)
    print(f"OpenRouter primary: {chain[0]} | fallbacks: {chain[1:]}")
    user_msg = ("Analyze this market snapshot and return JSON per schema:\n\n"
                + _payload_json(payload))
    resp = _post(
        [{"role": "system", "content": SYSTEM_PROMPT},
         {"role": "user", "content": user_msg}],
        models=chain,
    )
    result = _parse_json(resp)
    # Adversarial bear pass on top_performers. Mirrors the Stock Analyst
    # bear pass: a second LLM call audits the A/B picks, splices concrete
    # failure modes into each entry's reasons_could_be_wrong, and dampens
    # win_prob + edge accordingly. Soft-fails: any error preserves the
    # bull result unchanged so a bear-pass hiccup never blocks the morning
    # pipeline. Doubles the pick-audit LLM cost on days picks land but
    # free quota covers it.
    try:
        sp = result.get("top_performers") if isinstance(result, dict) else None
        if isinstance(sp, list) and sp:
            bear = _short_pick_bear_pass(sp, payload, chain)
            if bear:
                _apply_short_pick_bear(sp, bear)
                result["top_performers_bear_pass_applied"] = sum(
                    1 for p in sp if isinstance(p, dict) and p.get("bear_pass_added")
                )
    except Exception as e:
        print(f"  top_performers bear pass outer: {str(e)[:120]}")
    return result


# ---------------------------------------------------------------------------
# Ensemble: run N models in parallel, merge by consensus.
# ---------------------------------------------------------------------------
_ENSEMBLE_ON = os.getenv("OPENROUTER_ENSEMBLE", "0").strip() in ("1", "true", "yes")
# Best-of-the-best free OpenRouter models picked for cross-family
# diversity (verified live on the openrouter free-models collection,
# 2026-06-19). Each entry is a different lab, each is >=30B active
# params, each carries 130K+ context. Diverse training corpora is what
# makes wisdom-of-crowds work; same-family ensembles (e.g. 2 Nemotrons)
# correlate too much to lift accuracy meaningfully.
#
#   nvidia/nemotron-3-super-120b-a12b   NVIDIA, 120B/12B-active MoE, 1M ctx (proven tight ranges)
#   openai/gpt-oss-120b                 OpenAI open-weight, 117B/5.1B-active, 131K ctx
#   google/gemma-4-31b-it               Google, 30.7B dense, 256K ctx
#   qwen/qwen3-next-80b-a3b-instruct    Alibaba Qwen, 80B/3B-active, 262K ctx (math-heavy)
#   meta-llama/llama-3.3-70b-instruct   Meta, 70B dense, 131K ctx
#
# Override with OPENROUTER_ENSEMBLE_MODELS to add Nous Hermes 405B or
# nex-agi if you provision more keys; default kept at 5 so it works
# cleanly with 3-5 keys via key-pool round-robin + cooldown.
_ENSEMBLE_MODELS = [m.strip() for m in os.getenv(
    "OPENROUTER_ENSEMBLE_MODELS",
    # Default rotated 2026-06-20 after runs 27862505785/27863570663/
    # 27864450733 showed Gemma and Llama hitting hard upstream daily
    # caps that retries could not clear. Replaced with cross-provider
    # alternatives that share no Llama / Google lineage with the rest:
    # - dolphin-mistral-24b-venice-edition: Mistral lineage, hosted
    #   by Cognitive Computations on a different upstream than Llama
    # - nex-n2-pro: nex-agi provider, Qwen3.5-derivative agentic
    #   model; different provider stack from Alibaba's Qwen3-next so
    #   their upstream caps fall on different counters.
    # Hermes-3-405b kept for one more Monday cycle; if it still 429s
    # after fresh quota, swap for nvidia/nemotron-3-nano-omni-30b-a3b-
    # reasoning:free (smaller NVIDIA, less throttled).
    "nvidia/nemotron-3-ultra-550b-a55b:free,"
    "openai/gpt-oss-120b:free,"
    "google/gemma-4-26b-a4b-it:free,"
    "qwen/qwen3-next-80b-a3b-instruct:free,"
    "nex-agi/nex-n2-pro:free,"
    "nousresearch/hermes-3-llama-3.1-405b:free",
).split(",") if m.strip()]


def _merge_performers(results: list[dict], key: str, n_models: int) -> list[dict]:
    """Aggregate a top_performers / worst_performers list across N model
    outputs by ticker. Consensus is signal: a name picked by 3/3 models
    is far stronger than one picked by 1/3. Each merged entry carries
    ensemble_votes + ensemble_n so the paper trader / grader can weight
    by agreement. Numeric fields are averaged across the models that
    listed the ticker; win_prob is additionally scaled by the vote
    fraction so a lone-wolf pick is automatically de-rated (a 1/3 pick
    with stated win_prob 0.7 lands at an effective ~0.47 -> likely below
    the entry gate, which is the wisdom-of-crowds discipline)."""
    def _norm(t):
        t = (t or "").strip().upper()
        return t if (t.endswith(".NS") or t.endswith(".BO") or t.startswith("^")) else f"{t}.NS"

    agg: dict[str, dict] = {}
    for res in results:
        for e in (res.get(key) or []):
            if not isinstance(e, dict):
                continue
            tk = _norm(e.get("ticker"))
            if not tk or tk == ".NS":
                continue
            a = agg.setdefault(tk, {"votes": 0, "move": [], "wp": [], "edge": [],
                                    "ret": [], "loss": [], "conv": [], "sample": e})
            a["votes"] += 1
            for fld, bucket in (("expected_move_pct", "move"), ("win_prob", "wp"),
                                ("expected_edge_pct", "edge"),
                                ("expected_return_pct", "ret"),
                                ("expected_loss_pct", "loss")):
                v = e.get(fld)
                if isinstance(v, (int, float)):
                    a[bucket].append(float(v))
            if e.get("conviction"):
                a["conv"].append(str(e["conviction"]).upper())

    merged: list[dict] = []
    for tk, a in agg.items():
        vote_frac = a["votes"] / max(1, n_models)
        avg = lambda xs: (sum(xs) / len(xs)) if xs else None
        wp = avg(a["wp"])
        eff_wp = (wp * vote_frac) if wp is not None else None
        entry = dict(a["sample"])  # carry thesis/entry/target/stop from one model
        entry["ticker"] = tk
        entry["ensemble_votes"] = a["votes"]
        entry["ensemble_n"] = n_models
        if avg(a["move"]) is not None:
            entry["expected_move_pct"] = round(avg(a["move"]), 2)
        if eff_wp is not None:
            entry["win_prob"] = round(eff_wp, 3)
            entry["loss_prob"] = round(1.0 - eff_wp, 3)
            entry["win_prob_stated_mean"] = round(wp, 3)
        # Recompute edge from the consensus-scaled win_prob when we have
        # the return/loss magnitudes; else keep the averaged stated edge.
        R, L = avg(a["ret"]), avg(a["loss"])
        if R is not None and L is not None and eff_wp is not None:
            entry["expected_return_pct"] = round(R, 2)
            entry["expected_loss_pct"] = round(L, 2)
            entry["expected_edge_pct"] = round(R * eff_wp - L * (1 - eff_wp), 3)
        elif avg(a["edge"]) is not None:
            entry["expected_edge_pct"] = round(avg(a["edge"]), 3)
        # Conviction = the modal tier across votes, defaulting B.
        if a["conv"]:
            entry["conviction"] = max(set(a["conv"]), key=a["conv"].count)
        merged.append(entry)

    # Rank by consensus first, then edge magnitude. Top list wants high
    # positive edge; worst list wants the most negative expected_move.
    if key == "top_performers":
        merged.sort(key=lambda e: (e.get("ensemble_votes", 0),
                                   e.get("expected_edge_pct") or -999), reverse=True)
    else:
        merged.sort(key=lambda e: (e.get("ensemble_votes", 0),
                                   -(e.get("expected_move_pct") or 0)), reverse=True)
    return merged[:15]


def _merge_results(results: list[dict]) -> dict:
    """Consensus-merge N full analysis dicts. Directional calls take a
    majority vote (split -> sideways + dampened confidence); top/worst
    performers aggregate by ticker via _merge_performers; everything
    user-specific (outlooks, verdicts, reasoning) is carried from the
    base (first, primary) model since voting adds little there and the
    base model is the strongest instruction-follower."""
    base = dict(results[0])
    n = len(results)

    def _majority_dir(path_keys):
        dirs = []
        for r in results:
            cur = r
            for k in path_keys:
                cur = (cur or {}).get(k) if isinstance(cur, dict) else None
            if isinstance(cur, str):
                dirs.append(cur.lower())
        if not dirs:
            return None, 0.0
        top = max(set(dirs), key=dirs.count)
        agreement = dirs.count(top) / len(dirs)
        return top, agreement

    # market_mood majority
    moods = [r.get("market_mood") for r in results if r.get("market_mood")]
    if moods:
        base["market_mood"] = max(set(moods), key=moods.count)
        agree = moods.count(base["market_mood"]) / len(moods)
        confs = [r.get("confidence") for r in results if isinstance(r.get("confidence"), (int, float))]
        if confs:
            # Mean confidence, scaled down when models disagree.
            base["confidence"] = int(round((sum(confs) / len(confs)) * (0.6 + 0.4 * agree)))
        base["ensemble_mood_agreement"] = round(agree, 2)

    # nifty + sensex direction majority, dampen confidence on split
    for okey in ("nifty_outlook", "sensex_outlook"):
        d, agree = _majority_dir([okey, "direction"])
        if d and isinstance(base.get(okey), dict):
            base[okey]["direction"] = d
            c = base[okey].get("confidence")
            if isinstance(c, (int, float)):
                base[okey]["confidence"] = int(round(c * (0.6 + 0.4 * agree)))
            base[okey]["ensemble_agreement"] = round(agree, 2)

    base["top_performers"] = _merge_performers(results, "top_performers", n)
    base["worst_performers"] = _merge_performers(results, "worst_performers", n)
    base["ensemble_models_used"] = n

    # Per-model compact vote ledger. Lets the grader score each ensemble
    # member individually and the /rankings page surface leaderboards.
    # Keep this small: just the directional calls + ticker lists, not
    # the full schema (raw_json would balloon if we kept all 6 dicts).
    per_model: dict[str, dict] = {}
    for r in results:
        slug = r.get("_ensemble_model") or "unknown"
        def _tickers(field):
            v = r.get(field)
            if not isinstance(v, list):
                return []
            out = []
            for e in v:
                if isinstance(e, dict) and e.get("ticker"):
                    out.append(e["ticker"])
            return out[:20]
        per_model[slug] = {
            "market_mood": r.get("market_mood"),
            "confidence": r.get("confidence"),
            "nifty_dir": (r.get("nifty_outlook") or {}).get("direction") if isinstance(r.get("nifty_outlook"), dict) else None,
            "nifty_conf": (r.get("nifty_outlook") or {}).get("confidence") if isinstance(r.get("nifty_outlook"), dict) else None,
            "sensex_dir": (r.get("sensex_outlook") or {}).get("direction") if isinstance(r.get("sensex_outlook"), dict) else None,
            "sensex_conf": (r.get("sensex_outlook") or {}).get("confidence") if isinstance(r.get("sensex_outlook"), dict) else None,
            "top_performers": _tickers("top_performers"),
            "worst_performers": _tickers("worst_performers"),
        }
    base["per_model_votes"] = per_model
    return base


def analyze_ensemble(payload: dict, models: list[str] | None = None) -> dict:
    """Run several models in PARALLEL on the same payload, each pinned to
    one model + its own key from the pool, then consensus-merge. This is
    the wisdom-of-the-silicon-crowd path: ensemble accuracy rivals a
    human crowd and beats any single model on calibration (research:
    ~75% -> ~80% on the sentiment-to-direction task). Falls back to a
    single analyze() call when fewer than 2 models succeed, so a flaky
    free endpoint degrades gracefully instead of failing the morning.

    Each model gets a distinct key (round-robin over the pool) so the
    fan-out does not serialize behind one key's per-minute limit."""
    from concurrent.futures import ThreadPoolExecutor, as_completed
    models = models or _ENSEMBLE_MODELS
    # Ensemble uses its own dedicated key pool, NOT the primary key. The
    # primary key is reserved for the Nemotron Super single-model path
    # and must not get burned by a 6-model fan-out. Numbered slots
    # OPENROUTER_API_KEY_1..3 (or the legacy OPENROUTER_API_KEYS list)
    # carry the ensemble-only keys.
    keys = _load_ensemble_keys()
    if not keys:
        # No ensemble keys configured at all. Degrade gracefully to the
        # single-model path (which uses the primary key) instead of
        # crashing the morning run.
        print("Ensemble keys not configured (OPENROUTER_API_KEY_1..3 / "
              "OPENROUTER_API_KEYS); falling back to single-model path")
        return analyze(payload, model_name=PRIMARY_MODEL)
    # Word-form key count so GitHub Actions secret masking does not
    # redact the digit. Helps confirm whether OPENROUTER_API_KEYS is
    # actually loaded as a multi-key pool rather than just the primary.
    words = ["zero","one","two","three","four","five","six","seven","eight"]
    pool_word = words[len(keys)] if 0 <= len(keys) < len(words) else f"n={len(keys)}"
    print(f"Ensemble key pool size: {pool_word} keys; "
          f"models per key: ~{(len(models) + max(1,len(keys)) - 1) // max(1,len(keys))}")
    # SHA-256 fingerprints (first 8 hex chars). Safe to log: irreversible.
    # The user can compute the same hash on each candidate key locally to
    # identify which slot loaded which key, so a "still untouched" key
    # claim from the dashboard can be cross-checked against the actual
    # pool here. Also confirms the dedup did not silently collapse two
    # keys that look different but are actually identical.
    fps = _key_fingerprints(keys)
    # 1-indexed display matches the OPENROUTER_API_KEY_1/2/3 secret
    # names. Internal pool index stays 0-based (Python list), but the
    # log uses N+1 so the user can map a fingerprint to a secret name
    # without mental arithmetic.
    for i, fp in enumerate(fps):
        print(f"  key #{i+1} fp=sha256:{fp}")
    user_msg = ("Analyze this market snapshot and return JSON per schema:\n\n"
                + _payload_json(payload))
    msgs = [{"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_msg}]

    # Models that natively support the OpenRouter `reasoning` field.
    # Sending it to an instruct-only model triggers 400 Bad Request on
    # some providers (Llama 3.3, gpt-oss-120b silently returns empty,
    # Gemma + Hermes 429 then 400). Default to NO reasoning for any
    # model not on this allowlist; the single-model PRIMARY_MODEL path
    # still gets reasoning=True because it pins to a known-reasoning
    # Nemotron checkpoint.
    _REASONING_OK = ("nemotron-3-ultra", "nemotron-3-super",
                     "qwen3-next", "deepseek-r1", "gpt-5", "o1")

    attempts: list[dict] = []

    def _classify(err: str) -> str:
        e = err.lower()
        if "400" in e:
            return "http_400"
        if "429" in e:
            return "http_429"
        if "timeout" in e or "read timed out" in e:
            return "timeout"
        return "other"

    # Pre-compute key->fp lookup once so per-call logs map every request
    # to its key fingerprint without re-hashing six times in the loop.
    _fp_lookup = dict(zip(keys, _key_fingerprints(keys))) if keys else {}

    def _one(model_key):
        model, key = model_key
        # Disable reasoning trace for ensemble fan-out entirely. Even with
        # max_tokens=32000, Nemotron Ultra still truncated at char 13310
        # on a real run because the provider treats max_tokens as a hard
        # total cap and reasoning chews most of it before the final JSON
        # starts. Ensemble accuracy depends on the JSON answer landing
        # complete, not on visible chain-of-thought we never read; the
        # underlying model still reasons internally without us asking it
        # to emit the trace. Single-model PRIMARY path keeps reasoning on
        # because it has the full 1M ctx and we read the trace for
        # debugging there.
        use_reasoning = False
        use_json_format = any(tag in model for tag in _JSON_FORMAT_OK)
        fp_short = _fp_lookup.get(key or "", "noop")
        # Per-call attribution: log the moment a model starts on a key,
        # and again on result with status + latency. Lets the user trace
        # any single call back to its key fingerprint without trusting
        # OpenRouter dashboard caching.
        print(f"  > start  model={model.split('/')[-1].replace(':free','')} "
              f"key=fp:{fp_short}")
        t0 = time.monotonic()
        try:
            # Pin to a single model (no fallback chain) so we get genuine
            # cross-model diversity, not three calls to the same primary.
            # no_rotate=True keeps retries on the same key so a per-model
            # upstream throttle does not steal retries from a sibling key.
            resp = _post(msgs, models=[model], api_key=key, timeout=300,
                         max_retries=4, reasoning=use_reasoning,
                         json_format=use_json_format,
                         max_tokens=16000,
                         no_rotate=True)
            res = _parse_json(resp)
            latency_ms = int((time.monotonic() - t0) * 1000)
            if isinstance(res, dict) and not res.get("error"):
                res["_ensemble_model"] = model
                attempts.append({"model_slug": model, "status": "ok",
                                 "latency_ms": latency_ms,
                                 "error_snippet": None})
                print(f"  < OK     model={model.split('/')[-1].replace(':free','')} "
                      f"key=fp:{fp_short} {latency_ms}ms")
                return res
            # Surface what was actually wrong instead of "non-dict / empty:
            # dict" which hides the embedded error. Distinguish three
            # cases so /rankings can read the real failure mode.
            err_msg = ""
            if isinstance(res, dict) and res.get("error"):
                err_obj = res.get("error")
                err_msg = json.dumps(err_obj)[:240] if not isinstance(err_obj, str) else err_obj[:240]
                status = "empty"
            else:
                err_msg = f"non-dict / empty: {type(res).__name__}"
                status = "empty"
            print(f"  ensemble model {model} returned error/empty: {err_msg}")
            attempts.append({"model_slug": model, "status": status,
                             "latency_ms": latency_ms,
                             "error_snippet": err_msg})
            print(f"  < {status:4} model={model.split('/')[-1].replace(':free','')} "
                  f"key=fp:{fp_short} {latency_ms}ms")
        except Exception as e:
            latency_ms = int((time.monotonic() - t0) * 1000)
            snippet = f"{type(e).__name__}: {str(e)[:120]}"
            status = _classify(snippet)
            print(f"  < {status:4} model={model.split('/')[-1].replace(':free','')} "
                  f"key=fp:{fp_short} {latency_ms}ms err={snippet[:60]}")
            attempts.append({"model_slug": model, "status": status,
                             "latency_ms": latency_ms,
                             "error_snippet": snippet})
        return None

    # Per-key worker groups. Round-robin assigns models to keys, then
    # each key gets its own thread that processes its assigned models
    # SEQUENTIALLY. With 6 models + 3 keys: key[0]=[m0,m3], key[1]=[m1,m4],
    # key[2]=[m2,m5]. Three threads run in parallel; within each thread
    # models execute one at a time so we never exceed 1 in-flight request
    # per key (well under the 20 RPM per-key OpenRouter cap). Eliminates
    # the bug where one key absorbed both other keys' retries when their
    # first attempt 429'd, leaving the third key idle.
    if keys:
        groups: list[list[tuple[str, str]]] = [[] for _ in range(len(keys))]
        for i, m in enumerate(models):
            groups[i % len(keys)].append((m, keys[i % len(keys)]))
    else:
        groups = [[(m, None) for m in models]]  # type: ignore[list-item]

    def _run_group(group: list[tuple[str, str]]) -> list[dict]:
        out: list[dict] = []
        for mk in group:
            r = _one(mk)
            if r:
                out.append(r)
        return out

    workers = max(1, len(groups))
    results: list[dict] = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(_run_group, g) for g in groups]
        for f in as_completed(futs):
            results.extend(f.result())
    print(f"Ensemble: {len(results)}/{len(models)} models returned usable JSON")
    # Per-key attempt tally so the user can see distribution at a glance.
    # Without this, "key 3 is untouched" was hard to refute from logs.
    by_key: dict[str, int] = {}
    by_key_ok: dict[str, int] = {}
    if keys:
        fps = _key_fingerprints(keys)
        key_to_fp = dict(zip(keys, fps))
        for grp_idx, group in enumerate(groups):
            slot_label = f"key #{grp_idx+1}"
            fp = key_to_fp.get(group[0][1] if group else "", "noop")
            group_models = [m for m, _ in group]
            hits = sum(1 for a in attempts if a.get("model_slug") in group_models)
            oks = sum(1 for a in attempts
                      if a.get("model_slug") in group_models
                      and a.get("status") == "ok")
            by_key[slot_label] = hits
            by_key_ok[slot_label] = oks
            print(f"  {slot_label} fp=sha256:{fp} "
                  f"models={','.join(m.split('/')[-1].replace(':free','') for m in group_models)} "
                  f"attempts={hits} ok={oks}")

    if len(results) < 2:
        print("Ensemble degraded to single-model analyze()")
        # Pin a model so analyze() takes the single-model path; without
        # this, analyze() sees _ENSEMBLE_ON=True and routes back into
        # analyze_ensemble, creating an infinite loop.
        fallback = analyze(payload, model_name=PRIMARY_MODEL)
        # Keep the attempts list so the /rankings page can still show
        # why every other model failed even on a degraded run.
        if isinstance(fallback, dict):
            fallback["ensemble_attempts"] = attempts
        return fallback

    merged = _merge_results(results)
    merged["ensemble_attempts"] = attempts
    # One bear pass on the merged top_performers (consensus list), same as
    # the single-model path.
    try:
        sp = merged.get("top_performers")
        if isinstance(sp, list) and sp:
            bear = _short_pick_bear_pass(sp, payload, _ENSEMBLE_MODELS[:1] or [PRIMARY_MODEL])
            if bear:
                _apply_short_pick_bear(sp, bear)
                merged["top_performers_bear_pass_applied"] = sum(
                    1 for p in sp if isinstance(p, dict) and p.get("bear_pass_added"))
    except Exception as e:
        print(f"  ensemble bear pass: {str(e)[:120]}")
    return merged


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
