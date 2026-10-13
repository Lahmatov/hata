import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { config } from './config.ts';
import type { Point } from './geo.ts';
import { log } from './log.ts';

// Low aircraft over Greater Lisbon from the OpenSky Network's public REST API (anonymous, ~400 requests a day;
// "The OpenSky Network, https://opensky-network.org"). A GitHub job samples the sky every 20 s for an hour once a
// day (morning or evening, alternating), and keeps aircraft below 1200 m; for each flat we count how often a track passed within 1 km below 1000 m.
// Both landing directions show up as the wind changes. Samples older than 14 days are dropped.

export const PLANES_FILE = `${config.dataDir}/planes.jsonl`;
const BBOX = { lamin: 38.62, lomin: -9.48, lamax: 38.92, lomax: -9.02 };
const KEEP_DAYS = 14;
const MAX_ALT = 1200;

/** One snapshot: unix time t, sampling interval e (s), aircraft [icao24, lat, lon, altitude m]. */
export interface Sample { t: number; e: number; a: [string, number, number, number][] }

type State = [string, string | null, string, number | null, number, number | null, number | null, number | null, boolean, ...unknown[]];

/** Low airborne aircraft from a /states/all response (altitude: geometric if known, else barometric). */
export function lowAircraft(states: State[] | null | undefined): Sample['a'] {
  const out: Sample['a'] = [];
  for (const s of states ?? []) {
    const [icao, , , , , lon, lat, baro, onGround] = s;
    const geo = s[13] as number | null;
    const alt = geo ?? baro;
    if (onGround || lat === null || lon === null || alt === null || alt > MAX_ALT) continue;
    out.push([icao, Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5, Math.round(alt)]);
  }
  return out;
}

export function loadSamples(file = PLANES_FILE, now = Date.now()): Sample[] {
  if (!existsSync(file)) return [];
  const since = now / 1000 - KEEP_DAYS * 86400;
  // A line cut short (a job killed mid-write) is skipped; collect() then rewrites the file without it.
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l) as Sample]; } catch { return []; }
  }).filter((s) => s.t >= since);
}

/** Samples the sky every `every` seconds for `minutes`; stops on 429/403 (rate limit or block). */
export async function collect(minutes: number, every: number, file = PLANES_FILE): Promise<number> {
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(file, loadSamples(file).map((s) => JSON.stringify(s) + '\n').join(''));
  const url = `https://opensky-network.org/api/states/all?${new URLSearchParams(Object.entries(BBOX).map(([k, v]) => [k, String(v)]))}`;
  const end = Date.now() + minutes * 60_000;
  let n = 0;
  while (Date.now() < end) {
    const started = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': config.userAgent }, signal: AbortSignal.timeout(15000) });
      if (res.status === 429 || res.status === 403) { log.warn(`opensky: HTTP ${res.status}, blocked or out of credits; stopping`); break; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { time: number; states: State[] | null };
      appendFileSync(file, JSON.stringify({ t: j.time, e: every, a: lowAircraft(j.states) } satisfies Sample) + '\n');
      n++;
    } catch (e) {
      log.warn(`opensky: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, Math.max(0, every * 1000 - (Date.now() - started))));
  }
  log.info(`opensky: ${n} sample(s) saved`);
  return n;
}

const toXY = (p: Point, o: Point) => [(p.lon - o.lon) * 111_320 * Math.cos((o.lat * Math.PI) / 180), (p.lat - o.lat) * 110_540];
/** Closest distance from o to the segment a-b (m) and where on it (0..1). */
function segDist(o: Point, a: Point, b: Point): { d: number; f: number } {
  const [ax, ay] = toXY(a, o);
  const [bx, by] = toXY(b, o);
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
  return { d: Math.hypot(ax + t * dx, ay + t * dy), f: t };
}

type Track = { t: number; p: Point; alt: number }[];
const built = new WeakMap<Sample[], { hours: number; tracks: Track[] }>();
/** Tracks per aircraft, time-ordered; built once per samples array (the catalogue asks for every flat). */
function tracksOf(samples: Sample[]) {
  let b = built.get(samples);
  if (!b) {
    const byIcao = new Map<string, Track>();
    for (const s of samples) for (const [icao, lat, lon, alt] of s.a) (byIcao.get(icao) ?? byIcao.set(icao, []).get(icao)!).push({ t: s.t, p: { lat, lon }, alt });
    const tracks = [...byIcao.values()].map((t) => t.sort((x, y) => x.t - y.t));
    built.set(samples, (b = { hours: samples.reduce((n, x) => n + x.e, 0) / 3600, tracks }));
  }
  return b;
}

export interface PlaneStats { passes: number; hours: number; lowest: number | null }

/**
 * Passes within `radius` m below `below` m: tracks are joined between samples up to 90 s apart (so a plane
 * between two snapshots still counts), and one aircraft counts once per 10 minutes.
 */
export function planeStats(samples: Sample[], p: Point, radius = 1000, below = 1000): PlaneStats {
  const { hours, tracks } = tracksOf(samples);
  let passes = 0;
  let lowest: number | null = null;
  for (const pts of tracks) {
    let lastPass = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = i + 1 < pts.length && pts[i + 1].t - a.t <= 90 ? pts[i + 1] : a;
      const { d, f } = segDist(p, a.p, b.p);
      const alt = Math.round(a.alt + f * (b.alt - a.alt)); // altitude at the closest point
      if (d > radius || alt > below) continue;
      if (a.t - lastPass > 600) passes++;
      lastPass = a.t;
      lowest = Math.min(lowest ?? Infinity, alt);
    }
  }
  return { passes, hours, lowest };
}

/** "✈️ ≈ 4,5 низких пролёта в час (ниже 1 км, до 1 км от дома; 12 ч наблюдений OpenSky)"; null under 3 hours. */
export function planesLine(s: PlaneStats | null): string | null {
  if (!s || s.hours < 3) return null;
  const h = Math.round(s.hours);
  if (!s.passes) return `✈️ низких пролётов рядом не было (${h} ч наблюдений OpenSky)`;
  const rate = String(Math.round((s.passes / s.hours) * 10) / 10).replace('.', ',');
  return `✈️ ≈ ${rate} низких пролёта в час, самый низкий ~${s.lowest} м (до 1 км от дома; ${h} ч наблюдений OpenSky)`;
}

// CLI: npx tsx src/planes.ts --collect=60 --every=20
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k: string, d: number) => Number(process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d);
  await collect(arg('collect', 60), arg('every', 20));
}
