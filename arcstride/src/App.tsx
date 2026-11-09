import { useEffect, useState } from 'react';
import { CoreProvider } from './lib/core';
import { Link, useRoute } from './lib/router';
import { importFiles, init, useStore } from './lib/store/store';
import { GLYPH, Glyph } from './ui/kit';
import { Dashboard } from './pages/Dashboard';
import { Activities } from './pages/Activities';
import { ActivityDetail } from './pages/ActivityDetail';
import { Training } from './pages/Training';
import { Performance } from './pages/Performance';
import { RoutesPage } from './pages/Routes';
import { PlanPage } from './pages/Plan';
import { GoalsPage } from './pages/Goals';
import { RecordPage } from './pages/Record';
import { SettingsPage } from './pages/Settings';

const NAV = [
  { to: '/', label: 'Today', glyph: GLYPH.today },
  { to: '/activities', label: 'Activities', glyph: GLYPH.activities },
  { to: '/training', label: 'Training', glyph: GLYPH.training },
  { to: '/performance', label: 'Performance', glyph: GLYPH.performance },
  { to: '/routes', label: 'Routes', glyph: GLYPH.routes },
  { to: '/plan', label: 'Plan', glyph: GLYPH.plan },
  { to: '/goals', label: 'Goals', glyph: GLYPH.goals },
  { to: '/settings', label: 'Settings', glyph: GLYPH.settings },
];

function Nav() {
  const r = useRoute();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [r.path]);
  const active = (to: string) => (to === '/' ? r.path === '/' : r.path === to || r.path.startsWith(to + '/') || (to === '/activities' && r.path.startsWith('/activity/')));
  return (
    <>
      <nav className="nav" aria-label="Primary">
        <Link to="/" className="brand">
          <Glyph g="◈" /> ArcStride
        </Link>
        <div className="nav-links">
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} className={`nav-link${active(n.to) ? ' active' : ''}`} aria-current={active(n.to) ? 'page' : undefined}>
              <Glyph g={n.glyph} />
              {n.label}
            </Link>
          ))}
        </div>
        <Link to="/record" className="btn sm nav-cta">
          <span className="dot" /> Record
        </Link>
        <button className="btn ghost sm nav-menu-btn" aria-expanded={open} aria-controls="nav-panel" onClick={() => setOpen((o) => !o)}>
          {open ? 'Close' : 'Menu'}
        </button>
      </nav>
      {open && (
        <div className="nav-panel" id="nav-panel">
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} className={`nav-link${active(n.to) ? ' active' : ''}`}>
              <Glyph g={n.glyph} />
              {n.label}
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

function Overlays() {
  const busy = useStore((s) => s.busy);
  const toasts = useStore((s) => s.toasts);
  return (
    <>
      {busy && (
        <div className="busy" role="status" aria-live="polite">
          <div className="box">
            <div className="eyebrow">Working</div>
            <h3>{busy.label}</h3>
            <div className="meter lime">
              <i style={{ width: busy.total ? `${(busy.done / busy.total) * 100}%` : '35%', transition: 'width .2s' }} />
            </div>
            <p style={{ fontSize: 13 }}>Everything is processed on this device. Nothing is uploaded.</p>
          </div>
        </div>
      )}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'ok' ? '' : t.kind}`}>
            <Glyph g={t.kind === 'ok' ? '✦' : t.kind === 'warn' ? '◆' : '▲'} /> {t.msg}
          </div>
        ))}
      </div>
    </>
  );
}

function Router() {
  const r = useRoute();
  const [head, id] = r.parts;
  switch (head) {
    case undefined:
      return <Dashboard />;
    case 'activities':
      return <Activities />;
    case 'activity':
      return <ActivityDetail id={id} />;
    case 'training':
      return <Training />;
    case 'performance':
      return <Performance />;
    case 'routes':
      return <RoutesPage tab={r.query.get('tab') ?? 'heatmap'} />;
    case 'plan':
      return <PlanPage tab={r.query.get('tab') ?? 'plan'} />;
    case 'goals':
      return <GoalsPage />;
    case 'record':
      return <RecordPage />;
    case 'settings':
      return <SettingsPage />;
    default:
      return <Dashboard />;
  }
}

export function App() {
  const ready = useStore((s) => s.ready);
  useEffect(() => {
    void init();
  }, []);
  // drop files anywhere on the window to import
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (e.dataTransfer?.files.length && !(e.target as HTMLElement).closest?.('.dropzone')) {
        e.preventDefault();
        void importFiles(Array.from(e.dataTransfer.files));
      }
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);
  if (!ready)
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <div className="eyebrow">Loading your library…</div>
      </div>
    );
  return (
    <CoreProvider>
      <Nav />
      <main className="page">
        <Router />
      </main>
      <Overlays />
    </CoreProvider>
  );
}
