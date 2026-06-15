"""One-shot historic backfill for prediction_embeddings.

Walks every prediction_scores row, builds the feature vector for its
parent analysis row, encodes via embed.get_model(), and upserts to
prediction_embeddings keyed on (analysis_id, dimension). Idempotent:
re-running embeds only the rows still missing OR re-embeds everything
when --force is passed (rare; only needed after a model swap).

GH Actions only. Run via workflow_dispatch:
    gh workflow run daily_grader.yml -f backfill=true

Cost on the current ~507-row dataset: ~3-5 minutes wall clock,
dominated by the first model download (~1.2 GB Qwen3-0.6B). Subsequent
runs hit the HuggingFace cache and finish in under 60 seconds.
"""
import os
import sys
import time
from datetime import datetime, timezone

from dotenv import load_dotenv
from supabase import create_client

from analyzer.embed import encode, features_for_analysis, features_to_text


def _sb():
    load_dotenv()
    return create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))


def _all_prediction_scores(sb) -> list[dict]:
    """Page through prediction_scores until exhausted. Same pattern as
    grader.compute_summaries() since PostgREST caps any single response
    at 1000 rows; .limit() lies and silently truncates."""
    rows: list[dict] = []
    off = 0
    while True:
        page = sb.table("prediction_scores").select(
            "analysis_id,dimension,score"
        ).order("id", desc=False).range(off, off + 999).execute().data or []
        rows.extend(page)
        if len(page) < 1000:
            break
        off += 1000
    return rows


def _already_embedded_keys(sb) -> set[tuple[int, str]]:
    """Return {(analysis_id, dimension)} pairs that already have a
    prediction_embeddings row. Skipped on the backfill pass so reruns
    incremental-by-default."""
    out: set[tuple[int, str]] = set()
    off = 0
    while True:
        page = sb.table("prediction_embeddings").select(
            "analysis_id,dimension"
        ).order("id", desc=False).range(off, off + 999).execute().data or []
        for r in page:
            aid = r.get("analysis_id")
            dim = r.get("dimension")
            if aid is not None and dim:
                out.add((int(aid), dim))
        if len(page) < 1000:
            break
        off += 1000
    return out


def _load_analyses(sb, ids: list[int]) -> dict[int, dict]:
    """Pull analysis rows for a chunk of ids. Run_at + raw_json are
    enough to assemble the feature dict; nothing else from the row is
    needed."""
    meta: dict[int, dict] = {}
    for i in range(0, len(ids), 200):
        ar = sb.table("analysis").select("id,run_at,raw_json").in_(
            "id", ids[i:i + 200]).execute().data or []
        for a in ar:
            meta[a["id"]] = a
    return meta


def run(force: bool = False) -> None:
    sb = _sb()
    scores = _all_prediction_scores(sb)
    print(f"backfill: {len(scores)} prediction_scores rows total")

    skip = set() if force else _already_embedded_keys(sb)
    if skip:
        print(f"backfill: {len(skip)} (analysis_id, dim) pairs already embedded; skipping")

    work = [s for s in scores
            if s.get("analysis_id") is not None
            and (int(s["analysis_id"]), s["dimension"]) not in skip]
    print(f"backfill: {len(work)} rows to embed this pass")
    if not work:
        return

    analysis_ids = list({int(s["analysis_id"]) for s in work})
    analyses = _load_analyses(sb, analysis_ids)
    print(f"backfill: loaded {len(analyses)} parent analysis rows")

    # Cache feature_text per analysis_id since the same analysis can
    # produce ~25 graded dimensions, and the tape-state features are
    # identical for all of them. Re-doing yfinance + the prompt-side
    # features 25 times per call would dominate runtime.
    feat_cache: dict[int, tuple[dict, str]] = {}
    t0 = time.time()
    skipped = 0
    encoded = 0

    # Batch by analysis_id so we can encode N dimensions for the same
    # analysis in one model.encode call (still one row per dim, but
    # the embedding is shared because the feature_text is identical).
    by_aid: dict[int, list[dict]] = {}
    for s in work:
        by_aid.setdefault(int(s["analysis_id"]), []).append(s)

    BATCH = 32
    pending_rows: list[dict] = []
    pending_texts: list[str] = []
    pending_meta: list[tuple[int, str, float | None, dict]] = []  # (aid, dim, score, feat)

    def _flush():
        nonlocal pending_rows, pending_texts, pending_meta, encoded
        if not pending_texts:
            return
        vecs = encode(pending_texts)
        rows = []
        for i, ((aid, dim, score, feat), vec) in enumerate(zip(pending_meta, vecs)):
            rows.append({
                "analysis_id": aid,
                "dimension": dim,
                "feature_text": pending_texts[i],
                "feature_vector": feat,
                "embedding": vec,
                "outcome_score": score,
                "created_at": datetime.now(timezone.utc).isoformat(),
            })
        # Chunked upsert: Supabase REST has a row-size ceiling on
        # bulk inserts when each row carries a 1024-float embedding
        # (~16 KB each); 32-row batches stay well under it.
        try:
            sb.table("prediction_embeddings").upsert(
                rows, on_conflict="analysis_id,dimension"
            ).execute()
            encoded += len(rows)
        except Exception as e:
            print(f"  upsert fail ({len(rows)} rows): {str(e)[:160]}")
        pending_rows.clear()
        pending_texts.clear()
        pending_meta.clear()

    # Progress instrumentation: print every 10 analyses + every flush
    # so a stuck step is visible in the GH log instead of silent. The
    # 12/06/2026 cold backfill ran 55 min without a log line before
    # being killed; this prevents a recurrence.
    n_aid_total = len(by_aid)
    n_aid_done = 0
    for aid, srows in by_aid.items():
        n_aid_done += 1
        a = analyses.get(aid)
        if not a:
            skipped += len(srows)
            continue
        if aid not in feat_cache:
            t_feat = time.time()
            feat = features_for_analysis(a.get("raw_json") or {}, a.get("run_at") or "")
            text = features_to_text(feat)
            feat_cache[aid] = (feat, text)
            if n_aid_done % 10 == 0 or n_aid_done == 1:
                print(f"  features {n_aid_done}/{n_aid_total} aid={aid} "
                      f"({time.time() - t_feat:.1f}s) text='{text[:60]}'")
        feat, text = feat_cache[aid]
        for s in srows:
            pending_texts.append(text)
            pending_meta.append((aid, s["dimension"], s.get("score"), feat))
            if len(pending_texts) >= BATCH:
                t_enc = time.time()
                _flush()
                print(f"  encoded batch (total={encoded}) in {time.time() - t_enc:.1f}s")
    _flush()

    dt = time.time() - t0
    print(f"backfill: encoded={encoded} skipped={skipped} in {dt:.1f}s")


if __name__ == "__main__":
    force = "--force" in sys.argv
    run(force=force)
