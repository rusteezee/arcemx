"""Telegram text for the /us command (blueprint 25, Phase 1).

Pure formatting: takes the rows the bot already fetched from `us_holdings`
and `us_events` and returns one Telegram-Markdown message. No I/O here so it
is unit-testable and cannot fail on a network or DB error.

House style (AGENTS.md): no emojis (geometric glyphs only), dd/mm/yyyy,
12-hour IST AM/PM uppercase, Indian rupee with Indian digit grouping.
Names are not printed (they may hold Markdown control characters); tickers
go in backticks.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

_IST = timezone(timedelta(hours=5, minutes=30))
_UP, _DOWN = "▲", "▼"
_MAX_EVENTS = 6


def _num(value) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _group_indian(digits: str) -> str:
    if len(digits) <= 3:
        return digits
    head, tail = digits[:-3], digits[-3:]
    groups = []
    while len(head) > 2:
        groups.insert(0, head[-2:])
        head = head[:-2]
    if head:
        groups.insert(0, head)
    return ",".join(groups + [tail])


def inr(value, signed: bool = False) -> str:
    """Whole rupees with Indian grouping, e.g. 1234567 -> ₹12,34,567."""
    n = round(_num(value))
    sign = "-" if n < 0 else ("+" if signed and n > 0 else "")
    return f"{sign}₹{_group_indian(str(abs(n)))}"


def _pct(value) -> str:
    return f"{_num(value):+.1f}%"


def _dd_mm_yyyy(iso: str) -> str:
    try:
        return date.fromisoformat(str(iso)[:10]).strftime("%d/%m/%Y")
    except ValueError:
        return str(iso)


def _synced_line(holdings: list[dict]) -> str:
    stamps = []
    for h in holdings:
        raw = h.get("synced_at")
        if not raw:
            continue
        try:
            stamps.append(datetime.fromisoformat(str(raw).replace("Z", "+00:00")))
        except ValueError:
            continue
    if not stamps:
        return ""
    at = max(stamps).astimezone(_IST)
    hour = at.hour % 12 or 12
    meridiem = "AM" if at.hour < 12 else "PM"
    return f"_Synced {at:%d/%m/%Y} {hour:02d}:{at:%M} {meridiem} IST_"


def _holding_block(h: dict) -> str:
    pnl = _num(h.get("pnl_inr"))
    glyph = _UP if pnl >= 0 else _DOWN
    units = _num(h.get("units"))
    return (
        f"{glyph} `{h['ticker']}` x{units:g}\n"
        f"  Invested {inr(h.get('invested_inr'))} | Value {inr(h.get('value_inr'))}\n"
        f"  P&L {inr(pnl, signed=True)} ({_pct(h.get('pnl_pct'))}) | "
        f"Today {inr(h.get('one_day_change_inr'), signed=True)}"
    )


def _event_line(e: dict) -> str:
    flag = f" [flagged: {e['material_reason']}]" if e.get("material") and e.get("material_reason") else ""
    return f"• `{e['ticker']}` {e['form']} {_dd_mm_yyyy(e['filed_date'])}{flag}"


def format_us_summary(holdings: list[dict], events: list[dict]) -> str:
    if not holdings:
        return ("No US holdings synced yet. The sync runs 12:30 and 21:30 UTC "
                "Mon to Fri and reads INDmoney.")
    ordered = sorted(holdings, key=lambda h: -_num(h.get("value_inr")))
    invested = sum(_num(h.get("invested_inr")) for h in ordered)
    value = sum(_num(h.get("value_inr")) for h in ordered)
    pnl = value - invested
    pnl_pct = pnl / invested * 100 if invested else 0.0

    parts = ["*US Holdings*", "\n\n".join(_holding_block(h) for h in ordered)]
    parts.append(f"*Total:* Invested {inr(invested)} -> {inr(value)} | "
                 f"P&L {inr(pnl, signed=True)} ({_pct(pnl_pct)})")
    synced = _synced_line(ordered)
    if synced:
        parts.append(synced)

    parts.append("*Recent SEC Filings*")
    if events:
        parts.append("\n".join(_event_line(e) for e in events[:_MAX_EVENTS]))
    else:
        parts.append("None stored yet.")
    parts.append("_Amounts in INR as INDmoney reports them (FX included). "
                 "Advisory only, nothing here can trade._")
    return "\n\n".join(parts)
