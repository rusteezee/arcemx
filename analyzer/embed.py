"""Phase 1 RAG: tape-state embedding + similarity-retrieval helpers.

Replaces feedback._mine_exemplars score-recency selection with
similarity retrieval over past graded calls. Embeds each call's
historical tape state (VIX, DMA distances, RSI, sector breadth,
flows) plus the model's own stated mood + confidence at the time,
then at morning-call time retrieves the k most-similar past setups
so the prompt shows the model "when the tape looked like THIS,
you called X and the result was Y."

GH-Actions-only. Render's 512 MB dyno cannot host torch +
sentence-transformers (the 12/06/2026 OOM was triggered by a much
lighter import surface), so feedback.py imports this module lazily
and soft-fails to Phase 0 selection when the import fails.

Model: Qwen/Qwen3-Embedding-0.6B (MTEB SOTA in its size class as of
12/2025, 1024-dim output, Apache 2.0, ~1.2 GB on-disk). Fallbacks
to BAAI/bge-large-en-v1.5 (also 1024-dim) when Qwen fails to load,
then to MiniLM-L6-v2 (384-dim, zero-padded to 1024) as a last
resort so the pipeline can still ship something.

Storage: prediction_embeddings (analysis_id, dimension) holds the
encoded vector + feature_text used to produce it + the realized
outcome_score. ivfflat index on cosine distance, match_exemplars
RPC returns the k nearest per dim.
"""
import gc
import math
from datetime import datetime, timedelta, timezone

# Module-level singleton. Loading the model on every call would
# eat the 3-5 second cold-start over and over inside the grader's
# per-row loop. Holding it on the module keeps it for the GH job's
# lifetime.
_MODEL = None
_MODEL_NAME = None

# BGE-base-en-v1.5 is the no-compromise quality pick: 109M params,
# MTEB 63.5 (within 0.8 points of Qwen3-Embedding-0.6B's 64.3 and
# essentially matching BGE-large's 64.2), runs ~200 ms/text on CPU
# so the 511-row backfill completes in ~2 min and the daily
# incremental embed adds ~3 sec. Native 768 dim is zero-padded to
# the SQL vector(1024) column; padding does not degrade cosine
# retrieval because the actual signal lives in the first 768 dims.
#
# Swap history:
#   v1 Qwen3-Embedding-0.6B   (600M, CPU 3 s/text, backfill hung 55 min)
#   v2 MiniLM-L6              (22M, CPU 50 ms/text, MTEB 56.3 - too weak)
#   v3 BGE-base-en-v1.5       (THIS - 109M, balanced)
#
# To swap again: change _PRIMARY, push, re-run daily_grader.yml with
# backfill=true AND force=true so the existing rows get re-embedded
# under the new model.
#
# SINGLE-MODEL PIN (25/06): _FALLBACKS is now empty. The old chain
# silently fell through to MiniLM when bge failed to load (which is
# exactly what happened on the historic backfill: those rows are
# 384-dim MiniLM while every recent row is 768-dim bge-base), leaving
# the store with two incompatible embedding spaces. Cosine similarity
# across spaces is meaningless, so a silent cross-model fallback is
# worse than writing no row at all: if bge-base cannot load, raise and
# let the caller soft-fail (the grader's _embed step swallows it and
# retries next run) rather than poison the store. Phase B re-embeds the
# legacy MiniLM rows under bge-base before activating retrieval.
_PRIMARY = "BAAI/bge-base-en-v1.5"
_FALLBACKS: list[str] = []

# SQL column is vector(1024). bge-base emits 768 dims, zero-padded to
# 1024; retrieval similarity stays directional under zero-padding as
# long as EVERY row uses the same model (now enforced by the pin above).
TARGET_DIM = 1024


def get_model():
    """Lazy-load the embedder. Raises RuntimeError if no backend is
    available (caller must catch and fall back to Phase 0)."""
    global _MODEL, _MODEL_NAME
    if _MODEL is not None:
        return _MODEL
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError as e:
        raise RuntimeError(f"sentence-transformers not installed: {e}") from e
    last_err = None
    for name in [_PRIMARY] + _FALLBACKS:
        try:
            _MODEL = SentenceTransformer(name, device="cpu")
            _MODEL_NAME = name
            print(f"embed: loaded {name}")
            return _MODEL
        except Exception as e:
            print(f"embed: load {name} failed: {str(e)[:120]}")
            last_err = e
            continue
    raise RuntimeError(f"embed: no model could be loaded; last: {last_err}")


def encode(texts: list[str]) -> list[list[float]]:
    """Encode a list of strings into 1024-dim normalized float vectors.

    Pads shorter-dim fallback models with zeros so the SQL vector(1024)
    column shape stays consistent. Normalization is on so cosine
    distance reduces to dot product at retrieval time, which matches
    the ivfflat vector_cosine_ops index built on the column.
    """
    m = get_model()
    arr = m.encode(texts, normalize_embeddings=True, convert_to_numpy=True)
    out = []
    for v in arr:
        lst = [float(x) for x in v]
        if len(lst) < TARGET_DIM:
            lst = lst + [0.0] * (TARGET_DIM - len(lst))
        elif len(lst) > TARGET_DIM:
            lst = lst[:TARGET_DIM]
        out.append(lst)
    return out


def features_to_text(feat: dict) -> str:
    """Compact tape-state line. Order is fixed so the same key always
    appears at the same position across rows; this matters because
    transformer attention is positional and a stable layout lets
    similar setups embed similarly. Missing keys are dropped (not
    zero-filled) so the encoder sees signal, not "no data" noise.
    """
    parts = []
    keymap = [
        ("mood", "stated_mood"),
        ("conf", "stated_confidence"),
        ("call", "stated_call"),
        ("vix", "india_vix"),
        ("vix_chg", "india_vix_change_pct"),
        ("dma20", "nifty_dma20_dist_pct"),
        ("dma50", "nifty_dma50_dist_pct"),
        ("rsi", "nifty_rsi14"),
        ("nifty_5d", "nifty_change_5d_pct"),
        ("nifty_20d", "nifty_change_20d_pct"),
        ("wkday", "weekday"),
        ("month", "month"),
    ]
    for short, full in keymap:
        v = feat.get(full)
        if v is None or v == "" or (isinstance(v, float) and math.isnan(v)):
            continue
        if isinstance(v, float):
            parts.append(f"{short}={v:.2f}")
        elif isinstance(v, bool):
            parts.append(f"{short}={'y' if v else 'n'}")
        else:
            parts.append(f"{short}={v}")
    return " ".join(parts) or "no features"


def _yf_features_on_date(target_date) -> dict:
    """Recompute tape state on `target_date` from yfinance. Cached
    rows for nearby dates do not exist in the prices table so we go
    direct to NIFTY + INDIA VIX history. Soft-fails on every yf hiccup
    by returning the partial dict it managed to assemble.

    `target_date` is a date (or datetime) in IST roughly. We fetch a
    60-trading-day window ending at that date and read the latest bar
    inside it as the t-0 close.

    yfinance silently retries on rate-limit / 429 with no client
    timeout, which froze the 12/06/2026 backfill for 55+ minutes
    without a single log line. We wrap each yf.download in a
    threaded timeout (10 s hard cap per call); on hit the call
    returns empty and the feature falls through, never blocking
    the backfill loop on a single stuck ticker.
    """
    import yfinance as yf
    import pandas as pd
    import threading

    def _yf_download_with_timeout(symbol, start, end, timeout=10):
        result_holder: dict = {"df": None}
        def _do():
            try:
                result_holder["df"] = yf.download(
                    symbol, start=start, end=end, progress=False, auto_adjust=False,
                )
            except Exception as e:
                result_holder["err"] = str(e)[:120]
        th = threading.Thread(target=_do, daemon=True)
        th.start()
        th.join(timeout)
        if th.is_alive():
            # Thread leaks but is daemon; will die with the process.
            return None
        return result_holder.get("df")

    out: dict = {}
    try:
        if hasattr(target_date, "date"):
            d = target_date.date()
        else:
            d = target_date
        # Fetch a 120-cal-day window ending day-after to be safe; we
        # need ~60 trading days for stable DMA50 / RSI14.
        start = (d - timedelta(days=120)).isoformat()
        end = (d + timedelta(days=2)).isoformat()
        ny = _yf_download_with_timeout("^NSEI", start, end, timeout=10)
        if ny is None or ny.empty:
            return out
        # yfinance can return MultiIndex columns when one ticker is
        # requested as a list; coerce.
        if isinstance(ny.columns, pd.MultiIndex):
            ny.columns = [c[0] for c in ny.columns]
        ny = ny.dropna(subset=["Close"])
        if ny.empty:
            return out
        # Last bar on or before the target date.
        cutoff = pd.Timestamp(d).tz_localize(None)
        ny_idx = ny.index.tz_localize(None) if ny.index.tz is not None else ny.index
        ny = ny.loc[ny_idx <= cutoff]
        if ny.empty:
            return out
        close = float(ny["Close"].iloc[-1])
        # DMA20 / DMA50 distance as percent of current close
        if len(ny) >= 20:
            dma20 = float(ny["Close"].tail(20).mean())
            out["nifty_dma20_dist_pct"] = round((close - dma20) / dma20 * 100, 2) if dma20 else None
        if len(ny) >= 50:
            dma50 = float(ny["Close"].tail(50).mean())
            out["nifty_dma50_dist_pct"] = round((close - dma50) / dma50 * 100, 2) if dma50 else None
        # 5d / 20d returns
        if len(ny) >= 6:
            out["nifty_change_5d_pct"] = round(
                (close - float(ny["Close"].iloc[-6])) / float(ny["Close"].iloc[-6]) * 100, 2
            )
        if len(ny) >= 21:
            out["nifty_change_20d_pct"] = round(
                (close - float(ny["Close"].iloc[-21])) / float(ny["Close"].iloc[-21]) * 100, 2
            )
        # RSI14 Wilder
        if len(ny) >= 15:
            delta = ny["Close"].diff().dropna()
            gain = delta.clip(lower=0).tail(14).mean()
            loss = (-delta.clip(upper=0)).tail(14).mean()
            if loss > 0:
                rs = gain / loss
                out["nifty_rsi14"] = round(100 - (100 / (1 + rs)), 1)
            elif gain > 0:
                out["nifty_rsi14"] = 100.0
        # INDIA VIX close + change
        vx = _yf_download_with_timeout("^INDIAVIX", start, end, timeout=10)
        if vx is not None and not vx.empty:
            if isinstance(vx.columns, pd.MultiIndex):
                vx.columns = [c[0] for c in vx.columns]
            vx = vx.dropna(subset=["Close"])
            if not vx.empty:
                vx_idx = vx.index.tz_localize(None) if vx.index.tz is not None else vx.index
                vx = vx.loc[vx_idx <= cutoff]
                if not vx.empty:
                    vix = float(vx["Close"].iloc[-1])
                    out["india_vix"] = round(vix, 2)
                    if len(vx) >= 2:
                        prev = float(vx["Close"].iloc[-2])
                        if prev > 0:
                            out["india_vix_change_pct"] = round((vix - prev) / prev * 100, 2)
        # Calendar features
        out["weekday"] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"][d.weekday()]
        out["month"] = d.month
    except Exception as e:
        print(f"  yf features on {target_date} skipped: {str(e)[:100]}")
    return out


def features_for_analysis(raw_json: dict, run_at_iso: str) -> dict:
    """Build a feature dict for a single graded analysis row. Combines:
    (a) the model's own stated view at call time (mood, confidence,
    nifty direction call) — already in raw_json output — and
    (b) recomputed tape state on the prediction date via yfinance.

    The model's stated view captures what the model SAW; the tape
    state captures what the market actually showed. Embedding both
    together gives similarity that respects both axes.
    """
    feat: dict = {}
    if isinstance(raw_json, dict):
        mood = raw_json.get("market_mood")
        if mood:
            feat["stated_mood"] = str(mood).lower()
        conf = raw_json.get("confidence")
        if isinstance(conf, (int, float)):
            feat["stated_confidence"] = round(float(conf), 1)
        nifty = raw_json.get("nifty_outlook") or {}
        if isinstance(nifty, dict):
            direction = nifty.get("direction")
            if direction:
                feat["stated_call"] = str(direction).lower()
    # Tape state from yfinance at the run_at date
    try:
        run_at = datetime.fromisoformat(run_at_iso.replace("Z", "+00:00"))
        # IST date the call was made on
        ist = run_at + timedelta(hours=5, minutes=30)
        feat.update(_yf_features_on_date(ist.date()))
    except Exception as e:
        print(f"  features_for_analysis date parse fail: {str(e)[:80]}")
    return feat
