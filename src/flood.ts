import { config } from './config.ts';
import type { Store } from './db.ts';
import { log } from './log.ts';
import type { Point } from './geo.ts';

// Flood maps from APA (Agência Portuguesa do Ambiente, Directive 2007/60/EC, 2nd cycle), favourites only:
// is the flat inside a mapped flood extent (and for which return period), or within 500 m of an area of
// potentially significant flood risk (ARPSI)? The maps cover ARPSI areas only, so "not in a map" is not proof
// of no risk. Cached per point, at most FLOOD_MAX (20) lookups per run.

const BASE = 'https://sniambgeoogc.apambiente.pt/getogc/rest/services/SNIAmb';
export interface Flood { periods: number[]; near: string[] }
const key = (p: Point) => `flood:${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;

async function query<T>(url: string): Promise<T[]> {
  const res = await fetch(url, { headers: { 'User-Agent': config.userAgent }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as { features?: { attributes: T }[]; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return (j.features ?? []).map((f) => f.attributes);
}

export async function floodAt(p: Point): Promise<Flood> {
  const pt = encodeURIComponent(JSON.stringify({ x: p.lon, y: p.lat, spatialReference: { wkid: 4326 } }));
  const common = `geometry=${pt}&geometryType=esriGeometryPoint&spatialRel=esriSpatialRelIntersects&returnGeometry=false&f=json`;
  const extent = await query<{ pretorno?: string | number }>(`${BASE}/Diretiva200760CE_2c/MapServer/1/query?${common}&outFields=pretorno`);
  const arpsi = await query<{ name?: string }>(`${BASE}/Risco_Inundacao_Potencialmente_Significativas/MapServer/0/query?${common}&distance=500&units=esriSRUnit_Meter&outFields=name`);
  return {
    periods: [...new Set(extent.map((a) => Number(String(a.pretorno ?? '').replace(/\D/g, ''))).filter((n) => n > 0))].sort((a, b) => a - b),
    near: [...new Set(arpsi.map((a) => a.name ?? '').filter(Boolean))],
  };
}

export const cachedFlood = (store: Store, p: Point) => store.kvGet<Flood>(key(p));

export async function fillFlood(store: Store, points: Point[], max = Number(process.env.FLOOD_MAX ?? 20)): Promise<number> {
  let done = 0;
  for (const p of points) {
    if (done >= max) break;
    if (cachedFlood(store, p)) continue;
    if (done) await new Promise((r) => setTimeout(r, 2000));
    try {
      store.kvSet(key(p), await floodAt(p));
      done++;
    } catch (e) {
      log.warn(`APA flood maps: ${(e as Error).message}`);
      break;
    }
  }
  if (done) log.info(`flood: ${done} favourite(s) checked against the APA flood maps`);
  return done;
}

const title = (s: string) => s.toLowerCase().replace(/(^|[\s(])\p{L}/gu, (c) => c.toUpperCase());

/** "🌊 в зоне затопления APA (паводок раз в 100 лет)" / "🌊 до 500 м зона риска подтопления: Loures E Parte De Odivelas (Trancão)" / null */
export function floodLine(f: Flood | undefined): string | null {
  if (!f) return null;
  if (f.periods.length) return `🌊 в зоне затопления APA (паводок раз в ${f.periods[0]} лет)`;
  if (f.near.length) return `🌊 до 500 м зона риска подтопления: ${f.near.map(title).join(', ')}`;
  return null;
}

/** For the spreadsheet: the line, or "нет на картах APA" when checked and clear. */
export const floodCell = (f: Flood | undefined) => (f ? floodLine(f) ?? 'нет на картах APA' : '');
