import { useMemo } from 'react';
import { useStore } from './store/store';
import type { TrackEntry } from './analyze/segments';
import { tileStats, type TileStats } from './analyze/routes';
import { useCore } from './core';

export const useUnits = () => useStore((s) => s.profile.units);

/** Activities that have a GPS track, paired with it. */
export function useEntries(): TrackEntry[] {
  const acts = useStore((s) => s.activities);
  const tracks = useStore((s) => s.tracks);
  return useMemo(() => acts.filter((a) => tracks.has(a.id)).map((a) => ({ summary: a, track: tracks.get(a.id)! })), [acts, tracks]);
}

export function useTiles(entries: TrackEntry[]): TileStats {
  const { now } = useCore();
  return useMemo(() => tileStats(entries, now), [entries, now]);
}
