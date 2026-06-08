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

from analyzer.llm import SYSTEM_PROMPT  # re-exported below

load_dotenv()

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_KEY = os.getenv("OPENROUTER_API_KEY")

# Primary: NVIDIA Nemotron 3 Ultra (free). 550B/55B-active MoE,
# IFBench 81.7 instruction-following, 1M context, native JSON +
# tool calling, May-2026 post-train cutoff. Strong on the dimension
# that matters most for our strict-JSON prompt: following the rules.
PRIMARY_MODEL = os.getenv("OPENROUTER_PRIMARY", "nvidia/nemotron-3-ultra:free")

# OpenRouter routes through this list left-to-right. If the primary
# is rate-limited or fails, the next model serves the same request.
# Ordered: best free reasoner first, generalists after as safety net.
_FALLBACK_RAW = os.getenv(
    "OPENROUTER_FALLBACKS",
    "deepseek/deepseek-chat:free,google/gemini-2.0-flash-exp:free",
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
        return r.json()
    raise RuntimeError(f"OpenRouter retries exhausted: {last_err}")


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
