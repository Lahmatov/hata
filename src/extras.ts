import { config, norm } from './config.ts';
import type { Point } from './geo.ts';
import type { Listing } from './types.ts';

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const k = (n: number) => `${Math.round(n / 1000)}`;

/**
 * Flats to compare prices with: T3+ of the minimum size, one listing per duplicate group (a flat on three
 * portals counts once; the group's first listing may lack bedrooms or area, so take the first that has them).
 */
export function comparablePool(listings: Listing[]): Listing[] {
  const byGroup = new Map<string, Listing>();
  for (const l of listings) {
    if ((l.bedrooms ?? 0) < config.criteria.minBedrooms || (l.area_m2 ?? 0) < config.criteria.minAreaM2) continue;
    if (!byGroup.has(l.group_id)) byGroup.set(l.group_id, l);
  }
  return [...byGroup.values()];
}

/** Median €/m² of comparable flats: the same parish if it has enough of them, else the same municipality. */
export function localMedian(l: Listing, pool: Listing[], minSample = 6): { m: number; label: string; n: number } | null {
  for (const [field, label] of [['neighborhood', l.neighborhood], ['municipality', l.municipality]] as const) {
    if (!label) continue;
    const peers = pool.filter((p) => p.price_per_m2 && norm(p[field]) === norm(label) && p.group_id !== l.group_id).map((p) => p.price_per_m2!);
    if (peers.length >= minSample) return { m: median(peers), label, n: peers.length };
  }
  return null;
}

/**
 * 🔥 "Good deal": price per m² clearly below the median of comparable flats we have seen recently
 * (same parish if it has enough of them, else the same municipality).
 */
export function dealNote(l: Listing, pool: Listing[], threshold = 0.12, minSample = 6): string | null {
  if (!l.price_per_m2) return null;
  const local = localMedian(l, pool, minSample);
  if (!local) return null;
  const diff = (local.m - l.price_per_m2) / local.m;
  return diff >= threshold
    ? `🔥 на ${Math.round(diff * 100)}% дешевле среднего по ${local.label} (${Math.round(local.m).toLocaleString('pt-PT')} €/м², ${local.n} кв.)`
    : null;
}

/** 💶 Price history, e.g. "440 → 425 → 415 тыс." (only when the price changed at least once). */
export function historyNote(prices: number[]): string | null {
  return prices.length >= 2 ? `💶 история цены: ${prices.map(k).join(' → ')} тыс.` : null;
}

/** Google Maps driving directions from the flat to the school. */
export function routeUrl(l: Listing, school: Point | null): string | null {
  if (!school) return null;
  const origin = l.lat !== null && l.lon !== null
    ? `${l.lat},${l.lon}`
    : [l.address, l.neighborhood, l.municipality, 'Portugal'].filter(Boolean).join(', ');
  if (!origin || origin === 'Portugal') return null;
  const q = new URLSearchParams({ api: '1', origin, destination: `${school.lat},${school.lon}`, travelmode: 'driving' });
  return `https://www.google.com/maps/dir/?${q}`;
}
