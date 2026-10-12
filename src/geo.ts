import { config } from './config.ts';
import type { Store } from './db.ts';
import { log } from './log.ts';
import type { Listing } from './types.ts';

export interface Point { lat: number; lon: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastNominatim = 0;
let lastOsrm = 0;

/** JSON API call with retries/backoff (APIs, not scraped pages: robots.txt does not apply). */
async function api<T>(url: string, init: RequestInit = {}, attempts = 3): Promise<T> {
  let err: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000), headers: { 'User-Agent': config.userAgent, ...(init.headers ?? {}) } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`), { fatal: true });
      return (await res.json()) as T;
    } catch (e) {
      err = e;
      if ((e as { fatal?: boolean }).fatal) break;
      await sleep(1500 * 2 ** i);
    }
  }
  throw err;
}

/** Nominatim (OSM) geocoding, ≤1 req/s per its usage policy, cached forever. */
export async function geocode(store: Store, query: string): Promise<Point | null> {
  const key = `geo:${query.toLowerCase()}`;
  const cached = store.kvGet<Point | null>(key);
  if (cached !== undefined) return cached;
  const wait = lastNominatim + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastNominatim = Date.now();
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=pt&q=${encodeURIComponent(query)}`;
  try {
    const r = await api<{ lat: string; lon: string }[]>(url);
    const p = r[0] ? { lat: Number(r[0].lat), lon: Number(r[0].lon) } : null;
    store.kvSet(key, p);
    return p;
  } catch (e) {
    log.warn(`geocode failed for "${query}": ${(e as Error).message}`);
    return null;
  }
}

export async function schoolPoint(store: Store): Promise<Point | null> {
  if (config.school.lat !== null && config.school.lon !== null) return { lat: config.school.lat, lon: config.school.lon };
  for (const q of [config.school.address, 'Estrada de Alfragide, Amadora', 'PaRK International School Alfragide']) {
    const p = await geocode(store, q);
    if (p) return p;
  }
  return null;
}

/** Next weekday 08:15 Europe/Lisbon as RFC3339 (Lisbon is UTC+0 in winter, UTC+1 in summer). */
export function nextMorningDeparture(now = new Date()): string {
  const d = new Date(now);
  do d.setUTCDate(d.getUTCDate() + 1); while ([0, 6].includes(d.getUTCDay()));
  const lisbonOffsetH = Number(new Intl.DateTimeFormat('en', { timeZone: 'Europe/Lisbon', timeZoneName: 'shortOffset' })
    .formatToParts(d).find((p) => p.type === 'timeZoneName')?.value.replace('GMT', '') || 0);
  d.setUTCHours(8 - lisbonOffsetH, 15, 0, 0);
  return d.toISOString();
}

/** Morning drive time in minutes. Google Routes (traffic-aware) if a key is set, else OSRM × traffic factor. */
export async function driveMinutes(store: Store, from: Point, to: Point): Promise<number | null> {
  const r5 = (n: number) => n.toFixed(5);
  const key = `route:${config.googleMapsKey ? 'g' : 'o'}:${r5(from.lat)},${r5(from.lon)}>${r5(to.lat)},${r5(to.lon)}`;
  const cached = store.kvGet<number | null>(key, 24 * 30);
  if (cached !== undefined) return cached;
  let min: number | null = null;
  try {
    if (config.googleMapsKey) {
      const body = {
        origin: { location: { latLng: { latitude: from.lat, longitude: from.lon } } },
        destination: { location: { latLng: { latitude: to.lat, longitude: to.lon } } },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE_OPTIMAL',
        departureTime: nextMorningDeparture(),
      };
      const r = await api<{ routes?: { duration: string }[] }>('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': config.googleMapsKey, 'X-Goog-FieldMask': 'routes.duration' },
        body: JSON.stringify(body),
      });
      const s = r.routes?.[0]?.duration;
      min = s ? Number.parseInt(s, 10) / 60 : null;
    } else {
      const wait = lastOsrm + 1100 - Date.now(); // public OSRM demo server: ≤ 1 req/s
      if (wait > 0) await sleep(wait);
      lastOsrm = Date.now();
      const r = await api<{ routes?: { duration: number }[] }>(
        `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`,
      );
      const s = r.routes?.[0]?.duration;
      min = s ? (s / 60) * config.morningTrafficFactor : null;
    }
  } catch (e) {
    log.warn(`routing failed: ${(e as Error).message}`);
    return null; // not cached: retry next run
  }
  store.kvSet(key, min);
  return min;
}

/** Listing location: exact coords if the source gives them, else geocoded parish/municipality (approximate). */
export async function listingPoint(store: Store, l: Listing): Promise<{ p: Point | null; approx: boolean }> {
  if (l.lat !== null && l.lon !== null) return { p: { lat: l.lat, lon: l.lon }, approx: !l.address };
  if (l.address) {
    const p = await geocode(store, [l.address, l.municipality, 'Portugal'].filter(Boolean).join(', '));
    if (p) return { p, approx: false };
  }
  const q = [l.neighborhood, l.municipality, 'Portugal'].filter(Boolean).join(', ');
  return { p: q.length > 'Portugal'.length + 2 ? await geocode(store, q) : null, approx: true };
}
