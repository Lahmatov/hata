import { config } from './config.ts';
import type { Store } from './db.ts';
import { log } from './log.ts';
import type { Point } from './geo.ts';

// What is near a favourite flat, from OpenStreetMap (Overpass API, public instance, ODbL): the closest station,
// supermarket, pharmacy, park and playground, straight-line distance. Favourites only, cached forever per point,
// a few seconds between queries and at most NEARBY_MAX (20) per run; a 429/504 ends the run's lookups.

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const KINDS = [
  ['station', '🚇', 1200, ['[railway=station]', '[station=subway]']],
  ['supermarket', '🛒', 800, ['[shop=supermarket]']],
  ['pharmacy', '💊', 800, ['[amenity=pharmacy]']],
  ['park', '🌳', 800, ['[leisure=park]']],
  ['playground', '🛝', 800, ['[leisure=playground]']],
] as const;
export type Nearby = Partial<Record<(typeof KINDS)[number][0], { name: string | null; m: number }>>;

const dist = (a: Point, b: Point) => {
  const r = Math.PI / 180;
  const x = (b.lon - a.lon) * r * Math.cos(((a.lat + b.lat) / 2) * r);
  const y = (b.lat - a.lat) * r;
  return Math.round(Math.hypot(x, y) * 6_371_000);
};
const key = (p: Point) => `near:${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;

export function overpassQuery(p: Point): string {
  const parts = KINDS.flatMap(([, , radius, filters]) => filters.map((f) => `nwr(around:${radius},${p.lat},${p.lon})${f};`));
  return `[out:json][timeout:40];(${parts.join('')});out center tags;`;
}

/** Closest of each kind; a station counts only with a name (avoids freight sidings). */
export function nearestOf(p: Point, elements: { lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }[]): Nearby {
  const out: Nearby = {};
  for (const e of elements) {
    const at = e.center ?? (e.lat !== undefined && e.lon !== undefined ? { lat: e.lat, lon: e.lon } : null);
    if (!at) continue;
    const t = e.tags ?? {};
    const kind = t.railway === 'station' || t.station === 'subway' ? 'station' : t.shop === 'supermarket' ? 'supermarket'
      : t.amenity === 'pharmacy' ? 'pharmacy' : t.leisure === 'park' ? 'park' : t.leisure === 'playground' ? 'playground' : null;
    if (!kind || (kind === 'station' && !t.name)) continue;
    const m = dist(p, at);
    if (!out[kind] || m < out[kind]!.m) out[kind] = { name: t.name ?? null, m };
  }
  return out;
}

export function cachedNearby(store: Store, p: Point): Nearby | undefined {
  return store.kvGet<Nearby>(key(p));
}

/** Looks up the points not cached yet (favourites with known coordinates). */
export async function fillNearby(store: Store, points: Point[], max = Number(process.env.NEARBY_MAX ?? 20)): Promise<number> {
  let done = 0;
  for (const p of points) {
    if (done >= max) break;
    if (cachedNearby(store, p)) continue;
    if (done) await new Promise((r) => setTimeout(r, 5000));
    try {
      const res = await fetch(OVERPASS, {
        method: 'POST', body: 'data=' + encodeURIComponent(overpassQuery(p)),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': config.userAgent }, signal: AbortSignal.timeout(60000),
      });
      if (res.status === 429 || res.status === 504) { log.warn(`overpass: HTTP ${res.status}, the rest waits for the next run`); break; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      store.kvSet(key(p), nearestOf(p, ((await res.json()) as { elements?: [] }).elements ?? []));
      done++;
    } catch (e) {
      log.warn(`overpass: ${(e as Error).message}`);
      break;
    }
  }
  if (done) log.info(`nearby: ${done} favourite(s) looked up in OpenStreetMap`);
  return done;
}

const m = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(1).replace('.', ',')} км` : `${Math.round(x / 10) * 10} м`);

/** "🚇 Benfica 700 м · 🛒 Pingo Doce 150 м · 💊 210 м · 🌳 Parque Silva Porto 300 м · 🛝 120 м (по прямой)" */
export function nearbyLine(n: Nearby | undefined): string | null {
  if (!n) return null;
  const parts = KINDS.map(([k, icon]) => {
    const x = n[k];
    if (!x) return null;
    return `${icon} ${k === 'pharmacy' || k === 'playground' || !x.name ? '' : x.name + ' '}${m(x.m)}`;
  }).filter(Boolean);
  return parts.length ? `${parts.join(' · ')} (по прямой)` : 'рядом в OpenStreetMap ничего не нашлось';
}
