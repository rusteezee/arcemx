# Pending A/B review: RAG Phase 1 activation (blueprint 14)

**Activated:** 2026-07-16 (RAG_PHASE1_ENABLED flipped to "1" in daily_analysis.yml).
**Review date:** 2026-08-06 (day 21, giving 14 full days of activated runs after the
first live morning pass under the new flag - the blueprint's own 14-day window
counted from the first REAL activated run, not the flip commit itself).

## Pre-activation baseline (accuracy_summary, 30d window, computed 2026-07-16
just before the re-embed + flip, sample_size=25 for all three)

| dimension | accuracy_pct | avg_delta | sample_size |
|---|---|---|---|
| direction_1d | 54.83 | 0.019 | 25 |
| range_1d | 71.63 | 0.555 (band width 0.824%) | 25 |
| insight_quality | 72.65 | 0.0 | 25 |

## What to compare on review day

Pull the same three dims' 30d (and 7d) `accuracy_summary` rows again on/after
2026-08-06 and compare against the baseline above. RAG Phase 1 is a net win if
direction_1d and/or range_1d accuracy improved without insight_quality
regressing meaningfully (insight_quality is a text-quality proxy, not directly
targeted by exemplar retrieval, so it's the "did this break something else"
control).

## Rollback

Flip `RAG_PHASE1_ENABLED` back to `"0"` in `.github/workflows/daily_analysis.yml`'s
env block. No DB rollback needed - prediction_embeddings stays re-embedded
under bge-base either way (it wasn't wasted work; Phase 0 selection still runs
fine, it just stops consuming the similarity path).

## Re-embed context (why this file exists)

Before activation, `prediction_embeddings` had ~2,600 rows in a MIXED model
state (some legacy MiniLM-L6 384-dim rows zero-padded to 1024, most current
bge-base-en-v1.5 768-dim rows also zero-padded to 1024) - cosine distance
across two different embedding spaces is meaningless, so a full re-embed under
one model was mandatory before the retrieval path could be trusted. Delete
this file once the 2026-08-06 review is written up (in a commit message or a
follow-up doc), whichever this project's convention prefers at that point.
