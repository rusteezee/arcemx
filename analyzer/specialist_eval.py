"""Blueprint 13: batch-scores a specialist GGUF (downloaded from a GitHub
Release) against recently-graded predictions, writing results into
prediction_scores tagged with model_slug so the existing accuracy
tooling (/rankings, accuracy_summary) can compare it against the live
chain for free - no always-on serving, this only ever runs as a
scheduled/dispatched CPU batch job (researched: no viable free always-on
path, see blueprint 13's CONTEXT).

Never overwrites a live-chain row: the schema now has two partial
unique indexes (see db/schema.sql) - one for model_slug IS NULL (the
live chain, unchanged), one for (analysis_id, dimension, horizon_days,
model_slug) when model_slug IS NOT NULL (one row per specialist version
per prediction). Upserts here always target the second index.

Uses llama.cpp's own conversation mode (-cnv) rather than a hand-built
prompt template, because that auto-applies whatever chat template is
embedded in the GGUF itself - the exact same code path works whether
the model is our real Llama-3.2 fine-tune or the smoke test's tiny
public GGUF, without needing to know either model's special tokens.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv
from supabase import create_client

from analyzer.finetune_export import _system_prompt

load_dotenv()

TARGET_DIMS = ["direction_1d", "range_1d", "market_mood_1d", "top_performer_1d"]
FLAT = 0.4  # matches analyzer.grader.grade_direction exactly


def _sb():
    return create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))


def download_gguf(repo: str, tag: str, dest_dir: str) -> str:
    """gh CLI is preinstalled on GitHub-hosted runners; GH_TOKEN in env
    covers auth for a public or private repo release asset."""
    os.makedirs(dest_dir, exist_ok=True)
    subprocess.run(
        ["gh", "release", "download", tag, "--repo", repo, "--pattern", "*.gguf",
         "--dir", dest_dir, "--clobber"],
        check=True, timeout=300,
    )
    files = [f for f in os.listdir(dest_dir) if f.endswith(".gguf")]
    if not files:
        raise RuntimeError(f"No .gguf asset found on release {tag}")
    return os.path.join(dest_dir, files[0])


def download_gguf_url(url: str, dest_dir: str) -> str:
    """Smoke-test path: fetch an arbitrary public GGUF by direct URL
    instead of our own GH release, so the plumbing can be proven with a
    tiny public model before our own specialist has ever been trained."""
    import requests
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, "smoke.gguf")
    with requests.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_content(chunk_size=8192):
                f.write(chunk)
    return dest


def run_llama(binary: str, model_path: str, dim: str, feature_text: str, n_predict: int = 128) -> str:
    """One-shot: -sys sets the system turn, -p the single user turn,
    --single-turn exits after one response. Returns the model's raw
    completion (banner + prompt echo + JSON - extract_json pulls the
    object out).

    NO -cnv: that flag was removed from llama.cpp's CLI at some point
    after this script was written, causing an immediate
    `error: invalid argument: -cnv` and empty stdout on every call -
    root-caused live 2026-08-29 after this eval had scored 0/N on every
    run since 2026-08-15 with zero visible error, because the caller
    only ever saw "no parseable JSON" (empty stdout doesn't parse) and
    never saw returncode or stderr. --single-turn now implies
    conversation mode on its own; verified live against the real
    specialist-v2 GGUF that this produces a genuine parseable
    completion (confirmed: {"call": "sideways", "confidence": 52.7}
    from a real feature_text sample).

    System prompt must match training exactly (analyzer.finetune_export's
    per-dimension instruction) - the same market-state feature_text is
    shared across all 4 target dims, so a generic system prompt here
    would reintroduce the identical-input/different-output ambiguity
    the training-side fix (finetune_export._system_prompt) already
    closed, just moved from train time to eval time."""
    result = subprocess.run(
        [binary, "-m", model_path, "-sys", _system_prompt(dim), "-p", feature_text,
         "-n", str(n_predict), "--temp", "0.1", "--single-turn", "--no-display-prompt"],
        capture_output=True, text=True, timeout=120,
    )
    if result.returncode != 0:
        # Surface the real reason instead of returning empty/garbage
        # stdout for extract_json to silently fail on - this exact
        # silent-failure shape (returncode never checked) is what let
        # the CLI flag removal above go undetected for two weeks.
        raise RuntimeError(f"llama-cli exited {result.returncode}: {result.stderr.strip()[:300]}")
    return result.stdout


def extract_json(text: str) -> dict | None:
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None


def score_prediction(dim: str, call, actual: dict) -> tuple[dict, float, float] | None:
    """Returns (predicted_json, score, delta) or None if unscoreable.
    Uses the exact same 0.4%-flat-band logic analyzer.grader.grade_direction
    applies to the live chain, so the comparison is apples-to-apples."""
    if dim in ("direction_1d", "market_mood_1d"):
        pct = actual.get("pct")
        if not isinstance(pct, (int, float)):
            return None
        label = str(call).lower()
        is_up = label in ("up", "bull", "bullish")
        is_down = label in ("down", "bear", "bearish")
        if is_up:
            score = 100 if pct > FLAT else 0
        elif is_down:
            score = 100 if pct < -FLAT else 0
        else:
            score = 100 if abs(pct) <= FLAT else (50 if abs(pct) <= 2 * FLAT else 0)
        return {"call": call}, float(score), float(pct)

    if dim == "range_1d":
        close = actual.get("close")
        if not isinstance(close, (int, float)) or not isinstance(call, list) or len(call) != 2:
            return None
        from analyzer.grader import grade_range
        score, delta = grade_range(tuple(call), close)
        return {"range": call}, float(score), float(delta)

    if dim == "top_performer_1d":
        results = actual.get("results") or []
        if not isinstance(results, list) or not results or not isinstance(call, list) or not call:
            return None
        correct = {
            r["ticker"] for r in results
            if isinstance(r, dict) and isinstance(r.get("alpha"), (int, float)) and r["alpha"] > 0
        }
        picks = set(call)
        hit_rate = len(picks & correct) / len(picks) * 100
        return {"picks": call}, float(hit_rate), 0.0

    return None


def recent_targets(sb, days: int) -> list[dict]:
    """Graded (analysis_id, dimension) pairs from the last N days, one
    per target dim, with their feature_text and actual outcome."""
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    ids = sb.table("analysis").select("id,run_at").gte("run_at", since).execute().data or []
    id_list = [a["id"] for a in ids]
    if not id_list:
        return []
    out = []
    for dim in TARGET_DIMS:
        rows = sb.table("prediction_scores").select("analysis_id,actual").in_(
            "analysis_id", id_list
        ).eq("dimension", dim).is_("model_slug", "null").execute().data or []
        for r in rows:
            emb = sb.table("prediction_embeddings").select("feature_text").eq(
                "analysis_id", r["analysis_id"]
            ).eq("dimension", dim).limit(1).execute().data
            if not emb or not emb[0].get("feature_text"):
                continue
            out.append({
                "dimension": dim,
                "analysis_id": r["analysis_id"],
                "feature_text": emb[0]["feature_text"],
                "actual": r.get("actual") or {},
            })
    return out


def run_eval(model_slug: str, binary: str, model_path: str, days: int = 10) -> int:
    sb = _sb()
    targets = recent_targets(sb, days)
    scored = 0
    for t in targets:
        try:
            raw = run_llama(binary, model_path, t["dimension"], t["feature_text"])
        except subprocess.TimeoutExpired:
            print(f"  {t['dimension']} analysis_id={t['analysis_id']}: llama.cpp timed out, skipped")
            continue
        except RuntimeError as e:
            print(f"  {t['dimension']} analysis_id={t['analysis_id']}: {e}")
            continue
        parsed = extract_json(raw)
        if parsed is None:
            print(f"  {t['dimension']} analysis_id={t['analysis_id']}: no parseable JSON, skipped")
            continue
        result = score_prediction(t["dimension"], parsed.get("call"), t["actual"])
        if result is None:
            print(f"  {t['dimension']} analysis_id={t['analysis_id']}: unscoreable, skipped")
            continue
        predicted, score, delta = result
        # PostgREST's upsert(on_conflict=...) can only target a plain
        # (non-partial) unique constraint - it has no way to express the
        # "WHERE model_slug IS NOT NULL" predicate idx_ps_specialist_unique
        # needs, so it 42P10s against that partial index no matter what
        # (confirmed live 2026-07-26, not a schema-cache issue). Manual
        # select-then-write instead; Postgres itself has no trouble with
        # the partial index, only PostgREST's upsert abstraction does.
        row = {
            "analysis_id": t["analysis_id"],
            "dimension": t["dimension"],
            "horizon_days": 1,
            "predicted": predicted,
            "actual": t["actual"],
            "score": score,
            "delta": delta,
            "notes": f"specialist eval, stated confidence {parsed.get('confidence')}",
            "model_slug": model_slug,
        }
        existing = sb.table("prediction_scores").select("id").eq(
            "analysis_id", t["analysis_id"]
        ).eq("dimension", t["dimension"]).eq("horizon_days", 1).eq(
            "model_slug", model_slug
        ).execute().data
        if existing:
            sb.table("prediction_scores").update(row).eq("id", existing[0]["id"]).execute()
        else:
            sb.table("prediction_scores").insert(row).execute()
        scored += 1
        print(f"  {t['dimension']} analysis_id={t['analysis_id']}: score={score:.1f}")
    print(f"Specialist eval ({model_slug}): scored {scored}/{len(targets)}")
    return scored


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=os.getenv("GH_REPO", "rusteezee/arcemx"))
    ap.add_argument("--release-tag")
    ap.add_argument("--gguf-url", help="smoke-test only: fetch a public GGUF by URL instead of a GH release")
    ap.add_argument("--model-slug", required=True)
    ap.add_argument("--llama-binary", default="llama-cli")
    ap.add_argument("--days", type=int, default=10)
    ap.add_argument("--dest-dir", default="/tmp/specialist_gguf")
    args = ap.parse_args()

    if args.gguf_url:
        model_path = download_gguf_url(args.gguf_url, args.dest_dir)
    elif args.release_tag:
        model_path = download_gguf(args.repo, args.release_tag, args.dest_dir)
    else:
        raise SystemExit("Need either --release-tag or --gguf-url")
    run_eval(args.model_slug, args.llama_binary, model_path, args.days)


if __name__ == "__main__":
    main()
