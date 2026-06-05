interface EmptyStateProps {
  title: string;
  hint?: string;
  glyph?: string;
}

export function EmptyState({ title, hint, glyph = "◯" }: EmptyStateProps) {
  return (
    <div className="card p-10 text-center">
      <div className="glyph text-3xl mb-3">{glyph}</div>
      <div className="font-medium text-sm">{title}</div>
      {hint && <div className="text-xs text-[var(--muted)] mt-1.5">{hint}</div>}
    </div>
  );
}
