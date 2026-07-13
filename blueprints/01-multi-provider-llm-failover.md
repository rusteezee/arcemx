BLUEPRINT 1: Multi-provider LLM failover (Gemini + Groq behind llm_router)

BUILDER: Claude Sonnet, working alone, cold start, cannot ask questions.
(Cross-cutting change to the LLM client with retry/parse subtleties — needs Sonnet.)

GOAL
When OpenRouter is down, rate-limited, or silently degrades, the daily analysis pipeline
completes anyway by falling through to Google Gemini and then Groq — two providers on
completely independent infrastructure. Zero recurring cost.

CONTEXT THE BUILDER NEEDS
- Files to read first: `analyzer/llm_router.py` (whole file — the only LLM client in the
  repo), `.github/workflows/daily_analysis.yml`, `analyzer/aggregator.py:594-660`.
- Current state: `_post()` (llm_router.py:549) speaks only OpenRouter
  (https://openrouter.ai/api/v1/chat/completions), retrying through a model chain
  `_chain()` = [PRIMARY_MODEL] + FALLBACK_CHAIN (nemotron-3-super-120b:free,
  gpt-oss-120b:free, gpt-oss-20b:free). Every LLM caller in the repo goes through
  `_post()` + `_parse_json()`.
- Researched facts (July 2026, verified): Gemini API free tier — model
  `gemini-3-flash`, ~10 req/min, ~1,500 req/day, endpoint
  `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={GEMINI_API_KEY}`,
  OpenAI-compat endpoint also exists at
  `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` with
  `Authorization: Bearer {GEMINI_API_KEY}` — USE THE OPENAI-COMPAT ENDPOINT so the
  existing message/response parsing works unchanged. Groq free tier —
  `https://api.groq.com/openai/v1/chat/completions`, model `llama-3.3-70b-versatile`
  (~1,000 req/day, 30 RPM), fully OpenAI-compatible.
- Gotchas: (1) `_parse_json()` (llm_router.py:750) expects
  `resp["choices"][0]["message"]["content"]` — both new providers' OpenAI-compat
  endpoints return exactly this shape. (2) The reasoning opt-out body key
  `{"reasoning": {"enabled": False, "exclude": True}}` is OpenRouter-ONLY — it must NOT
  be sent to Gemini/Groq (Gemini 400s on unknown fields). (3) `response_format:
  {"type": "json_object"}` works on all three. (4) Free-model catalogs change without
  notice — model names must come from env vars with defaults, never hardcoded inline.

CONSTRAINTS
- Must stay inside: `analyzer/llm_router.py`, `.github/workflows/*.yml` (env additions
  only), `db/schema.sql` (comment only, no DDL).
- Must not change: `_parse_json` output contract (`_model_used` tagging), `analyze()` /
  `analyze_portfolio()` signatures, SYSTEM_PROMPT, any caller.
- Stack to respect: stdlib `urllib`-style requests via the existing `requests` usage in
  the file; no new dependencies.
- Non-negotiables: ₹0 recurring. OpenRouter remains PRIMARY (its free 120B models are
  stronger than Groq's 70B); escalation to other providers only on chain exhaustion.

STEP-BY-STEP PLAN
1. `analyzer/llm_router.py` — add a provider registry near the model constants (~line 100):
   ```python
   _PROVIDERS = [
       {  # order matters: strongest models first
           "name": "openrouter",
           "url": "https://openrouter.ai/api/v1/chat/completions",
           "key_env": "OPENROUTER_API_KEY",
           "chain_env": "OPENROUTER_FALLBACKS",   # existing behavior unchanged
           "supports_reasoning_optout": True,
       },
       {
           "name": "gemini",
           "url": "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
           "key_env": "GEMINI_API_KEY",
           "chain_env": "GEMINI_MODELS",           # default "gemini-3-flash"
           "supports_reasoning_optout": False,
       },
       {
           "name": "groq",
           "url": "https://api.groq.com/openai/v1/chat/completions",
           "key_env": "GROQ_API_KEY",
           "chain_env": "GROQ_MODELS",             # default "llama-3.3-70b-versatile"
           "supports_reasoning_optout": False,
       },
   ]
   ```
2. `analyzer/llm_router.py` — extract the current single-provider request loop inside
   `_post()` into `_post_provider(provider, messages, models, **kw)` keeping ALL existing
   behavior (SSE parse, `_content_ok`, per-key cooldown, model-head advance). Only two
   provider-conditional changes: request URL/auth header from the registry, and the
   reasoning-optout body key sent only when `supports_reasoning_optout`.
3. `analyzer/llm_router.py` — rewrite `_post()` as the escalation loop: for each provider
   in `_PROVIDERS`, skip if `os.getenv(key_env)` is empty; call `_post_provider`; return
   on first usable response. Tag the parsed result's `_model_used` as
   `f"{provider['name']}/{model}"` for non-openrouter providers (openrouter already
   returns full slugs). If every provider exhausts, return the last error dict exactly as
   today so `aggregator.save()` still drops it.
4. `analyzer/llm_router.py` — log one line per escalation:
   `print(f"provider {name} exhausted -> escalating")` so GH Actions logs show the path taken.
5. `.github/workflows/daily_analysis.yml`, `daily_grader.yml`, `sensei_eod.yml`,
   `stock_analyst.yml`, `calculator.yml`, `portfolio_score.yml` — add to each `env:` block:
   `GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}` and
   `GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}`.
6. Tell the user (in the final summary) to: create a free Gemini API key at
   aistudio.google.com and a free Groq key at console.groq.com, then run
   `gh secret set GEMINI_API_KEY` and `gh secret set GROQ_API_KEY`, and add both to
   Render's env via the dashboard or API. The chain degrades gracefully while unset.

EXACT INPUTS TO USE
- Kick-off prompt: "Implement blueprint 01-multi-provider-llm-failover.md from
  C:\Users\rahul\Downloads\stock-ai\blueprints\. Read the blueprint fully, then the
  files it names, then build exactly what it says."
- Test command (works without new keys — proves no regression):
  `cd C:\Users\rahul\Downloads\stock-ai && .venv\Scripts\python.exe -c "from analyzer.llm_router import _PROVIDERS, _post; print([p['name'] for p in _PROVIDERS])"`

DEFINITION OF DONE
[ ] With only OPENROUTER_API_KEY set, behavior is byte-identical to today (openrouter
    first, same chain, same retries) — verified by running the test command above plus
    one real `analyze_portfolio()`-style call.
[ ] With a fake OPENROUTER_API_KEY and a real GEMINI_API_KEY, a test call escalates to
    Gemini and returns parsed JSON with `_model_used` = "gemini/gemini-3-flash".
[ ] Reasoning-optout key is never sent to gemini/groq (assert in code review of the diff).
[ ] All 6 workflow files carry the two new env lines.
[ ] No new pip dependencies. `.venv\Scripts\python.exe -m py_compile analyzer/llm_router.py` passes.

IF SOMETHING IS UNCLEAR
Smallest safe assumption, tag "ASSUMPTION:", keep going. Do not restructure `_parse_json`
or touch SYSTEM_PROMPT under any circumstance.
