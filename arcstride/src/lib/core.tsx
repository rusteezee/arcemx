import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useStore } from './store/store';
import type { ActivitySummary, Loads } from './types';
import { computeAllLoads, dailyLoads, buildPMC, type PMCPoint } from './analyze/load';
import { predictRaces, type PredictionSet } from './analyze/predict';
import { buildInsights, goalProgress, readiness, type GoalProgress, type Insight, type Readiness } from './analyze/coach';
import { dayNumOf, dayNumToKey } from './units';

export interface Core {
  acts: ActivitySummary[];
  byId: Map<string, ActivitySummary>;
  loads: Map<string, Loads>;
  daily: Map<number, number>;
  pmc: PMCPoint[];
  last?: PMCPoint;
  pred?: PredictionSet;
  ready: Readiness;
  goals: GoalProgress[];
  insights: Insight[];
  now: number;
  tz: number; // browser tz offset (minutes east)
  today: number; // local day number
  todayKey: string;
}

const Ctx = createContext<Core | null>(null);

export function CoreProvider({ children }: { children: ReactNode }) {
  const acts = useStore((s) => s.activities);
  const profile = useStore((s) => s.profile);
  const goalsDef = useStore((s) => s.goals);
  const checkins = useStore((s) => s.checkins);

  const core = useMemo<Core>(() => {
    const now = Date.now();
    const tz = -new Date().getTimezoneOffset();
    const today = dayNumOf(now, tz);
    const loads = computeAllLoads(acts, profile);
    const daily = dailyLoads(acts, loads);
    const first = daily.size ? Math.min(...daily.keys()) : today;
    const pmc = daily.size ? buildPMC(daily, first, today) : [];
    const last = pmc[pmc.length - 1];
    const pred = predictRaces(acts, now);
    const todayKey = dayNumToKey(today);
    const ready = readiness(last, checkins, todayKey);
    const goals = goalsDef.map((g) => goalProgress(g, acts, today, profile.weekStart));
    const insights = buildInsights({ acts, loads, pmc, daily, profile, goals, pred, readiness: ready, now, today, tz });
    return { acts, byId: new Map(acts.map((a) => [a.id, a])), loads, daily, pmc, last, pred, ready, goals, insights, now, tz, today, todayKey };
  }, [acts, profile, goalsDef, checkins]);

  return <Ctx.Provider value={core}>{children}</Ctx.Provider>;
}

export function useCore(): Core {
  const c = useContext(Ctx);
  if (!c) throw new Error('CoreProvider missing');
  return c;
}
