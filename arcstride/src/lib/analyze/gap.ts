import { clamp } from '../units';

/**
 * ArcGAP — grade-adjusted pace.
 *
 * Base: Minetti et al. (2002) metabolic cost of running, J·kg⁻¹·m⁻¹ as a 5th-order
 * polynomial of gradient i (fraction). Flat cost C(0) = 3.6.
 *   C(i) = 155.4 i⁵ − 30.4 i⁴ − 43.3 i³ + 46.3 i² + 19.5 i + 3.6
 *
 * Flat-equivalent speed at equal metabolic power = v · C(i) / C(0).
 *
 * Uphill uses Minetti as published. Downhill is adjusted because Strava's 2017 heart-rate based
 * study (≈6 M runs) found real runners gain less on descents than Minetti predicts, with the
 * benefit peaking near −9 % and vanishing by −18 %. We therefore:
 *   • use Minetti down to −9 %,
 *   • fade the benefit linearly to zero at −18 %,
 *   • penalise steeper descents (braking cost),
 *   • scale the whole downhill credit by `credit` (0‥1, user-adjustable).
 */
export const C0 = 3.6;

export function minettiCost(i: number): number {
  const g = clamp(i, -0.45, 0.45);
  return 155.4 * g ** 5 - 30.4 * g ** 4 - 43.3 * g ** 3 + 46.3 * g ** 2 + 19.5 * g + 3.6;
}

const F_AT_M9 = minettiCost(-0.09) / C0;

export function gapFactor(grade: number, credit = 0.5): number {
  if (grade >= 0) return minettiCost(grade) / C0;
  const a = -grade;
  let f: number;
  if (a <= 0.09) f = minettiCost(grade) / C0;
  else if (a <= 0.18) f = F_AT_M9 + (1 - F_AT_M9) * ((a - 0.09) / 0.09);
  else f = Math.min(1.5, 1 + 1.5 * (a - 0.18));
  // scale only the *benefit* (f < 1) by the credit; braking penalties apply in full
  return f < 1 ? 1 + (f - 1) * credit : f;
}
