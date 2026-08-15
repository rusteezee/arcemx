BLUEPRINT 14: RAG Phase-1 activation (similarity exemplars)

BUILDER: Claude Sonnet, working alone, cold start, cannot ask questions.
(The consumer code exists gated-off; this is DB function + re-embed + flag flip + A/B.)

GOAL
The morning prompt's exemplars upgrade from "most recent wins/losses" (Phase 0) to
"most SIMILAR historical days" (Phase 1): pgvector kNN over prediction_embeddings,
which the feedback module already knows how to consume behind the RAG_PHASE1_ENABLED
flag. Includes a measured A/B verdict, not vibes.

CONTEXT THE BUILDER NEEDS
- Files to read first: `analyzer/feedback.py` (`_retrieve_exemplars_by_similarity` :70 -
  the gated consumer; read its exact expected RPC name/signature and fallback at
  :87-101), `analyzer/embed.py` (encoder. current model bge-base; feature
  serialization), `analyzer/embed_backfill.py` (backfill runner + pagination),
  `analyzer/grader.py:1357` (`_embed_new_predictions`. daily producer),
  `.github/workflows/daily_analysis.yml` (installs requirements-embed.txt + HF cache -
  embeddings only run on GH runners, never Render's 512MB).
- Known blockers (from grounding, all must be fixed here):
  (1) the `match_exemplars` RPC was never created in Supabase;
  (2) the embedding store is MIXED-MODEL (old MiniLM rows + current bge-base rows) -
  distances across models are meaningless; a full re-embed under the current model is
  required before the index means anything;
  (3) no ivfflat index exists.
- DDL (user runs in SQL Editor. Python/JS clients cannot do DDL; builder prints this
  block and waits for confirmation):
  ```sql
  create index if not exists idx_pred_emb_ivfflat on prediction_embeddings
    using ivfflat (embedding vector_cosine_ops) with (lists = 50);
  create or replace function match_exemplars(
      query_embedding vector,
      match_dimension text,
      match_count int default 6
  ) returns table (analysis_id bigint, dimension text, feature_text text,
                   outcome_score float, similarity float)
  language sql stable as $$
    select analysis_id, dimension, feature_text, outcome_score,
           1 - (embedding <=> query_embedding) as similarity
    from prediction_embeddings
    where dimension = match_dimension and embedding is not null
    order by embedding <=> query_embedding
    limit match_count;
  $$;
  ```
  (Match the return columns to what _retrieve_exemplars_by_similarity actually expects -
  read the consumer FIRST and adjust the SQL to its contract, not vice versa.)
- A/B design (decided here): flip RAG_PHASE1_ENABLED=1 in daily_analysis.yml only.
  Measure: 14 days after activation, compare direction_1d + range_1d accuracy
  (accuracy_summary 7d/30d windows) and insight_quality vs the 30d pre-activation
  baseline. Record both snapshots in the PR/summary. Rollback = flip the env to 0.

CONSTRAINTS
- Must stay inside: `analyzer/embed_backfill.py` (add `--re-embed-all` mode),
  `.github/workflows/daily_analysis.yml` + `daily_grader.yml` (env flag), db/schema.sql
  (append the DDL block with a comment), docs in the summary.
- Must not change: feedback.py consumer logic (it is the spec), embed.py model choice.
- Non-negotiables: re-embed EVERYTHING under one model before enabling; the flag stays
  off until re-embed completes; A/B baseline snapshot taken BEFORE the flip.

STEP-BY-STEP PLAN
1. Read `_retrieve_exemplars_by_similarity` fully; finalize the RPC SQL to its exact
   contract; append to db/schema.sql; print for the user to run; STOP until user
   confirms it ran (the builder asks in its summary. this is the one permitted pause).
2. `analyzer/embed_backfill.py`. add `--re-embed-all`: wipe embedding column model
   metadata assumptions by re-encoding every row's feature_text under the current model
   (paginate .range(); ~2,300 rows ≈ minutes on GH runner CPU). Add a model-name column
   guard: store the encoder name in each row's metadata if a column exists, else prefix
   feature-hash bookkeeping in the existing columns (smallest change that lets a future
   audit distinguish models. one ASSUMPTION allowed here).
3. Dispatch `daily_grader.yml` with the existing backfill/force input (grounding: it
   supports embed_backfill inputs) or run locally to execute the re-embed once.
4. Snapshot baseline: current accuracy_summary 30d rows for direction_1d/range_1d +
   insight_quality (save JSON into the summary).
5. Flip `RAG_PHASE1_ENABLED: "1"` in daily_analysis.yml env. Verify next morning run's
   logs show similarity-retrieved exemplars (feedback.py logs its path).
6. Create a reminder artifact: `blueprints/_pending_ab_rag.md` noting the baseline
   numbers and the 14-day review date.

EXACT INPUTS TO USE
- Kick-off prompt: "Implement blueprint 14-rag-phase1-activation.md from
  C:\Users\rahul\Downloads\stock-ai\blueprints\. Step 1 requires user-run SQL. print it
  and wait for confirmation before proceeding."

DEFINITION OF DONE
[ ] RPC exists (probe: one supabase.rpc('match_exemplars', ...) call returns rows
    ordered by similarity).
[ ] 100% of prediction_embeddings rows re-embedded under the current model (count
    verified before/after).
[ ] Flag on; next analysis run's log shows Phase-1 retrieval path taken.
[ ] Baseline snapshot + 14-day review file committed.
[ ] Rollback documented (flag to 0).

IF SOMETHING IS UNCLEAR
Smallest safe assumption, tag "ASSUMPTION:", keep going. except the user-run SQL pause,
which is mandatory.
