"""Build a strict, honest self-feedback block from the scored track record.

Injected into the Gemini prompt so each new call confronts its real
performance: per-dimension accuracy, confidence calibration error, the
specific recent predictions it got wrong, and hard corrective rules. The
goal is brutal honesty, not encouragement. LLMs calibrate far better from
concrete recent misses ("on 02/06 you called up, NIFTY fell 1.2%") than
from vague advice, so we surface both the aggregates and the specifics.
"""
import os
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()


def _sb():
    url, key = os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY")
    if not url or not key:
        return None
    return create_client(url, key)


def _latest_summaries(sb) -> dict[tuple, dict]:
    res = sb.table("accuracy_summary").select("*").order(
        "computed_at", desc=True
    ).limit(300).execute()
    latest: dict[tuple, dict] = {}
    for r in (res.data or []):
        k = (r["window_days"], r["dimension"])
        if k not in latest:
            latest[k] = r
    return latest


def _direction_history(sb) -> list[dict]:
    """Recent direction predictions joined to their analysis date + the
    confidence the model stated when it made them. FK-independent join."""
    # Newest first so the 200-row cap keeps the RECENT track record once
    # history grows past it (unordered reads return an arbitrary subset).
    ds = sb.table("prediction_scores").select(
        "analysis_id,score,delta,predicted"
    ).eq("dimension", "direction_1d").order(
        "id", desc=True).limit(200).execute().data or []
    ids = list({r["analysis_id"] for r in ds if r.get("analysis_id") is not None})
    meta: dict[int, dict] = {}
    if ids:
        ar = sb.table("analysis").select("id,run_at,raw_json").in_(
            "id", ids
        ).execute().data or []
        meta = {a["id"]: a for a in ar}
    items = []
    for s in ds:
        a = meta.get(s.get("analysis_id"))
        if not a:
            continue
        raw = a.get("raw_json") or {}
        conf = raw.get("confidence")
        items.append({
            "date": (a.get("run_at") or "")[:10],
            "score": s.get("score"),
            "delta": s.get("delta"),
            "called": (s.get("predicted") or {}).get("direction"),
            "confidence": conf if isinstance(conf, (int, float)) else None,
        })
    items.sort(key=lambda x: x["date"])
    return items


def _retrieve_exemplars_by_similarity(sb, dim: str, k: int = 6) -> list[dict]:
    """Phase 1 RAG: retrieve the k past graded calls most similar to
    TODAY's tape state, return compact exemplars annotated with
    similarity. Replaces the score-filter-by-recency selection
    (_mine_exemplars) when sentence-transformers is available.

    Soft-fails to Phase 0 (_mine_exemplars) when:
      - sentence-transformers / torch is not installed (Render
        in-process fallback path)
      - prediction_embeddings is empty (pre-backfill)
      - yfinance cannot synthesise today's feature vector
      - match_exemplars RPC errors

    Bot's in-process fallback path therefore always works, just in
    degraded Phase 0 mode rather than Phase 1.

    DEFERRED TO PHASE B (25/06): Phase 1 is gated off by default. The
    match_exemplars RPC was never created in Supabase, so this path
    always failed at the RPC and fell back to Phase 0 anyway, while still
    paying the query-time cost of loading the embedder and encoding
    today's vector on every grader run. At the current data scale
    (~70 vectors/dimension) similarity retrieval is no better than the
    recency mining Phase 0 already does, and the embedding store is
    mixed-model (an old MiniLM backfill plus the current bge-base) so
    cross-space matches would be noise. The embedding PRODUCER stays on
    (it accumulates a clean bge-base dataset for a Phase B activation),
    but this CONSUMER short-circuits to Phase 0 until then. To activate:
    create match_exemplars + the ivfflat index, re-embed the legacy
    rows under one model, then set RAG_PHASE1_ENABLED=1.
    """
    if os.getenv("RAG_PHASE1_ENABLED", "0").strip() not in ("1", "true", "yes"):
        return _mine_exemplars(sb, dim, n_each=3)
    try:
        from analyzer.embed import (
            encode, features_to_text, _yf_features_on_date,
        )
    except ImportError as e:
        print(f"  retrieve_exemplars: sentence-transformers absent; falling back to Phase 0: {str(e)[:120]}")
        return _mine_exemplars(sb, dim, n_each=3)

    # Build today's feature vector. Same shape as the backfill /
    # incremental embed; we synthesise stated_mood + stated_confidence
    # from the LATEST analysis row (the model's most-recent stated
    # view is closest to today's setup) and recompute tape state at
    # today's date via yfinance. Cheaper than a per-dim retrieval
    # rebuild since the same query vector serves every dim.
    try:
        from datetime import datetime as _dt, timezone as _tz
        latest = sb.table("analysis").select("raw_json,run_at").order(
            "run_at", desc=True).limit(1).execute().data or []
        feat = {}
        if latest:
            raw = latest[0].get("raw_json") or {}
            mood = raw.get("market_mood")
            if mood:
                feat["stated_mood"] = str(mood).lower()
            conf = raw.get("confidence")
            if isinstance(conf, (int, float)):
                feat["stated_confidence"] = round(float(conf), 1)
            nifty = raw.get("nifty_outlook") or {}
            if isinstance(nifty, dict):
                direction = nifty.get("direction")
                if direction:
                    feat["stated_call"] = str(direction).lower()
        feat.update(_yf_features_on_date(_dt.now(_tz.utc).date()))
        text = features_to_text(feat)
    except Exception as e:
        print(f"  retrieve_exemplars: today-features build failed; falling back: {str(e)[:120]}")
        return _mine_exemplars(sb, dim, n_each=3)

    try:
        vec = encode([text])[0]
    except Exception as e:
        print(f"  retrieve_exemplars: encode failed; falling back: {str(e)[:120]}")
        return _mine_exemplars(sb, dim, n_each=3)

    try:
        res = sb.rpc("match_exemplars", {
            "query_embedding": vec,
            "dim": dim,
            "match_count": max(k * 2, 12),  # pull extra so we can stratify wins / losses below
        }).execute().data or []
    except Exception as e:
        print(f"  retrieve_exemplars: RPC failed; falling back: {str(e)[:120]}")
        return _mine_exemplars(sb, dim, n_each=3)

    if not res:
        return _mine_exemplars(sb, dim, n_each=3)

    # Pull the per-row predicted / actual / run_at + raw_json (mood,
    # confidence) so the compact dicts we emit carry the same fields
    # Phase 0 was emitting; the model's prompt parser does not need
    # changing.
    aids = list({int(r["analysis_id"]) for r in res if r.get("analysis_id") is not None})
    pred_by_key: dict[tuple[int, str], dict] = {}
    if aids:
        try:
            pr = sb.table("prediction_scores").select(
                "analysis_id,dimension,score,delta,predicted,actual"
            ).in_("analysis_id", aids).eq("dimension", dim).execute().data or []
            for p in pr:
                key = (int(p["analysis_id"]), p["dimension"])
                pred_by_key[key] = p
        except Exception:
            pred_by_key = {}
    raw_by_aid: dict[int, dict] = {}
    if aids:
        try:
            ar = sb.table("analysis").select("id,run_at,raw_json").in_(
                "id", aids).execute().data or []
            for a in ar:
                raw_by_aid[int(a["id"])] = a
        except Exception:
            raw_by_aid = {}

    # Stratify wins vs losses out of the retrieved pool so the prompt
    # always sees both sides of the regime. If the retrieved pool is
    # all-winning (today's setup is well-explored and has only ever
    # gone right) we still surface them; same for all-losing.
    wins, losses, neutral = [], [], []
    for r in res:
        aid = int(r.get("analysis_id") or 0)
        sim = r.get("similarity")
        score = r.get("outcome_score")
        a = raw_by_aid.get(aid) or {}
        raw = a.get("raw_json") or {}
        ps = pred_by_key.get((aid, dim)) or {}
        ex = {
            "date": (a.get("run_at") or "")[:10],
            "similarity": round(sim, 3) if isinstance(sim, (int, float)) else None,
            "score": round(score, 1) if isinstance(score, (int, float)) else None,
        }
        if isinstance(raw.get("market_mood"), str):
            ex["mood"] = raw["market_mood"]
        conf = raw.get("confidence")
        if isinstance(conf, (int, float)):
            ex["conf"] = round(float(conf), 0)
        predicted = ps.get("predicted") or {}
        actual = ps.get("actual") or {}
        if dim in ("direction_1d", "sensex_direction_1d"):
            ex["called"] = predicted.get("direction") or predicted.get("call")
            delta = ps.get("delta")
            if isinstance(delta, (int, float)):
                ex["actual_move_pct"] = round(delta, 2)
        elif dim.endswith("range_1d"):
            rng = predicted.get("range") or predicted.get("band")
            if isinstance(rng, (list, tuple)) and len(rng) >= 2:
                try:
                    lo = float(rng[0]); hi = float(rng[1])
                    mid = (lo + hi) / 2
                    if mid > 0:
                        ex["band_pct"] = round(((hi - lo) / mid) * 100, 2)
                except (TypeError, ValueError):
                    pass
            ac = actual.get("close") if isinstance(actual, dict) else None
            if isinstance(ac, (int, float)):
                ex["actual_close"] = round(ac, 2)
        if score is not None and score >= 80:
            ex["tag"] = "win"
            wins.append(ex)
        elif score is not None and score <= 20:
            ex["tag"] = "loss"
            losses.append(ex)
        else:
            ex["tag"] = "mid"
            neutral.append(ex)

    # Take up to k/2 each side; fall through to mids if one side is empty.
    n_each = max(k // 2, 1)
    out = wins[:n_each] + losses[:n_each]
    if len(out) < k:
        out.extend(neutral[: k - len(out)])
    return out[:k]


def _mine_exemplars(sb, dim: str, n_each: int = 3) -> list[dict]:
    """Pull n_each highest-scoring and n_each lowest-scoring graded calls
    for `dim`, joined to the analysis row that produced them, and return
    compact one-line exemplars. Each exemplar carries the date, the
    market mood + stated confidence at call time, the specific call
    made, the realized outcome, and the score. Injected into
    self_feedback so the next-day prompt sees concrete wins and losses
    it can pattern-match against, not just aggregate "you are 58% right"
    stats. Phase 0 of the RAG roadmap: recency-broken-out-by-score
    selection, no embedding store yet.

    Cheap by construction: two indexed range queries on prediction_scores
    (b-tree on dimension) and a single in-list lookup on analysis. Total
    payload added is ~6 small dicts per dim, well under the
    self_feedback budget.
    """
    out: list[dict] = []
    try:
        wins = sb.table("prediction_scores").select(
            "id,analysis_id,score,delta,predicted,actual"
        ).eq("dimension", dim).gte("score", 80).order(
            "id", desc=True).limit(n_each).execute().data or []
        losses = sb.table("prediction_scores").select(
            "id,analysis_id,score,delta,predicted,actual"
        ).eq("dimension", dim).lte("score", 20).order(
            "id", desc=True).limit(n_each).execute().data or []
    except Exception as e:
        # Soft-fail. Missing exemplars are a less-rich prompt, not a
        # broken pipeline; the rest of self_feedback still ships.
        print(f"  exemplar mine skip ({dim}): {str(e)[:120]}")
        return out

    rows = list(wins) + list(losses)
    if not rows:
        return out

    ids = list({r["analysis_id"] for r in rows if r.get("analysis_id") is not None})
    meta: dict[int, dict] = {}
    if ids:
        try:
            ar = sb.table("analysis").select("id,run_at,raw_json").in_(
                "id", ids
            ).execute().data or []
            meta = {a["id"]: a for a in ar}
        except Exception:
            meta = {}

    def _build(r: dict, tag: str) -> dict | None:
        a = meta.get(r.get("analysis_id"))
        if not a:
            return None
        raw = a.get("raw_json") or {}
        conf = raw.get("confidence")
        mood = raw.get("market_mood")
        predicted = r.get("predicted") or {}
        actual = r.get("actual") or {}
        ex: dict = {
            "date": (a.get("run_at") or "")[:10],
            "tag": tag,
            "score": r.get("score"),
        }
        if isinstance(conf, (int, float)):
            ex["conf"] = round(conf, 0)
        if mood:
            ex["mood"] = mood
        # Dimension-specific compact body. Keep keys terse so the
        # prompt does not bloat. Caller reads them like a tape sheet.
        if dim in ("direction_1d", "sensex_direction_1d"):
            ex["called"] = predicted.get("direction") or predicted.get("call")
            delta = r.get("delta")
            if isinstance(delta, (int, float)):
                ex["actual_move_pct"] = round(delta, 2)
        elif dim == "range_1d" or dim.endswith("range_1d"):
            rng = predicted.get("range") or predicted.get("band")
            if isinstance(rng, (list, tuple)) and len(rng) >= 2:
                try:
                    lo = float(rng[0]); hi = float(rng[1])
                    mid = (lo + hi) / 2
                    if mid > 0:
                        ex["band_pct"] = round(((hi - lo) / mid) * 100, 2)
                except (TypeError, ValueError):
                    pass
            ac = actual.get("close") if isinstance(actual, dict) else None
            if isinstance(ac, (int, float)):
                ex["actual_close"] = round(ac, 2)
        else:
            # Generic dims (picks, verdicts, etc): just keep the
            # numeric predicted target if it serializes simply.
            target = predicted.get("target") or predicted.get("call")
            if isinstance(target, (str, int, float)):
                ex["called"] = target
        return ex

    for r in wins:
        ex = _build(r, "win")
        if ex:
            out.append(ex)
    for r in losses:
        ex = _build(r, "loss")
        if ex:
            out.append(ex)
    # Sort wins-then-losses, each block newest-first, so the model
    # reads the most-recent positive pattern first.
    out.sort(key=lambda e: (0 if e["tag"] == "win" else 1, e.get("date", "")), reverse=False)
    return out


def build_feedback() -> dict | None:
    sb = _sb()
    if not sb:
        return None

    latest = _latest_summaries(sb)
    if not latest:
        return None

    by_window: dict[int, list[dict]] = {}
    for (w, dim), r in latest.items():
        by_window.setdefault(w, []).append({
            "dimension": dim,
            "accuracy_pct": r.get("accuracy_pct"),
            "avg_delta": r.get("avg_delta"),
            "sample_size": r.get("sample_size"),
            "bias": r.get("bias"),
        })

    # ---- Confidence calibration + specific recent misses ----
    hist = _direction_history(sb)
    conf_items = [h for h in hist if h["confidence"] is not None and h["score"] is not None]
    calibration = None
    if len(conf_items) >= 5:
        avg_conf = sum(h["confidence"] for h in conf_items) / len(conf_items)
        avg_score = sum(h["score"] for h in conf_items) / len(conf_items)
        calibration = {
            "avg_stated_confidence": round(avg_conf, 1),
            "avg_realized_direction_score": round(avg_score, 1),
            "overconfidence_gap": round(avg_conf - avg_score, 1),
            "n": len(conf_items),
        }

    # One entry per date: several analyses can run on the same day (daily cron
    # plus manual syncs), and 5 copies of the same miss is noise to the model.
    miss_by_date: dict[str, dict] = {}
    for h in hist:
        if h["score"] != 0 or not h["date"]:
            continue
        miss_by_date[h["date"]] = {
            "date": h["date"],
            "called": h["called"] or "unspecified",
            "actual_move_pct": round(h["delta"], 2) if isinstance(h["delta"], (int, float)) else None,
        }
    recent_misses = sorted(miss_by_date.values(), key=lambda x: x["date"])[-5:]

    # ---- Strict corrective rules tied to each failing dimension ----
    rules: list[str] = []

    # Prefer the 30d window for stable signal, fall back to whatever exists.
    window_items = by_window.get(30) or next(iter(by_window.values()), [])
    dim_map = {it["dimension"]: it for it in window_items}

    def _acc(dim):
        it = dim_map.get(dim)
        return (it.get("accuracy_pct") if it else None), (it.get("sample_size", 0) if it else 0)

    dir_acc, dir_n = _acc("direction_1d")
    if dir_acc is not None and dir_n >= 5:
        cap = int(min(dir_acc, 70))
        rules.append(
            f"Direction accuracy is {dir_acc:.0f}% over n={dir_n}. Set your "
            f"`confidence` no higher than {cap}. Only commit to up/down when "
            f"technicals AND news clearly align; otherwise call sideways."
        )

    if calibration and calibration["overconfidence_gap"] > 8:
        rules.append(
            f"You are OVERCONFIDENT by {calibration['overconfidence_gap']:.0f} points "
            f"(stated {calibration['avg_stated_confidence']:.0f} vs realized "
            f"{calibration['avg_realized_direction_score']:.0f}). Lower confidence to "
            f"match what you actually deliver."
        )
    elif calibration and calibration["overconfidence_gap"] < -8:
        rules.append(
            f"You are UNDERCONFIDENT by {abs(calibration['overconfidence_gap']):.0f} points. "
            f"When signals align you may raise confidence."
        )

    # Range discipline: NEVER settle. A hit band must tighten the next
    # day, every day, until it starts missing; only a miss buys back
    # width. The window-average rule pressures the trend; the
    # yesterday-specific rule pressures the very next call with the
    # exact width it must beat.
    for dim, label in (("range_1d", "NIFTY range"), ("sensex_range_1d", "Sensex range")):
        it = dim_map.get(dim)
        if not it or (it.get("sample_size", 0) < 3):
            continue
        acc = it.get("accuracy_pct") or 0
        width = (it.get("bias") or {}).get("avg_band_width_pct")
        if acc >= 90 and isinstance(width, (int, float)):
            tighter = round(width * 0.7, 2)
            rules.append(
                f"{label} hits {acc:.0f}% at an average band width of {width:.2f}%. "
                f"That band is too loose to be useful. Tighten toward {tighter:.2f}% "
                f"width while keeping the close inside it. Do NOT repeat "
                f"{width:.2f}%; a hit at the same width is a wasted day of learning."
            )
        elif acc >= 70 and isinstance(width, (int, float)):
            tighter = round(width * 0.85, 2)
            rules.append(
                f"{label} hits {acc:.0f}% at an average band width of {width:.2f}%. "
                f"Good containment earns a tighter test: bring the band toward "
                f"{tighter:.2f}% width. Never settle at a width that keeps hitting."
            )
        elif acc < 50:
            rules.append(
                f"{label} only contains the close {acc:.0f}% of the time. Widen the band "
                f"OR justify a tight band with an explicit, strong signal."
            )

    # Yesterday-specific range pressure: if the latest graded band
    # contained the close, today's band MUST be narrower than it.
    for dim, label, rule_label in (
            ("range_1d", "^NSEI", "NIFTY"),
            ("sensex_range_1d", "^BSESN", "Sensex")):
        try:
            last = sb.table("prediction_scores").select(
                "score,predicted,notes"
            ).eq("dimension", dim).order("id", desc=True).limit(1).execute().data or []
        except Exception:
            last = []
        if not last:
            continue
        row = last[0]
        score = row.get("score")
        rng = (row.get("predicted") or {}).get("range")
        if (not isinstance(score, (int, float)) or score < 80
                or not isinstance(rng, (list, tuple)) or len(rng) < 2):
            continue
        try:
            lo, hi = float(rng[0]), float(rng[1])
        except (TypeError, ValueError):
            continue
        mid = (lo + hi) / 2
        if mid <= 0 or hi <= lo:
            continue
        w_pct = round((hi - lo) / mid * 100, 2)
        target = round(w_pct * 0.85, 2)
        rules.append(
            f"Your latest graded {rule_label} band {lo:.0f}-{hi:.0f} "
            f"({w_pct:.2f}% wide) CONTAINED the close (score {score:.0f}). "
            f"Mandatory: today's {rule_label} band must be NARROWER than "
            f"{w_pct:.2f}% of midpoint; target {target:.2f}% or tighter. The only "
            f"acceptable reason to widen is an explicit volatility-expansion "
            f"signal (event day, VIX or ATR up >10%), and you must cite it."
        )

    # Per-stock + per-sector range pressure: every band that contained
    # its close yesterday must tighten today. The grader stores raw
    # per-element results inside actual.results on the aggregated row,
    # so one Supabase fetch per dim returns every name's score + width
    # from yesterday's call. Build one corrective rule per dim listing
    # each name that hit (>=80) with its specific yesterday width and
    # a target narrower width. Same widen-only-on-cited-vol-event escape
    # hatch as the index rules. Without this, only NIFTY and Sensex
    # bands got tightening pressure; sectors and individual stocks felt
    # zero learning loop on width.
    for dim, scope_label, key_field in (
            ("sector_range_1d", "sector", "sector"),
            ("holding_outlook_range_1d", "holding", "ticker"),
            ("wishlist_outlook_range_1d", "wishlist", "ticker")):
        try:
            last = sb.table("prediction_scores").select(
                "actual"
            ).eq("dimension", dim).order("id", desc=True).limit(1).execute().data or []
        except Exception:
            last = []
        if not last:
            continue
        results = ((last[0].get("actual") or {}).get("results")) or []
        if not isinstance(results, list) or not results:
            continue
        tight_specs: list[str] = []
        for item in results:
            if not isinstance(item, dict):
                continue
            r_score = item.get("range_score")
            rng = item.get("range")
            name = item.get(key_field)
            if (not isinstance(r_score, (int, float)) or r_score < 80
                    or not name):
                continue
            if isinstance(rng, str):
                try:
                    parts = [float(p.strip()) for p in rng.split("-") if p.strip()]
                    if len(parts) < 2:
                        continue
                    lo, hi = parts[0], parts[1]
                except (TypeError, ValueError):
                    continue
            elif isinstance(rng, (list, tuple)) and len(rng) >= 2:
                try:
                    lo, hi = float(rng[0]), float(rng[1])
                except (TypeError, ValueError):
                    continue
            else:
                continue
            mid = (lo + hi) / 2
            if mid <= 0 or hi <= lo:
                continue
            w_pct = (hi - lo) / mid * 100
            target = w_pct * 0.85
            tight_specs.append(
                f"{name} band {lo:.2f}-{hi:.2f} ({w_pct:.2f}% wide, "
                f"score {r_score:.0f}) -> target <= {target:.2f}%"
            )
        if not tight_specs:
            continue
        # Cap to 8 names so a long list (e.g. 13 sectors) does not
        # crowd out the rest of the corrective_rules block.
        capped = tight_specs[:8]
        more = (f" plus {len(tight_specs) - len(capped)} more names that hit"
                if len(tight_specs) > len(capped) else "")
        rules.append(
            f"Per-{scope_label} range doctrine: every band below contained "
            f"yesterday's close. Each one's band today MUST be narrower than "
            f"the listed width unless you cite an explicit vol-expansion event "
            f"on that name (earnings, news, sector shock). " + "; ".join(capped) + more
        )

    for dim, label in (("short_pick_7d", "Short picks 7d"),
                       ("short_pick_30d", "Short picks 30d")):
        acc, n = _acc(dim)
        if acc is not None and n >= 5 and acc < 50:
            rules.append(
                f"{label} underperform NIFTY ({acc:.0f}%, n={n}). Raise the bar: require "
                f"RSI 50-65, a bullish MACD crossover, a recent news catalyst, AND volume "
                f"confirmation before listing a pick. Fewer, higher-conviction picks."
            )

    # ---- Conviction tier discipline: A must out-deliver B must out-
    # deliver C. Tiers are derived from stated win_prob now, so a
    # non-monotonic result means the model's win_prob estimates do not
    # track realized performance and the high-conviction label is empty.
    # This closes the loop the tier stratification was built to feed.
    tier_accs = []
    for t in ("A", "B", "C"):
        acc, n = _acc(f"short_pick_{t}_7d")
        if acc is not None and n >= 3:
            tier_accs.append((t, acc, n))
    if len(tier_accs) >= 2:
        ordered = [acc for _t, acc, _n in tier_accs]
        if ordered != sorted(ordered, reverse=True):
            detail = ", ".join(f"{t}-tier {acc:.0f}% (n={n})" for t, acc, n in tier_accs)
            rules.append(
                f"Your conviction tiers are NOT ordered by performance: {detail}. "
                f"A must out-deliver B must out-deliver C. Reserve A only for picks where "
                f"all three pillars (technicals + catalyst + sector/flow) align and your "
                f"win_prob is genuinely 0.65+; default to B or C when any pillar is soft."
            )

    # ---- Long-pick alpha: are the independent top_performers beating the
    # index at all? Surfaced so a weak long book pressures tighter selection.
    tp_acc, tp_n = _acc("top_performer_1d")
    if tp_acc is not None and tp_n >= 5 and tp_acc < 55:
        rules.append(
            f"Your top_performers beat NIFTY only {tp_acc:.0f}% of the time (n={tp_n}). "
            f"List fewer, stronger longs: a name already extended into resistance is a "
            f"poor entry. Prefer names with room to the next resistance and a nearby "
            f"support to anchor the stop."
        )

    # ---- Reward:risk geometry (standing discipline). The paper trader
    # rejects any top_performers long whose target sits closer than 1.3x
    # the stop distance, and the edge is recomputed from the actual target,
    # so a tight target both wastes the signal and zeroes the edge.
    rules.append(
        "Geometry rule for EVERY top_performers row: place the target at least 1.5x "
        "the stop distance away from entry (reward:risk >= 1.5:1). Anchor target to the "
        "next resistance and stop just below the nearest support; if that geometry gives "
        "reward:risk under 1.5, the entry is poor - drop the name, do not shrink the "
        "target to force it in. expected_return_pct must equal the target distance, not "
        "a blue-sky move you will not exit into."
    )

    v_acc, v_n = _acc("verdict_7d")
    if v_acc is not None and v_n >= 5 and v_acc < 55:
        rules.append(
            f"Portfolio verdicts are only {v_acc:.0f}% right (n={v_n}). Be decisive: do not "
            f"default to hold. Call add only on genuine strength and exit/trim on real weakness."
        )

    w_acc, w_n = _acc("wishlist_7d")
    if w_acc is not None and w_n >= 5 and w_acc < 55:
        rules.append(
            f"Wishlist signals are only {w_acc:.0f}% right (n={w_n}). Tighten entry zones and "
            f"reserve buy_now for clear setups."
        )

    # ---- Win/loss exemplars: similarity-retrieved from your own
    # graded history (Phase 1 RAG). For each key dimension, pull the k
    # past graded calls most similar to TODAY's tape state. Falls back
    # to Phase 0 score-recency selection automatically when:
    #   - sentence-transformers is absent (Render in-process fallback)
    #   - prediction_embeddings is empty (pre-backfill)
    #   - any RPC / yfinance / encode step errors
    # so the pipeline degrades gracefully instead of breaking.
    exemplars = {
        "direction_1d": _retrieve_exemplars_by_similarity(sb, "direction_1d", k=6),
        "range_1d": _retrieve_exemplars_by_similarity(sb, "range_1d", k=6),
    }
    # Drop empty buckets so the prompt does not ship dead keys before
    # the score thresholds have any matches.
    exemplars = {k: v for k, v in exemplars.items() if v}

    # Per-dim accuracy weight (silicon-crowd / wisdom-of-the-crowd
    # finding: weight signals by demonstrated skill, not raw rank).
    # Each exemplar bucket gets annotated with the dim's own 30-day
    # accuracy so the model can prioritise analogies from the dim that
    # has actually been reliable. Falls back to None per-dim when
    # accuracy_summary has not scored that dim yet; the prompt is then
    # silent rather than fabricating a weight. Sort the bucket keys so
    # higher-accuracy dims appear first in the JSON output (LLMs are
    # known to skew attention toward earlier list items).
    dim_accuracy: dict[str, float | None] = {}
    for dim in list(exemplars.keys()):
        row = latest.get((30, dim))
        if row and isinstance(row.get("accuracy_pct"), (int, float)) and row.get("sample_size", 0) >= 5:
            dim_accuracy[dim] = round(float(row["accuracy_pct"]), 1)
        else:
            dim_accuracy[dim] = None
    # Below-noise filter: drop dims with measured accuracy below the
    # coin-flip baseline (50) before the exemplar block ships to the
    # model. Carrying analogies from a dim that systematically scores
    # worse than guessing adds noise to the prompt; the model anchors
    # on the analogies and inherits the dim's bias. A dim with no
    # measurement (None) is kept because the silence-vs-bad distinction
    # matters: it might be a new dim that just hasn't accumulated rows
    # yet. Per the never-give-up doctrine, a dropped dim is not killed;
    # it just stops driving exemplar retrieval until its grader score
    # climbs back above 50.
    dropped_low_skill = [d for d, acc in dim_accuracy.items()
                         if acc is not None and acc < 50.0]
    for d in dropped_low_skill:
        exemplars.pop(d, None)
    # Stable-sort exemplar bucket order by accuracy desc (None ranks
    # last). Preserves all entries, just reorders for prompt prominence.
    exemplars = dict(sorted(
        exemplars.items(),
        key=lambda kv: (dim_accuracy.get(kv[0]) if dim_accuracy.get(kv[0]) is not None else -1.0),
        reverse=True,
    ))

    return {
        "track_record": by_window,
        "calibration": calibration,
        "recent_direction_misses": recent_misses,
        "exemplars": exemplars,
        "dim_accuracy_30d": dim_accuracy,
        "corrective_rules": rules,
        "note": (
            "This is your scored track record, graded brutally against real outcomes. "
            "Obey the corrective_rules. Make your `confidence` reflect your realized "
            "direction accuracy, not optimism. Give the NARROWEST range you can defend "
            "with signal, not a safe wide band. RANGE DOCTRINE: a band that contained "
            "yesterday's close MUST be tighter today; never repeat a width after a hit. "
            "Keep tightening every hit until a band misses, then widen one notch, not "
            "back to the old comfort width. A wide band that always hits teaches "
            "nothing. Learn from the specific recent_misses. EXEMPLAR DOCTRINE: the "
            "`exemplars` block carries concrete past WIN and LOSS calls retrieved "
            "by similarity to TODAY's tape state (VIX, DMA distances, RSI, recent "
            "returns, your own stated mood + confidence). When the `similarity` "
            "field is high, that historical setup genuinely resembles today's. "
            "Treat a LOSS exemplar at similarity>0.85 with conf=72 as a hard "
            "ceiling on today's confidence in the same regime, NOT just a "
            "suggestion. When all retrieved exemplars are wins, today's setup is "
            "well-explored and your confidence may run; when all are losses, "
            "moderate it. DIM-ACCURACY WEIGHT: `dim_accuracy_30d` carries the "
            "realised 30-day accuracy for each dim whose exemplars appear above. "
            "Buckets are pre-sorted highest accuracy first. Weight your analogy "
            "reasoning accordingly: a 72%-accuracy dim's exemplar deserves more "
            "trust than a 51%-accuracy dim's exemplar even at equal similarity. "
            "Dims with sample_size < 5 are absent from this map; treat their "
            "exemplars as informational, not load-bearing."
        ),
    }


if __name__ == "__main__":
    import json
    fb = build_feedback()
    print(json.dumps(fb, indent=2, default=str) if fb else "no feedback yet")
