"""Telegram text for the US daily brief and its grade follow-up.

Pure formatting, plain text (the brief body is model-written and may hold
Markdown control characters). House style: dd/mm/yyyy dates, no emojis,
geometric glyphs only. Price levels are USD per share on purpose: these are
US-listed prices, and converting a stop or target to rupees would hide the
number the broker app shows.
"""
from __future__ import annotations

from datetime import date

_UP, _DOWN = "▲", "▼"
GATE_SAMPLES = 60  # graded calls required before any edge claim (India doctrine)
_MIN_RECORD_SAMPLES = 5


def _usd(value) -> str:
    return f"${float(value):,.2f}"


def _dd_mm_yyyy(iso: str) -> str:
    try:
        return date.fromisoformat(str(iso)[:10]).strftime("%d/%m/%Y")
    except ValueError:
        return str(iso)


def _glyph(direction: str) -> str:
    return _UP if direction == "up" else _DOWN


def _pct(value) -> str:
    return "n/a" if value is None else f"{float(value):.0f}%"


def format_track_record(rec: dict | None) -> str:
    n5 = (rec or {}).get("n5", 0)
    if not rec or n5 < _MIN_RECORD_SAMPLES:
        return (f"Track record: building ({n5} graded 5-session calls, "
                f"{GATE_SAMPLES} needed before any claim of edge).")
    return (f"Track record, {n5} graded 5-session calls: hit {_pct(rec['hit5'])} vs "
            f"always-up {_pct(rec['base_up5'])} vs momentum {_pct(rec['base_mom5'])}. "
            f"1-session hit {_pct(rec['hit1'])} over {rec['n1']}. "
            f"Needs {GATE_SAMPLES} before any claim of edge.")


def _brief_block(row: dict) -> str:
    lines = [
        f"{row['ticker']}: {row['stance'].upper()} | 1d {_glyph(row['direction_1d'])} "
        f"{row['direction_1d'].upper()} | 5d {_glyph(row['direction_5d'])} "
        f"{row['direction_5d'].upper()} | conf {row['confidence']}",
        f"  Last {_usd(row['price_at_brief'])} | Stop {_usd(row['stop_price'])} "
        f"| Target {_usd(row['target_price'])}",
        f"  {row['summary']}",
    ]
    if row.get("next_earnings"):
        lines.append(f"  Next earnings {_dd_mm_yyyy(row['next_earnings'])}")
    return "\n".join(lines)


def format_brief(session_date: str, rows: list[dict], record: dict | None,
                 failed: list[str] | None = None) -> str:
    parts = [f"US Brief for the {_dd_mm_yyyy(session_date)} session (pre-open)"]
    parts.extend(_brief_block(r) for r in rows)
    if failed:
        parts.append("No brief produced for: " + ", ".join(failed))
    parts.append(format_track_record(record))
    parts.append("Advisory only. Nothing here can trade.")
    return "\n\n".join(parts)


def format_grade_line(brief: dict, update: dict) -> str | None:
    """One line for the longest horizon graded in this update; None when the
    update graded nothing."""
    when = _dd_mm_yyyy(brief["brief_date"])
    if update.get("correct_5d") is not None:
        spy = update.get("spy_ret_5d_pct")
        spy_txt = f" (SPY {spy:+.1f}%)" if spy is not None else ""
        level = f", {update['hit']} level touched" if update.get("hit") in ("stop", "target") else ""
        verdict = "HIT" if update["correct_5d"] else "MISS"
        return (f"{brief['ticker']} {when} 5d called {brief['direction_5d'].upper()}: "
                f"{update['ret_5d_pct']:+.1f}%{spy_txt} {verdict}{level}")
    if update.get("correct_1d") is not None:
        verdict = "HIT" if update["correct_1d"] else "MISS"
        return (f"{brief['ticker']} {when} 1d called {brief['direction_1d'].upper()}: "
                f"{update['ret_1d_pct']:+.1f}% {verdict}")
    return None
