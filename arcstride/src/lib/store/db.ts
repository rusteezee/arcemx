// Tiny IndexedDB wrapper with an in-memory fallback (private windows, blocked storage, sandboxed iframes).
type StoreName = 'kv' | 'activities' | 'tracks' | 'streams';
const NAMES: StoreName[] = ['kv', 'activities', 'tracks', 'streams'];

const mem: Record<StoreName, Map<string, unknown>> = { kv: new Map(), activities: new Map(), tracks: new Map(), streams: new Map() };
let dbp: Promise<IDBDatabase | null> | null = null;
let persistent = false;
export const isPersistent = () => persistent;

function open(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open('arcstride', 1);
      req.onupgradeneeded = () => {
        for (const n of NAMES) if (!req.result.objectStoreNames.contains(n)) req.result.createObjectStore(n);
      };
      req.onsuccess = () => {
        persistent = true;
        resolve(req.result);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise<T | undefined>((resolve) => {
        if (!db) return resolve(undefined);
        try {
          const t = db.transaction(store, mode);
          const r = fn(t.objectStore(store));
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      }),
  );
}

export const db = {
  async get<T>(store: StoreName, key: string): Promise<T | undefined> {
    const d = await open();
    if (!d) return mem[store].get(key) as T | undefined;
    return (await tx<T>(store, 'readonly', (s) => s.get(key))) as T | undefined;
  },
  async put(store: StoreName, key: string, value: unknown): Promise<void> {
    const d = await open();
    if (d) await tx(store, 'readwrite', (s) => s.put(value, key));
    else mem[store].set(key, value);
  },
  async del(store: StoreName, key: string): Promise<void> {
    const d = await open();
    if (d) await tx(store, 'readwrite', (s) => s.delete(key));
    else mem[store].delete(key);
  },
  async clear(store: StoreName): Promise<void> {
    const d = await open();
    if (d) await tx(store, 'readwrite', (s) => s.clear());
    else mem[store].clear();
  },
  async all<T>(store: StoreName): Promise<{ key: string; value: T }[]> {
    const d = await open();
    if (!d) return [...mem[store].entries()].map(([key, value]) => ({ key, value: value as T }));
    return new Promise((resolve) => {
      try {
        const out: { key: string; value: T }[] = [];
        const req = d.transaction(store, 'readonly').objectStore(store).openCursor();
        req.onsuccess = () => {
          const c = req.result;
          if (c) {
            out.push({ key: String(c.key), value: c.value as T });
            c.continue();
          } else resolve(out);
        };
        req.onerror = () => resolve(out);
      } catch {
        resolve([]);
      }
    });
  },
};
