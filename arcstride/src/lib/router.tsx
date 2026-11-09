import { useEffect, useState, type AnchorHTMLAttributes, type ReactNode } from 'react';

export interface Route {
  path: string; // e.g. "/activity/a123"
  parts: string[];
  query: URLSearchParams;
}

function read(): Route {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const [p, q] = raw.split('?');
  return { path: p || '/', parts: (p || '/').split('/').filter(Boolean), query: new URLSearchParams(q ?? '') };
}

export function useRoute(): Route {
  const [r, setR] = useState<Route>(read);
  useEffect(() => {
    const on = () => {
      setR(read());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return r;
}

export function navigate(to: string) {
  window.location.hash = to.startsWith('/') ? to : '/' + to;
}

export function Link({ to, children, ...rest }: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a href={'#' + to} {...rest}>
      {children}
    </a>
  );
}
