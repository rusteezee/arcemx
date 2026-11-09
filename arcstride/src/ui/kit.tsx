import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Insight } from '../lib/analyze/coach';

export const GLYPH = { today: '✦', activities: '◈', training: '◎', performance: '⬡', routes: '◷', plan: '◯', goals: '◆', record: '●', settings: '◐', up: '↗', down: '↘' } as const;

export const pad3 = (n: number) => String(n).padStart(3, '0');

export function Glyph({ g, className = '' }: { g: string; className?: string }) {
  return (
    <span className={`glyph ${className}`} aria-hidden="true">
      {g}
    </span>
  );
}

export function PageHead({ tag, n, total, title, lede, actions }: { tag: string; n?: number; total?: number; title: ReactNode; lede?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="eyebrow">
        {n != null && (
          <>
            <span>{pad3(n)}</span>
            <span>/</span>
            <span>{pad3(total ?? n)}</span>
            <span>·</span>
          </>
        )}
        <span>{tag}</span>
      </div>
      <h1>{title}</h1>
      {lede && <p className="lede">{lede}</p>}
      {actions && <div className="row wrap" style={{ marginTop: 6 }}>{actions}</div>}
    </header>
  );
}

/** Numbered section — `001 / 006` is the ArcArmor house structural device. */
export function Section({ n, total, glyph, kicker, title, lede, actions, children, id }: { n: number; total: number; glyph?: string; kicker?: string; title: ReactNode; lede?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="section" id={id}>
      <div className="section-head">
        <div className="titles">
          <div className="eyebrow">
            <span>{pad3(n)}</span>
            <span>/</span>
            <span>{pad3(total)}</span>
            {glyph && <Glyph g={glyph} />}
            {kicker && <span>{kicker}</span>}
          </div>
          <h2>{title}</h2>
          {lede && <p className="lede">{lede}</p>}
        </div>
        {actions && <div className="row wrap">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function Tile({ label, value, unit, delta, dir, explain, big, hint, children }: { label: string; value: ReactNode; unit?: string; delta?: ReactNode; dir?: 'up' | 'down' | ''; explain?: ReactNode; big?: boolean; hint?: string; children?: ReactNode }) {
  return (
    <div className={`tile${big ? ' big' : ''}`} title={hint}>
      <div className="eyebrow">{label}</div>
      <div className="value">
        <span>{value}</span>
        {unit && <span className="unit">{unit}</span>}
      </div>
      {delta != null && <div className={`delta ${dir ?? ''}`}>{delta}</div>}
      {children}
      {explain && <div className="explain">{explain}</div>}
    </div>
  );
}

export function Chip({ tone, children, title }: { tone?: 'pos' | 'neg' | 'warn' | 'lime' | 'mute'; children: ReactNode; title?: string }) {
  return (
    <span className={`chip ${tone ?? ''}`} title={title}>
      {children}
    </span>
  );
}

export function Seg<T extends string | number>({ value, options, onChange, label }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.v)} aria-pressed={o.v === value} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: { v: T; label: string; glyph?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="pill-tabs" role="tablist">
      {options.map((o) => (
        <button key={o.v} role="tab" aria-selected={o.v === value} onClick={() => onChange(o.v)}>
          {o.glyph && <Glyph g={o.glyph} />} {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="field">
      <label className="lbl">{label}</label>
      {children}
      {hint && <span className="muted" style={{ fontSize: 11.5 }}>{hint}</span>}
    </div>
  );
}

/** Numeric input that commits on blur/enter so typing isn't fought by re-renders. */
export function NumField({ value, onCommit, step = 1, min, max, className = 'input mono', suffix }: { value: number; onCommit: (v: number) => void; step?: number; min?: number; max?: number; className?: string; suffix?: string }) {
  const [txt, setTxt] = useState(String(value));
  useEffect(() => setTxt(String(value)), [value]);
  const commit = () => {
    const v = parseFloat(txt);
    if (isFinite(v) && (min == null || v >= min) && (max == null || v <= max)) onCommit(v);
    else setTxt(String(value));
  };
  return (
    <div style={{ position: 'relative' }}>
      <input className={className} inputMode="decimal" value={txt} step={step} onChange={(e) => setTxt(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      {suffix && <span className="muted mono" style={{ position: 'absolute', right: 14, top: 9, fontSize: 12 }}>{suffix}</span>}
    </div>
  );
}

export function Why({ evidence, formula, label = 'Show the math' }: { evidence?: { label: string; value: string }[]; formula?: string; label?: string }) {
  return (
    <details className="why">
      <summary>{label}</summary>
      {evidence && evidence.length > 0 && (
        <div className="ev">
          {evidence.map((e) => (
            <div key={e.label}>
              <span>{e.label}</span>
              <span>{e.value}</span>
            </div>
          ))}
        </div>
      )}
      {formula && <div className="formula">{formula}</div>}
    </details>
  );
}

export function InsightCard({ i }: { i: Insight }) {
  const glyph = { risk: '▲', action: '◆', win: '✦', info: '◯' }[i.kind];
  const tone = { risk: 'neg', action: 'warn', win: 'pos', info: 'mute' }[i.kind] as 'neg' | 'warn' | 'pos' | 'mute';
  return (
    <article className={`insight ${i.kind}`}>
      <h3>
        <Chip tone={tone}>
          <Glyph g={glyph} /> {i.kind}
        </Chip>
        <span>{i.title}</span>
      </h3>
      <p>{i.body}</p>
      <Why evidence={i.evidence} formula={i.formula} />
    </article>
  );
}

export function Empty({ glyph = '◯', title, body, children }: { glyph?: string; title: string; body?: ReactNode; children?: ReactNode }) {
  return (
    <div className="card empty">
      <Glyph g={glyph} />
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {children && <div className="row wrap" style={{ justifyContent: 'center' }}>{children}</div>}
    </div>
  );
}

export function Meter({ frac, tone }: { frac: number; tone?: 'pos' | 'warn' | 'neg' | 'lime' }) {
  return (
    <div className={`meter ${tone ?? ''}`} role="meter" aria-valuenow={Math.round(frac * 100)} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${Math.max(0, Math.min(1, frac)) * 100}%` }} />
    </div>
  );
}

export function Modal({ onClose, children, label }: { onClose: () => void; children: ReactNode; label: string }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

/** Drag-and-drop + click-to-browse file picker. */
export function Dropzone({ onFiles, title, hint }: { onFiles: (f: File[]) => void; title: string; hint: string }) {
  const [over, setOver] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`dropzone${over ? ' over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <Glyph g="⬡" className="muted" />
      <h3>{title}</h3>
      <p style={{ fontSize: 14 }}>{hint}</p>
      <button className="btn" onClick={() => ref.current?.click()}>
        Choose files
      </button>
      <input ref={ref} type="file" multiple hidden accept=".gpx,.tcx,.fit,.gz,.zip,.csv" onChange={(e) => e.target.files && onFiles(Array.from(e.target.files))} />
    </div>
  );
}

export function SourceChip({ source }: { source: string }) {
  if (source === 'demo') return <Chip tone="warn" title="Synthetic data generated by ArcStride's demo athlete">demo data</Chip>;
  if (source === 'recorded') return <Chip tone="lime">recorded</Chip>;
  if (source === 'strava-archive') return <Chip tone="mute">strava export</Chip>;
  return <Chip tone="mute">file</Chip>;
}
