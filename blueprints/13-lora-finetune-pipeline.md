BLUEPRINT 13: LoRA fine-tune pipeline (export → free Kaggle training → batch eval)

BUILDER: Claude Sonnet, working alone, cold start, cannot ask questions.
(Multi-part: SQL export, a notebook, a CPU inference path, an eval harness. GATED:
do not start until prediction_scores >= 3,000 rows. ~2,300 on 2026-07-13, ETA ~30 Jul.)

GOAL
A repeatable, ₹0 pipeline that turns the system's own graded history into a small
fine-tuned specialist model: (1) exporter builds a chat-format JSONL dataset from
prediction_scores + calibration_log + prediction_embeddings.feature_text, (2) a Kaggle
notebook (free 30 GPU-h/week, T4) trains a QLoRA adapter with Unsloth, (3) a GH Actions
batch job runs the merged GGUF via llama.cpp CPU as an ADVISORY second opinion whose
predictions are graded under its own model_slug. measured against the live chain
before it ever influences anything.

CONTEXT THE BUILDER NEEDS
- Files to read first: `analyzer/embed.py` (`features_to_text` :119,
  `features_for_analysis` :269. the feature serialization the dataset reuses),
  `analyzer/grader.py` (`_upsert_score` :468. prediction_scores shape; model_slug
  column exists for exactly this), `db/schema.sql` (prediction_scores :93-105),
  `analyzer/llm_router.py` (`_parse_json`. output schema the specialist must emit).
- Researched facts (July 2026, verified): Kaggle free = ~30 GPU-h/week T4, 12h max
  sessions, schedulable headless runs allowed (Colab free ToS discourages
  non-interactive use. Kaggle is the chosen platform). Unsloth free-tier notebooks
  cover Llama-3.2-1B/3B, Qwen small, Gemma small; a 1-3B QLoRA over 3-9M training
  tokens ≈ 1-3h on T4. Base model decision: START with Llama-3.2-3B-Instruct (most
  mature Unsloth path) to validate the pipeline end-to-end; swap base to Qwen3-4B or
  SmolLM3-3B in run 2 (both Apache-2.0; better quality at size). the notebook must
  take base model as a parameter. LoRA r=16, alpha=16, LR 2e-4 cosine→5e-5, 1-2 epochs
  ONLY at this dataset size, 5-10% general instruction data mixed in (use a public
  alpaca-cleaned slice) to prevent capability collapse.
- Dataset design (decided here): one example per (analysis_id, dimension) graded row
  where dimension ∈ {direction_1d, range_1d, market_mood_1d, top_performer_1d}:
  system: fixed short instruction ("You are a calibrated Indian-market signal grader.
  Given the day's context, output JSON: {\"call\": ..., \"confidence\": 0-100}").
  user: prediction_embeddings.feature_text for that (analysis_id, dimension). it
  already serializes the day's context compactly.
  assistant: JSON with the REALIZED-correct call and a REALISTIC confidence: the
  dimension's trailing-90d accuracy at training-data-build time (from accuracy_summary),
  NOT 100. teaching stated confidence = expected accuracy. 
  TEMPORAL split (mandatory, market data): eval = the most recent 20% of examples by
  analysis run_at; train = the rest. Never random split.
- Serving/eval design (decided here): NO always-on serving (research verdict: no viable
  free path). Instead: `.github/workflows/specialist_eval.yml` (workflow_dispatch +
  weekly Sat cron) downloads the GGUF from the repo's GitHub Release assets (free
  storage), runs llama.cpp (prebuilt binary via apt/gh release) over the LAST 10 days of
  payload feature_texts, writes each prediction into prediction_scores via the existing
  grader machinery with model_slug="specialist-v{n}". the existing per-dim accuracy
  tooling then compares specialist vs live chain for free.
- Gotchas: (1) Kaggle secrets: the notebook needs SUPABASE_URL/KEY as Kaggle secrets to
  pull the dataset. or simpler (decided): the exporter runs LOCALLY/in-Actions and
  commits `data/finetune/train.jsonl` + `eval.jsonl` to the repo (they're a few MB;
  private-ish data but the repo is already private... VERIFY repo visibility first; if
  public, upload as a Kaggle private dataset instead. put this check in step 1).
  (2) GGUF upload: Kaggle output → user downloads → attaches to a GitHub Release
  (assets up to 2GB free). manual step, documented for the user. (3) grader must not
  double-count specialist rows in the LIVE accuracy dims. compute_summaries and
  feedback filter model_slug is null for the live track (grep first; if they don't
  filter, ADD the filter. that's a correctness fix regardless).

CONSTRAINTS
- Must stay inside: new `analyzer/finetune_export.py`, new
  `notebooks/arcemx_lora_kaggle.ipynb`, new `.github/workflows/specialist_eval.yml`,
  new `analyzer/specialist_eval.py`, `analyzer/grader.py`/`analyzer/feedback.py` (only
  the model_slug filter fix if missing).
- Must not change: live analysis chain, SYSTEM_PROMPT, paper trader.
- Non-negotiables: temporal split; specialist stays advisory (nothing reads its output
  except grading) until its 30d accuracy beats the live chain on >= 2 dims. that
  promotion decision is the USER's, documented in ROADMAP.md, not automated.

STEP-BY-STEP PLAN
1. Check repo visibility (`gh repo view rusteezee/arcemx --json isPrivate`). Private →
   commit JSONLs; public → Kaggle private dataset path (adjust step 2's output target).
2. `analyzer/finetune_export.py`. CLI: joins prediction_scores (the 4 dims) +
   prediction_embeddings.feature_text + accuracy_summary (trailing accuracy per dim),
   emits train/eval JSONL per the dataset design, prints counts + date ranges +
   a 3-example preview. Refuse to run if total examples < 3,000.
3. `notebooks/arcemx_lora_kaggle.ipynb`. parameterized (BASE_MODEL, JSONL paths):
   Unsloth QLoRA per the hyperparameters above, eval-loss early stop, exports LoRA
   adapter + merged Q4_K_M GGUF to /kaggle/working with clear download instructions cell.
4. `analyzer/specialist_eval.py` + `specialist_eval.yml`. llama.cpp batch scoring per
   the serving design; upsert with model_slug; never touches live dims (filter fix from
   gotcha 3 if needed).
5. Documentation cell/README section: the exact manual loop the user runs monthly -
   export → upload → run notebook → download GGUF → attach to release → dispatch eval.
6. Verify what's verifiable NOW without the 3k gate: exporter dry-run prints correct
   counts and refuses below threshold; notebook lints (nbformat validate); eval workflow
   runs llama.cpp with a tiny public GGUF (e.g. Qwen 0.5B) end-to-end writing one
   test row with model_slug="specialist-smoke" then deleting it.

EXACT INPUTS TO USE
- Kick-off prompt: "Implement blueprint 13-lora-finetune-pipeline.md from
  C:\Users\rahul\Downloads\stock-ai\blueprints\. Note the 3,000-row gate: build and
  smoke-test everything, but the first real training run waits for the gate."

DEFINITION OF DONE
[ ] Exporter produces valid chat JSONL with temporal split (spot-check: newest train
    example is older than oldest eval example).
[ ] Exporter refuses below 3,000 rows with a clear message.
[ ] Notebook validates and documents the full Kaggle run for the user.
[ ] specialist_eval smoke test writes + cleans a model_slug row via a tiny GGUF in
    a real GH Actions run.
[ ] Live accuracy dims provably exclude model_slug rows (grep or fix shown).
[ ] User-facing monthly-loop doc exists.

IF SOMETHING IS UNCLEAR
Smallest safe assumption, tag "ASSUMPTION:", keep going. Do not attempt free always-on
serving (researched: not viable July 2026) and do not automate promotion.
