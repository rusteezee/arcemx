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
- Indices (NIFTY, Sensex) shown as plain comma-formatted numbers,
  never with a currency prefix. They are points, not rupees.
- Card radius 22px. Logo `fill="#ffffff"`.

## Tier palette (Conviction A / B / C)

- A = `var(--gain)` (green). Class `pill-gain`.
- B = `var(--mid)` (lime). Class `pill-mid`.
- C = `var(--warn)` (amber). Class `pill-warn`.

## Next.js apps

Both Next.js apps (`web/` and `marketing/`) carry their own AGENTS.md
warning. Heed it before writing Next code.
