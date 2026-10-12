// Cloudflare Worker for the Telegram bot: answers 👍/👎 and "⭐ Избранное" instantly (Telegram webhook).
// The daily monitor on GitHub pulls the reactions from here and pushes a small catalogue of the flats it
// sent (title, link, price, message ids), so 👎 can delete the posts and ⭐ can list favourites.
// Free-tier friendly: one KV write per press, one per digest.

import { APP_HTML } from './app.ts';

export interface KV {
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string, opts?: { metadata?: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts: { prefix: string; cursor?: string }): Promise<{ keys: { name: string; metadata?: unknown }[]; list_complete: boolean; cursor?: string }>;
}
export interface Env { KV: KV; TELEGRAM_BOT_TOKEN: string; TELEGRAM_CHAT_ID: string; APP_URL?: string }

/**
 * One flat as pushed by the monitor (key 'catalogue', small: no photos): place, url, price, area, commute,
 * last seen, posts [chat, message], verdict, and n = the 'cards:<n>' chunk holding its swipe-card details.
 */
export interface CatalogueItem {
  t: string; u: string; p: number | null; a: number | null; c: number | null; s: string; m: [string, number][];
  k?: string; n?: number;
}
export type Catalogue = Record<string, CatalogueItem>;
/** Swipe-card details (keys 'cards:<n>', ~40 flats each): title, bedrooms, photos, facts, plus/minus, unknowns, route. */
export interface CardDetails { h?: string; b?: number | null; i?: string[]; f?: string; x?: string; w?: string[]; r?: string | null }
// Free plan: 10 ms CPU per request, so the deck never parses all photos at once, only the chunks it shows.
type Kind = 'like' | 'hide' | 'super';

const FAV_BUTTON = '⭐ Избранное';
const SUPER_BUTTON = '🌟 Суперлайки';
const replyKeyboard = { keyboard: [[{ text: FAV_BUTTON }, { text: SUPER_BUTTON }]], resize_keyboard: true, is_persistent: true };
const HELP = `Я присылаю квартиры три раза в день.\n👍 под квартирой: добавить в избранное, 👎: убрать квартиру из чата у обоих.\n🌟 под квартирой: суперлайк, отдельный список ${SUPER_BUTTON} (кнопка внизу или /super).\n${FAV_BUTTON} (кнопка внизу или /fav): список избранного.\n🏠 Свайпы (кнопка меню слева от поля ввода или /app): все квартиры карточками с фото, вправо нравится, вверх суперлайк, влево нет.`;

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const keyboard = (groupId: string, chosen?: Kind) => ({
  inline_keyboard: [[
    { text: chosen === 'like' ? '✅ Интересно' : '👍 Интересно', callback_data: `l|${groupId}`.slice(0, 64) },
    { text: chosen === 'super' ? '🌟 Супер!' : '🌟', callback_data: `s|${groupId}`.slice(0, 64) },
    { text: chosen === 'hide' ? '🚫 Скрыто' : '👎 Скрыть', callback_data: `h|${groupId}`.slice(0, 64) },
  ]],
});

/** Shared secrets derived from the bot token, so no extra secret has to be configured. */
export async function derivedSecret(token: string, purpose: 'webhook' | 'sync'): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${token}:hata-${purpose}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

const chatIds = (env: Env) => env.TELEGRAM_CHAT_ID.split(/[^-\w@]+/).filter((s) => /^(-?\d+|@\w+)$/.test(s));
// Reactions: one KV key per person and flat, the kind in its metadata, so a press costs one write and no
// delete (free plan: 1,000 writes and 1,000 deletes a day). Key: v:<chat>:<group id> (the id may contain ':').
// Older presses used r:<kind>:<chat>:<group id>; they are still read, and a v: key for the same pair wins.
const vKey = (chat: string, gid: string) => `v:${chat}:${gid}`;

async function listAll(kv: KV, prefix: string) {
  const keys: { name: string; metadata?: unknown }[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, cursor });
    keys.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}

export async function listReactions(kv: KV): Promise<{ kind: Kind; chat: string; gid: string; at: string }[]> {
  const byPair = new Map<string, { kind: Kind; chat: string; gid: string; at: string }>();
  for (const k of await listAll(kv, 'r:')) {
    const [, kind, chat, ...rest] = k.name.split(':');
    const gid = rest.join(':');
    byPair.set(`${chat}:${gid}`, { kind: kind as Kind, chat, gid, at: (k.metadata as { at?: string } | undefined)?.at ?? '' });
  }
  for (const k of await listAll(kv, 'v:')) {
    const [, chat, ...rest] = k.name.split(':');
    const meta = (k.metadata ?? {}) as { kind?: Kind; at?: string };
    const pair = `${chat}:${rest.join(':')}`;
    if (!meta.kind) byPair.delete(pair); // taken back (undo), also hides an older r: key
    else byPair.set(pair, { kind: meta.kind, chat, gid: rest.join(':'), at: meta.at ?? '' });
  }
  return [...byPair.values()];
}

export async function setReaction(kv: KV, kind: Kind | null, chat: string, gid: string) {
  // kind null = taken back: an empty marker (still one write) hides any older r: key for the pair.
  await kv.put(vKey(chat, gid), '1', { metadata: kind ? { kind, at: new Date().toISOString() } : {} });
}

/** 👍 (or 🌟) flats still on sale (seen by the monitor in the last 3 days), closest to school first. */
export function favouritesText(liked: Set<string>, cat: Catalogue, now = Date.now(), kind: 'like' | 'super' = 'like'): string {
  const [icon, title] = kind === 'super' ? ['🌟', 'Суперлайки'] : ['⭐', 'Избранное'];
  const items = [...liked].map((g) => cat[g]).filter((x): x is CatalogueItem => Boolean(x));
  const onSale = items.filter((x) => now - Date.parse(x.s) < 3 * 86400_000).sort((a, b) => (a.c ?? 99) - (b.c ?? 99));
  if (!onSale.length && !items.length) return `${icon} ${title}: пока пусто, нажимайте ${kind === 'super' ? '🌟' : '👍'} под квартирами или свайпайте в «🏠 Свайпы».`;
  const lines = onSale.map((x, i) => {
    const facts = [x.p ? `${Math.round(x.p / 1000)} тыс. €` : 'цена ?', x.a ? `${Math.round(x.a)} м²` : null,
      x.c !== null ? `🚗 ${Math.round(x.c)} мин` : null].filter(Boolean).join(' · ');
    return `${i + 1}. <a href="${esc(x.u)}">${esc(x.t)}</a> — ${esc(facts)}`;
  });
  const gone = items.length - onSale.length;
  return `${icon} <b>${title}</b>: ${onSale.length}\n${lines.join('\n')}${gone ? `\n\n(ещё ${gone} уже сняты с продажи)` : ''}`;
}

async function tg(env: Env, method: string, payload: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  return ((await res.json()) as { ok: boolean }).ok;
}

function chunks(text: string, max = 3800): string[] {
  const out: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > max) { out.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + line;
  }
  return cur ? [...out, cur] : out;
}

interface Update {
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: { id: number } } };
  message?: { text?: string; chat: { id: number } };
}

/**
 * Records 👍/👎 and updates the posts: 👍 marks the post(s) in this chat, 👎 deletes the flat's posts in every
 * recipient's chat (falls back to marking them hidden when Telegram refuses).
 */
export async function applyReaction(env: Env, kind: Kind, chat: string, gid: string, pressedMessageId?: number) {
  await setReaction(env.KV, kind, chat, gid);
  const cat = ((await env.KV.get('catalogue', 'json')) ?? {}) as Catalogue;
  const posts = new Map<string, [string, number]>();
  for (const [c, id] of cat[gid]?.m ?? []) if (kind === 'hide' || c === chat) posts.set(`${c}:${id}`, [c, id]);
  if (pressedMessageId) posts.set(`${chat}:${pressedMessageId}`, [chat, pressedMessageId]);
  for (const [c, id] of posts.values()) {
    if (kind !== 'hide' || !(await tg(env, 'deleteMessage', { chat_id: c, message_id: id }))) {
      await tg(env, 'editMessageReplyMarkup', { chat_id: c, message_id: id, reply_markup: keyboard(gid, kind) });
    }
  }
}

export async function handleUpdate(env: Env, u: Update): Promise<void> {
  const allowed = chatIds(env);
  const q = u.callback_query;
  if (q) {
    const m = q.data?.match(/^([lhs])\|(.+)$/);
    const chat = String(q.message?.chat.id ?? '');
    if (!m || !allowed.includes(chat)) { await tg(env, 'answerCallbackQuery', { callback_query_id: q.id }); return; }
    const kind: Kind = m[1] === 'l' ? 'like' : m[1] === 's' ? 'super' : 'hide';
    const gid = m[2];
    await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: kind === 'hide' ? 'Убрано' : kind === 'super' ? 'Суперлайк 🌟' : 'Добавлено в избранное ⭐' });
    await applyReaction(env, kind, chat, gid, q.message?.message_id);
    return;
  }
  const msg = u.message;
  if (!msg?.text || !allowed.includes(String(msg.chat.id))) return;
  const t = msg.text.trim().toLowerCase();
  if (/^\/app|свайп/.test(t)) {
    await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: '🏠 Квартиры карточками: вправо нравится, влево нет.',
      reply_markup: { inline_keyboard: [[{ text: '🏠 Открыть свайпы', web_app: { url: `${env.APP_URL ?? ''}/app` } }]] } });
    return;
  }
  let text = HELP;
  const list: 'like' | 'super' | null = /^\/super|супер|^🌟/.test(t) ? 'super' : /^\/fav|избранн|^⭐/.test(t) ? 'like' : null;
  if (list) {
    const ids = new Set((await listReactions(env.KV)).filter((r) => r.kind === list).map((r) => r.gid));
    text = favouritesText(ids, ((await env.KV.get('catalogue', 'json')) ?? {}) as Catalogue, Date.now(), list);
  }
  for (const part of chunks(text)) {
    await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: part, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: replyKeyboard });
  }
}

// ---------- Swipe app (Telegram Mini App) ----------

/** Checks Telegram's signature on the Mini App launch data; returns the user id, or null. */
export async function verifyInitData(initData: string, token: string, maxAgeSec = 7 * 86400, now = Date.now()): Promise<string | null> {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const hmac = async (key: ArrayBuffer, data: string) => {
    const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data));
  };
  const secret = await hmac(new TextEncoder().encode('WebAppData').buffer as ArrayBuffer, token);
  const sig = [...new Uint8Array(await hmac(secret, check))].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (sig !== hash) return null;
  if (now / 1000 - Number(params.get('auth_date') ?? 0) > maxAgeSec) return null;
  try { return String((JSON.parse(params.get('user') ?? '{}') as { id?: number }).id ?? '') || null; } catch { return null; }
}

export type Card = CatalogueItem & CardDetails & { id: string };

/**
 * The cards this user has not judged yet: on sale, not hidden by anyone, not already 👍/👎 by this user.
 * Matching flats first, then "check manually"; closest to school first.
 */
export function deck(cat: Catalogue, reactions: { kind: Kind; chat: string; gid: string }[], user: string, now = Date.now()): Card[] {
  const hidden = new Set(reactions.filter((r) => r.kind === 'hide').map((r) => r.gid));
  const mine = new Set(reactions.filter((r) => r.chat === user).map((r) => r.gid));
  const rank = (k?: string) => (k === 'manual' ? 1 : 0);
  return Object.entries(cat)
    .filter(([id, x]) => x.k !== 'reject' && !hidden.has(id) && !mine.has(id) && now - Date.parse(x.s) < 3 * 86400_000)
    .map(([id, x]) => ({ ...x, id, m: [] }))
    .sort((a, b) => rank(a.k) - rank(b.k) || (a.c ?? 99) - (b.c ?? 99));
}

async function appApi(req: Request, env: Env, path: string): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { initData?: string; exclude?: string[]; id?: string; kind?: Kind };
  const user = await verifyInitData(body.initData ?? '', env.TELEGRAM_BOT_TOKEN);
  if (!user || !chatIds(env).includes(user)) return json({ error: 'not allowed' }, 403);
  if (path === '/api/deck') {
    const cat = ((await env.KV.get('catalogue', 'json')) ?? {}) as Catalogue;
    const exclude = new Set(body.exclude ?? []);
    const all = deck(cat, await listReactions(env.KV), user).filter((c) => !exclude.has(c.id));
    const page = all.slice(0, 20);
    const chunks = new Map<number, Record<string, CardDetails>>();
    for (const n of new Set(page.map((c) => c.n).filter((n): n is number => n !== undefined))) {
      chunks.set(n, ((await env.KV.get(`cards:${n}`, 'json')) ?? {}) as Record<string, CardDetails>);
    }
    const cards = page.map((c) => ({ ...c, ...(c.n !== undefined ? chunks.get(c.n)?.[c.id] : undefined) }));
    return json({ total: all.length, cards });
  }
  if (!body.id) return json({ error: 'no id' }, 400);
  if (path === '/api/react' && (body.kind === 'like' || body.kind === 'hide' || body.kind === 'super')) {
    await applyReaction(env, body.kind, user, body.id);
    return json({ ok: true });
  }
  if (path === '/api/undo') {
    // Takes back this user's judgement (a deleted post stays deleted; the card comes back to the deck).
    await setReaction(env.KV, null, user, body.id);
    return json({ ok: true });
  }
  return json({ error: 'unknown' }, 404);
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === '/telegram' && req.method === 'POST') {
      if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== await derivedSecret(env.TELEGRAM_BOT_TOKEN, 'webhook')) return new Response('forbidden', { status: 403 });
      try { await handleUpdate(env, await req.json() as Update); } catch (e) { console.error(e); }
      return new Response('ok'); // always 200: Telegram would otherwise retry the same update
    }
    if (path === '/reactions' || path === '/sync') {
      if (req.headers.get('X-Hata-Key') !== await derivedSecret(env.TELEGRAM_BOT_TOKEN, 'sync')) return new Response('forbidden', { status: 403 });
      if (path === '/reactions') return json(await listReactions(env.KV));
      const body = await req.json() as { catalogue?: Catalogue; reactions?: { kind: Kind; chat: string; gid: string }[] };
      if (body.catalogue) await env.KV.put('catalogue', JSON.stringify(body.catalogue));
      // Reactions recorded before the worker existed: copy the missing ones (one write each).
      const have = new Set((await listReactions(env.KV)).map((r) => `${r.chat}:${r.gid}`));
      let added = 0;
      for (const r of body.reactions ?? []) {
        if (have.has(`${r.chat}:${r.gid}`)) continue;
        await setReaction(env.KV, r.kind, r.chat, r.gid);
        added++;
      }
      return json({ ok: true, added });
    }
    if (path === '/app') return new Response(APP_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    if (path.startsWith('/api/') && req.method === 'POST') return appApi(req, env, path);
    return new Response('hata bot');
  },
};
