import type { Profile } from './types';

export const DEFAULT_PROFILE: Profile = {
  name: 'Athlete',
  units: 'metric',
  weightKg: 70,
  sex: 'm',
  maxHR: 190,
  restHR: 55,
  lthr: 168,
  ftp: 220,
  thresholdSpeed: 3.7, // ≈ 4:30 /km
  hrZoneModel: 'lthr',
  runLoadSource: 'auto',
  gapDownhillCredit: 0.5,
  mapTiles: 'off',
  weekStart: 1,
};
