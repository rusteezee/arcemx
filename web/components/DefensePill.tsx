"use client";

// blueprint 23 (Plan C Phase 1): renders portfolio_defense_snapshot's
// status against a real holding. Silent (renders nothing) for "clear" or
// missing data - matches the Telegram side's design call that silence is
// itself informative here, and a stale/absent snapshot must never read as
// a false all-clear.
export function DefensePill({
  status,
  reason,
}: {
  status?: string | null;
  reason?: string | null;
}) {
  if (!status || status === "clear" || status === "no_data") return null;
  const cls = status === "avoid" ? "pill-loss" : "pill-warn";
  const label = status === "avoid" ? "Avoid" : "Caution";
  return (
    <span className={`pill ${cls}`} title={reason || undefined}>
      {label}
    </span>
  );
}
