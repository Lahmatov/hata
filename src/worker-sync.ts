import { createHash } from 'node:crypto';
import { config } from './config.ts';
import type { Store } from './db.ts';
import { log } from './log.ts';
import type { Catalogue } from '../worker/index.ts';

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
  const rs = await call<{ kind: 'like' | 'hide'; chat: string; gid: string }[]>('/reactions');
  for (const r of rs) store.setReaction(r.gid, r.kind, r.chat);
  log.info(`worker: ${rs.length} reaction(s)`);
  return rs.length;
}

/** Flats we have sent (one per duplicate group), with their posts, for 👎 and ⭐ in the worker. */
export function buildCatalogue(store: Store): Catalogue {
  const cat: Catalogue = {};
  for (const l of store.all()) {
    if (store.notifiedPrice(l.id) === null) continue;
    const cur = cat[l.group_id];
    if (cur && cur.s > l.last_seen) continue;
    const place = [l.neighborhood, l.municipality].filter(Boolean).join(', ');
    cat[l.group_id] = {
      t: place || l.title, u: l.url, p: l.price, a: l.area_m2, c: l.commute_min, s: l.last_seen,
      m: store.messages(l.group_id).map((x) => [x.chatId, x.messageId]),
    };
  }
  return cat;
}

export async function pushCatalogue(store: Store): Promise<void> {
  const reactions = (['like', 'hide'] as const).flatMap((kind) => store.reactionRows(kind).map((r) => ({ kind, ...r })));
  const catalogue = buildCatalogue(store);
  const r = await call<{ added: number }>('/sync', { catalogue, reactions });
  log.info(`worker: catalogue of ${Object.keys(catalogue).length} flat(s) pushed, ${r.added} old reaction(s) copied`);
}
