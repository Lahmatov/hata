import { config } from './config.ts';
import { featuresFromText, type Features } from './adapters/text.ts';
import { localMedian } from './extras.ts';
import type { Listing } from './types.ts';

// A 0-100 rating to rank favourites. Transparent on purpose: every part is shown next to the total, so a
// surprising rank can be traced to one number. Unknown values get a middling score, never zero or full.

/** local: the €/m² median it compared against (reused by the spreadsheet). */
export interface Score { total: number; parts: [label: string, got: number, max: number][]; text: string; local: { m: number; label: string; n: number } | null }

const lerp = (x: number, x0: number, x1: number, max: number) => max * Math.min(1, Math.max(0, (x - x0) / (x1 - x0)));
const CONDITION: Record<string, number> = { new: 10, renovated: 9, good: 6, unknown: 4, needs_renovation: 0 };

export function score(l: Listing, pool: Listing[], f: Features = featuresFromText(l.description)): Score {
  const c = config.criteria;
  const local = l.price_per_m2 ? localMedian(l, pool) : null;
  const extras = (l.bathrooms !== null && l.bathrooms >= 3 ? 3 : 0) + (l.elevator ? 2 : 0) + (f.balcony || f.terrace ? 2 : 0)
    + (f.storage ? 1 : 0) + (f.ac ? 1 : 0) + (f.pool || f.closedCondo ? 1 : 0) + (f.suites ? 1 : 0);
  const parts: Score['parts'] = [
    // Full marks 60k under budget, nothing at the negotiable ceiling.
    ['цена', l.price === null ? 10 : lerp(c.maxPriceNegotiable - l.price, 0, c.maxPriceNegotiable - (c.maxPrice - 60_000), 25), 25],
    ['дорога', l.commute_min === null ? 10 : lerp(c.hardCommuteMin - l.commute_min, 0, c.hardCommuteMin - 10, 25), 25],
    ['площадь', l.area_m2 === null ? 5 : l.area_m2 < c.minAreaM2 ? 0 : 3 + lerp(l.area_m2, c.minAreaM2, 130, 12), 15],
    // €/m² against the local median: 20% cheaper = full marks, 20% dearer = nothing.
    ['€/м² к району', !local || !l.price_per_m2 ? 7 : lerp((local.m - l.price_per_m2) / local.m, -0.2, 0.2, 15), 15],
    ['состояние', CONDITION[l.condition ?? 'unknown'], 10],
    ['удобства', Math.min(10, extras), 10],
  ];
  for (const p of parts) p[1] = Math.round(p[1]);
  const total = parts.reduce((s, p) => s + p[1], 0);
  return { total, parts, text: parts.map(([label, got, max]) => `${label} ${got}/${max}`).join(' · '), local };
}
