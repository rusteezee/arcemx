"""Replace every em dash (U+2014) in the repo with brand-safe punctuation.

Rules:
- Quoted em-dash placeholder strings become a quoted middle dot
  (the brand "no value" cell marker).
- Inline space + em dash + space (a sentence breaker) becomes period
  + space. Reads as two short sentences.
- Any other bare em dash becomes a hyphen.
- Skips .venv, .git, node_modules, .next, __pycache__, dist, build.

This source file is deliberately written WITHOUT any literal em-dash
glyph in it. EM and MID are built via chr() at runtime so the script
cannot rewrite its own constants on a first pass (the previous
implementation did, with destructive results across the repo). Do not
edit this file to introduce em-dash or middle-dot literals.
"""
from __future__ import annotations
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {".venv", ".git", "node_modules", ".next", "dist", "build",
             "__pycache__"}
EXTS = {".tsx", ".ts", ".js", ".jsx", ".py", ".css", ".sql", ".yml", ".yaml",
        ".md", ".json", ".html", ".gs"}
EXTRA_NAMES = {".gitignore", ".env.example", "Dockerfile", "Procfile"}

EM = chr(0x2014)     # em dash
MID = chr(0x00B7)    # middle dot


def transform(text: str) -> str:
    text = text.replace('"' + EM + '"', '"' + MID + '"')
    text = text.replace("'" + EM + "'", "'" + MID + "'")
    text = text.replace(" " + EM + " ", ". ")
    text = text.replace(EM, "-")
    return text


def main() -> int:
    changed = 0
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            p = Path(dirpath) / name
            if p.suffix.lower() not in EXTS and name not in EXTRA_NAMES:
                continue
            try:
                raw = p.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            if EM not in raw:
                continue
            new = transform(raw)
            if new != raw:
                p.write_text(new, encoding="utf-8")
                changed += 1
                print("  " + str(p.relative_to(ROOT)))
    print(str(changed) + " files updated")
    return changed


if __name__ == "__main__":
    main()
