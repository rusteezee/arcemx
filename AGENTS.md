# Project rules (binding)

## Brand typography

- **No em dashes (U+2014) anywhere.** Not in user-facing text, not in
  code comments, not in commit messages. Use a period, a comma, a
  semicolon, or a middle dot (U+00B7) instead. Run
  `python scripts/strip_emdash.py` from the repo root if any slip in.
  The script is idempotent and safe to re-run. This rule applies to
  every future change to this repo.
- **No emojis in user-facing text.** Use Lucide icons or Unicode
  glyphs (the brand set is the geometric ones used throughout the
  dashboard).
- Title Case headings. `dd/mm/yyyy` dates. 12-hour IST AM/PM
  uppercase.
- Indian Rupee plus Indian commas for prices, sector ranges, and
  per-stock ranges.
- Indian Rupee prefix is applied to any price-level number in prose
  (support / resistance / target / stop / entry / level), including
  index levels like NIFTY 23,070 -> ₹23,070. The earlier rule that
  stripped ₹ from indices is dropped; consistent number formatting
  across stocks and indices reads better in mixed prose than a
  technically-pure points-vs-rupees distinction.
- Standalone index quotes outside price-level context (e.g. the
  Snapshot card's NIFTY chip, the Markets page heatmap) stay plain
  comma-formatted with no ₹.
- Card radius 22px. Logo `fill="#ffffff"`.

## Tier palette (Conviction A / B / C)

- A = `var(--gain)` (green). Class `pill-gain`.
- B = `var(--mid)` (lime). Class `pill-mid`.
- C = `var(--warn)` (amber). Class `pill-warn`.

## Next.js apps

Both Next.js apps (`web/` and `marketing/`) carry their own AGENTS.md
warning. Heed it before writing Next code.
