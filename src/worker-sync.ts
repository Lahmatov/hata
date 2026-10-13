import { createHash } from 'node:crypto';
import { config } from './config.ts';
import type { Reaction, Store } from './db.ts';
import type { Listing } from './types.ts';
import { log } from './log.ts';
import { classify } from './filter.ts';
import { routeUrl } from './extras.ts';
import { knownPoint } from './geo.ts';
import { ineLine, ineMedian, type InePrices } from './ine.ts';
import { cachedNearby, nearbyLine } from './nearby.ts';
import { cachedFlood, floodCell, floodLine } from './flood.ts';
import { factsLine, ruleBasedProsCons } from './summarize.ts';
import { score } from './score.ts';
import { costsLine } from './costs.ts';
import { tableRow } from './table.ts';
import { featuresFromText, featuresList } from './adapters/text.ts';
import type { CardDetails, Catalogue } from '../worker/index.ts';
import type { TableCell } from '../worker/xlsx.ts';

// Link to the Cloudflare Worker that answers the Telegram buttons (worker/index.ts). WORKER_URL is set by
// the workflows when Cloudflare is configured; without it the bot falls back to getUpdates polling.

const key = () => createHash('sha256').update(`${config.telegram.token}:hata-sync`).digest('hex').slice(0, 40);

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${process.env.WORKER_URL}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Hata-Key': key(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`worker ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const workerEnabled = () => Boolean(process.env.WORKER_URL && config.telegram.token);

/** Copies 👍/👎 presses recorded by the worker into the local database. */
export async function pullReactions(store: Store): Promise<number> {
  const rs = await call<{ kind: Reaction; chat: string; gid: string }[]>('/reactions');
  for (const r of rs) store.setReaction(r.gid, r.kind, r.chat);
  log.info(`worker: ${rs.length} reaction(s)`);
  return rs.length;
}

/**
 * Flats we have sent (one per duplicate group): a small index, swipe-card details in chunks of 40, and the
 * spreadsheet rows for /export (chunks of 40 too, same numbering, so the worker reads only what it needs).
 */
export function buildCatalogue(store: Store, now = Date.now()): { catalogue: Catalogue; cards: Record<string, CardDetails>[]; rows: Record<string, TableCell[]>[] } {
  const all = store.all();
  const leaders = new Map<string, Listing>();
  for (const l of all) {
    if (store.notifiedPrice(l.id) === null) continue;
    const cur = leaders.get(l.group_id);
    if (!cur || cur.last_seen <= l.last_seen) leaders.set(l.group_id, l);
  }
  const pool = all.filter((l) => now - Date.parse(l.last_seen) < 60 * 86400_000);
  const ine = store.kvGet<InePrices>('ine:prices');
  const school = config.school.lat !== null && config.school.lon !== null ? { lat: config.school.lat, lon: config.school.lon } : null;
  const catalogue: Catalogue = {};
  const cards: Record<string, CardDetails>[] = [];
  const rows: Record<string, TableCell[]>[] = [];
  for (const [gid, l] of leaders) {
    const n = Math.floor(Object.keys(catalogue).length / 40);
    const c = classify(l);
    const f = featuresFromText(l.description);
    const s = score(l, pool, f);
    catalogue[gid] = {
      t: [l.neighborhood, l.municipality].filter(Boolean).join(', ') || l.title, u: l.url, p: l.price, a: l.area_m2,
      c: l.commute_min, s: l.last_seen, m: store.messages(l.group_id).map((x) => [x.chatId, x.messageId]), k: c.verdict, n, q: s.total,
    };
    const pt = knownPoint(store, l);
    const near = pt && !pt.approx ? cachedNearby(store, pt.p) : undefined;
    const flood = pt && !pt.approx ? cachedFlood(store, pt.p) : undefined;
    if (pt) {
      catalogue[gid].g = [Math.round(pt.p.lat * 1e5) / 1e5, Math.round(pt.p.lon * 1e5) / 1e5];
      if (pt.approx) catalogue[gid].ga = 1;
    }
    (cards[n] ??= {})[gid] = {
      h: l.title, b: l.bedrooms, i: (l.images ?? (l.image ? [l.image] : [])).slice(0, 60),
      f: factsLine(l), x: ruleBasedProsCons(l), w: c.verdict === 'manual' ? c.reasons : [], r: routeUrl(l, school),
      y: s.text, e: featuresList(f), z: costsLine(l.price, l.description), v: ineLine(ine, l), o: nearbyLine(near), fz: floodLine(flood),
    };
    const members = all.filter((m) => m.group_id === gid && now - Date.parse(m.last_seen) < 7 * 86400_000);
    (rows[n] ??= {})[gid] = tableRow(l, c, s, { members, prices: store.priceHistory(l.id), school, now, ine: ineMedian(ine, l), near: nearbyLine(near), flood: floodCell(flood) });
  }
  return { catalogue, cards, rows };
}

/**
 * Writes the catalogue straight into the worker's KV through the Cloudflare API (no worker CPU spent on
 * megabytes of JSON), then lets the worker copy reactions recorded before it existed.
 */
export async function pushCatalogue(store: Store): Promise<void> {
  const reactions = (['like', 'hide', 'super'] as const).flatMap((kind) => store.reactionRows(kind).map((r) => ({ kind, ...r })));
  const { catalogue, cards, rows } = buildCatalogue(store);
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (token && account) {
    const api = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces`;
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const list = (await (await fetch(`${api}?per_page=100`, { headers: auth })).json()) as { result?: { id: string; title: string }[] };
    const ns = list.result?.find((x) => x.title === 'hata-bot')?.id;
    if (!ns) throw new Error('worker KV namespace "hata-bot" not found (deploy the bot worker first)');
    const pairs = [{ key: 'catalogue', value: JSON.stringify(catalogue) },
      ...cards.map((v, n) => ({ key: `cards:${n}`, value: JSON.stringify(v) })),
      ...rows.map((v, n) => ({ key: `rows:${n}`, value: JSON.stringify(v) }))];
    const res = await fetch(`${api}/${ns}/bulk`, { method: 'PUT', headers: auth, body: JSON.stringify(pairs) });
    if (!res.ok) throw new Error(`KV bulk write: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const r = await call<{ added: number }>('/sync', { reactions });
    log.info(`worker: ${Object.keys(catalogue).length} flat(s) in ${cards.length} card chunk(s) written, ${r.added} old reaction(s) copied`);
    return;
  }
  // Without Cloudflare API access: the small index only, through the worker (no photos for the swipe app).
  const r = await call<{ added: number }>('/sync', { catalogue, reactions });
  log.info(`worker: catalogue of ${Object.keys(catalogue).length} flat(s) pushed (no photos), ${r.added} old reaction(s) copied`);
}
