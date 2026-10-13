// Cloudflare Worker for the Telegram bot: answers 👍/👎 and "⭐ Избранное" instantly (Telegram webhook).
// The daily monitor on GitHub pulls the reactions from here and pushes a small catalogue of the flats it
// sent (title, link, price, message ids), so 👎 can delete the posts and ⭐ can list favourites.
// Free-tier friendly: one KV write per press, one per digest.

import { APP_HTML } from './app.ts';
import { TABLE_COLS } from './table.ts';
import { xlsx, type TableCell, type TableCol } from './xlsx.ts';

export interface KV {
  get(key: string, type: 'json'): Promise<unknown>;
  getWithMetadata(key: string): Promise<{ value: string | null; metadata: unknown }>;
  put(key: string, value: string, opts?: { metadata?: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts: { prefix: string; cursor?: string }): Promise<{ keys: { name: string; metadata?: unknown }[]; list_complete: boolean; cursor?: string }>;
}
export interface Env { KV: KV; TELEGRAM_BOT_TOKEN: string; TELEGRAM_CHAT_ID: string; APP_URL?: string }

/**
 * One flat as pushed by the monitor (key 'catalogue', small: no photos): place, url, price, area, commute,
 * last seen, posts [chat, message], verdict, n = the 'cards:<n>' / 'rows:<n>' chunk holding its swipe-card
 * details and spreadsheet row, q = rating 0-100 (src/score.ts).
 */
export interface CatalogueItem {
  t: string; u: string; p: number | null; a: number | null; c: number | null; s: string; m: [string, number][];
  k?: string; n?: number; q?: number;
  /** Coordinates for the map: [lat, lon]; ga = 1 when only the neighbourhood is known. */
  g?: [number, number]; ga?: 1;
}
export type Catalogue = Record<string, CatalogueItem>;
/**
 * Swipe-card details (keys 'cards:<n>', ~40 flats each): title, bedrooms, photos, facts, plus/minus, unknowns,
 * route, rating breakdown, extras found in the ad text.
 */
export interface CardDetails { h?: string; b?: number | null; i?: string[]; f?: string; x?: string; w?: string[]; r?: string | null; y?: string; e?: string[]; z?: string | null; v?: string | null; o?: string | null; fz?: string | null; pl?: string | null }
// Free plan: 10 ms CPU per request, so the deck never parses all photos at once, only the chunks it shows.
type Kind = 'like' | 'hide' | 'super';

const FAV_BUTTON = '⭐ Избранное';
const SUPER_BUTTON = '🌟 Суперлайки';
const TABLE_BUTTON = '📊 Таблица';
const replyKeyboard = { keyboard: [[{ text: FAV_BUTTON }, { text: SUPER_BUTTON }, { text: TABLE_BUTTON }]], resize_keyboard: true, is_persistent: true };
const HELP = `Я присылаю квартиры три раза в день.\n👍 под квартирой: добавить в избранное, 👎: убрать квартиру из чата у обоих.\n🌟 под квартирой: суперлайк, отдельный список ${SUPER_BUTTON} (кнопка внизу или /super).\n${FAV_BUTTON} (кнопка внизу или /fav): список избранного.\n🏠 Свайпы (кнопка меню слева от поля ввода или /app): все квартиры карточками с фото, вправо нравится, вверх суперлайк, влево нет. Вкладки «⭐ Избранное» (второй раунд по лайкам, общие статусы и заметки, просмотр в календарь) и «🏆 Рейтинг» (по баллам, карта, сравнение 2–4 квартир).
💞 Когда квартира нравится обоим, бот пишет обоим. По избранному приходят новости: подешевела, снята, снова в продаже.
${TABLE_BUTTON} (кнопка внизу или /export): всё избранное обоих в таблице Excel со всеми параметрами и рейтингом.`;

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

export async function setReaction(kv: KV, kind: Kind | null, chat: string, gid: string, retryMs = 1100) {
  // kind null = taken back: an empty marker (still one write) hides any older r: key for the pair.
  const metadata = kind ? { kind, at: new Date().toISOString() } : {};
  // KV allows one write per key per second: a swipe followed by a quick undo can get a 429, so wait and retry.
  for (let attempt = 0; ; attempt++) {
    try {
      return await kv.put(vKey(chat, gid), '1', { metadata });
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, retryMs));
    }
  }
}

/** One person's current reaction to a flat (v: key, else an older r: key); undefined when none or taken back. */
export async function reactionOf(kv: KV, chat: string, gid: string): Promise<Kind | undefined> {
  const v = await kv.getWithMetadata(vKey(chat, gid));
  if (v.value !== null) return (v.metadata as { kind?: Kind } | null)?.kind;
  for (const k of ['super', 'like', 'hide'] as const) if ((await kv.getWithMetadata(`r:${k}:${chat}:${gid}`)).value !== null) return k;
  return undefined;
}

/** 💞 message when both of you like the same flat. */
export function matchText(x: CatalogueItem | undefined, superLike: boolean): string {
  if (!x) return '💞 Совпадение! Вам обоим понравилась квартира. Она в «⭐ Избранное».';
  const facts = [x.p ? `${Math.round(x.p / 1000)} тыс. €` : null, x.a ? `${Math.round(x.a)} м²` : null,
    x.c !== null ? `🚗 ${Math.round(x.c)} мин` : null, x.q !== undefined ? `🏆 ${x.q}` : null].filter(Boolean).join(' · ');
  return `💞 <b>Совпадение!</b>${superLike ? ' 🌟' : ''} Вам обоим нравится:\n<a href="${esc(x.u)}">${esc(x.t)}</a>\n${esc(facts)}\n\nЗвоним? Статус, заметку и время просмотра можно поставить в «🏠 Свайпы» → «⭐ Избранное».`;
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

/** First names of the recipients (Telegram getChat), for "who liked it"; falls back to the chat id. */
async function names(env: Env): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(chatIds(env).map(async (id) => {
    try {
      const r = (await (await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getChat?chat_id=${encodeURIComponent(id)}`)).json()) as { result?: { first_name?: string; title?: string } };
      out[id] = r.result?.first_name ?? r.result?.title ?? id;
    } catch { out[id] = id; }
  }));
  return out;
}

// ---------- Shared status and note per flat (both people see and edit the same one) ----------

export const STATUSES = { call: '📞 позвонить', called: '☎️ позвонили', viewing: '📅 просмотр', seen: '👀 посмотрели', offer: '🤝 предложение', no: '✖️ отказ' } as const;
export type Status = keyof typeof STATUSES;
/** s status, t note (≤ 300 chars, kept in the key's metadata: one list call reads all), d viewing 'YYYY-MM-DDTHH:mm', by who, at when. */
export interface Note { s?: Status; t?: string; d?: string; by?: string; at?: string }

export async function listNotes(kv: KV): Promise<Record<string, Note>> {
  const out: Record<string, Note> = {};
  for (const k of await listAll(kv, 'n:')) out[k.name.slice(2)] = (k.metadata ?? {}) as Note;
  return out;
}

export async function saveNote(kv: KV, gid: string, n: { s?: unknown; t?: unknown; d?: unknown }, by: string): Promise<Note> {
  const note: Note = { by, at: new Date().toISOString() };
  if (typeof n.s === 'string' && n.s in STATUSES) note.s = n.s as Status;
  if (typeof n.t === 'string' && n.t.trim()) note.t = n.t.trim().slice(0, 300);
  if (typeof n.d === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(n.d)) note.d = n.d;
  await kv.put(`n:${gid}`, '1', { metadata: note });
  return note;
}

const KIND_RU: Record<Kind, string> = { super: '🌟 супер', like: '👍 да', hide: '👎 нет' };

/**
 * The favourites spreadsheet: every flat on sale that someone 👍/🌟, best rating first, with each person's
 * verdict in front of the monitor's columns (worker/table.ts).
 */
export async function favouritesTable(kv: KV, people: Record<string, string>, now = Date.now()): Promise<{ cols: TableCol[]; rows: TableCell[][] }> {
  const cat = ((await kv.get('catalogue', 'json')) ?? {}) as Catalogue;
  const reactions = await listReactions(kv);
  const liked = new Set(reactions.filter((r) => r.kind !== 'hide').map((r) => r.gid));
  const items = [...liked].map((id) => ({ id, x: cat[id] }))
    .filter((it): it is { id: string; x: CatalogueItem } => Boolean(it.x) && now - Date.parse(it.x.s) < 3 * 86400_000)
    .sort((a, b) => (b.x.q ?? 0) - (a.x.q ?? 0) || (a.x.c ?? 99) - (b.x.c ?? 99));
  const chunks = new Map<number, Record<string, TableCell[]>>();
  for (const n of new Set(items.map((it) => it.x.n).filter((n): n is number => n !== undefined))) {
    chunks.set(n, ((await kv.get(`rows:${n}`, 'json')) ?? {}) as Record<string, TableCell[]>);
  }
  const who = Object.keys(people);
  const cols: TableCol[] = [{ h: '№', w: 4, f: 'int' }, ...who.map((id) => ({ h: people[id], w: 9 })), ...TABLE_COLS];
  const notes = await listNotes(kv);
  const at = (h: string) => TABLE_COLS.findIndex((c) => c.h === h);
  const rows = items.map((it, i) => {
    const mine = (id: string) => reactions.find((r) => r.gid === it.id && r.chat === id)?.kind;
    const row = [...((it.x.n !== undefined ? chunks.get(it.x.n)?.[it.id] : undefined) ?? basicRow(it.x))];
    const n = notes[it.id];
    if (n?.s) row[at('Статус')] = STATUSES[n.s];
    if (n?.d) row[at('Просмотр (дата)')] = n.d.replace('T', ' ');
    if (n?.t) row[at('Заметки')] = n.t;
    return [i + 1, ...who.map((id) => { const k = mine(id); return k ? KIND_RU[k] : '—'; }), ...row];
  });
  return { cols, rows };
}

/** Flats pushed before the spreadsheet existed: the basics from the catalogue. */
function basicRow(x: CatalogueItem): TableCell[] {
  const v: Record<string, TableCell> = {
    'Баллы из 100': x.q ?? null, Район: x.t, Цена: x.p, 'Площадь, м²': x.a, 'До школы, мин': x.c === null ? null : Math.round(x.c),
    Объявление: { u: x.u, t: 'открыть' },
  };
  return TABLE_COLS.map((c) => v[c.h] ?? null);
}

/** Sends the favourites spreadsheet to one chat as an .xlsx document. */
export async function sendTable(env: Env, chat: string): Promise<number> {
  const { cols, rows } = await favouritesTable(env.KV, await names(env));
  if (!rows.length) {
    await tg(env, 'sendMessage', { chat_id: chat, text: '📊 В избранном пока пусто: лайкайте квартиры 👍 / 🌟 или свайпайте вправо.', reply_markup: replyKeyboard });
    return 0;
  }
  const day = new Date().toISOString().slice(0, 10);
  const form = new FormData();
  form.append('chat_id', chat);
  form.append('caption', `📊 Избранное: ${rows.length} кв., лучшие по баллам сверху. Колонки «Позвонили», «Просмотр», «Впечатление» и «Заметки» для вас.`);
  form.append('document', new Blob([xlsx('Избранное', cols, rows)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `hata-izbrannoe-${day}.xlsx`);
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`sendDocument: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return rows.length;
}

interface Update {
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: { id: number } } };
  message?: { text?: string; chat: { id: number } };
}

/**
 * Records 👍/👎 and updates the posts: 👍 marks the post(s) in this chat, 👎 deletes the flat's posts in every
 * recipient's chat (falls back to marking them hidden when Telegram refuses). mineOnly: 👎 in the favourites
 * round, where the other person may still like the flat, so only this chat's post goes.
 */
export async function applyReaction(env: Env, kind: Kind, chat: string, gid: string, pressedMessageId?: number, mineOnly = false) {
  const liking = kind !== 'hide';
  const before = liking ? await reactionOf(env.KV, chat, gid) : undefined;
  await setReaction(env.KV, kind, chat, gid);
  const cat = ((await env.KV.get('catalogue', 'json')) ?? {}) as Catalogue;
  // 💞 This press makes a flat liked by both of you: tell both chats.
  if (liking && before !== 'like' && before !== 'super') {
    const partners = chatIds(env).filter((c) => c !== chat);
    for (const p of partners) {
      const theirs = await reactionOf(env.KV, p, gid);
      if (theirs === 'like' || theirs === 'super') {
        const text = matchText(cat[gid], kind === 'super' || theirs === 'super');
        for (const c of [chat, p]) await tg(env, 'sendMessage', { chat_id: c, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: replyKeyboard });
        break;
      }
    }
  }
  const posts = new Map<string, [string, number]>();
  for (const [c, id] of cat[gid]?.m ?? []) if ((kind === 'hide' && !mineOnly) || c === chat) posts.set(`${c}:${id}`, [c, id]);
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
  if (/^\/export|таблиц|^📊/.test(t)) {
    try {
      await sendTable(env, String(msg.chat.id));
    } catch (e) {
      console.error(e);
      await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: '📊 Не получилось собрать таблицу, попробуйте ещё раз через минуту.', reply_markup: replyKeyboard });
    }
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

/** me / ot: this user's and the other person's reaction (favourites mode). */
export type Card = CatalogueItem & CardDetails & { id: string; me?: Kind; ot?: Kind; nt?: Note };

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

/**
 * Favourites (second round): flats on sale that either of you 👍/🌟 and this user has not 👎, best rating
 * first. Each card says who liked it, so the other person's picks get a second look too.
 */
export function favDeck(cat: Catalogue, reactions: { kind: Kind; chat: string; gid: string }[], user: string, now = Date.now()): Card[] {
  const byGid = new Map<string, { me?: Kind; ot?: Kind }>();
  const rank = { super: 2, like: 1, hide: 0 };
  for (const r of reactions) {
    const v = byGid.get(r.gid) ?? {};
    if (r.chat === user) v.me = r.kind;
    else if (!v.ot || rank[r.kind] > rank[v.ot]) v.ot = r.kind;
    byGid.set(r.gid, v);
  }
  return [...byGid]
    .filter(([id, v]) => cat[id] && v.me !== 'hide' && (v.me || v.ot !== 'hide') && now - Date.parse(cat[id].s) < 3 * 86400_000)
    .map(([id, v]) => ({ ...cat[id], id, m: [], me: v.me, ot: v.ot }))
    .sort((a, b) => (b.q ?? 0) - (a.q ?? 0) || (a.c ?? 99) - (b.c ?? 99));
}

async function appApi(req: Request, env: Env, path: string): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { initData?: string; exclude?: string[]; id?: string; kind?: Kind; mode?: 'all' | 'fav'; first?: string; slim?: boolean; mine?: boolean;
    ids?: string[]; note?: { s?: unknown; t?: unknown; d?: unknown } };
  const user = await verifyInitData(body.initData ?? '', env.TELEGRAM_BOT_TOKEN);
  if (!user || !chatIds(env).includes(user)) return json({ error: 'not allowed' }, 403);
  if (path === '/api/deck') {
    const cat = ((await env.KV.get('catalogue', 'json')) ?? {}) as Catalogue;
    const exclude = new Set(body.exclude ?? []);
    const fav = body.mode === 'fav';
    const all = (fav ? favDeck : deck)(cat, await listReactions(env.KV), user).filter((c) => !exclude.has(c.id));
    const notes = fav ? await listNotes(env.KV) : {};
    for (const c of all) if (notes[c.id]) c.nt = notes[c.id];
    if (fav && body.slim) return json({ total: all.length, cards: all, names: await names(env) });
    const at = body.first ? all.findIndex((c) => c.id === body.first) : -1;
    if (at > 0) all.unshift(...all.splice(at, 1));
    const page = all.slice(0, 20);
    const chunks = new Map<number, Record<string, CardDetails>>();
    for (const n of new Set(page.map((c) => c.n).filter((n): n is number => n !== undefined))) {
      chunks.set(n, ((await env.KV.get(`cards:${n}`, 'json')) ?? {}) as Record<string, CardDetails>);
    }
    const cards = page.map((c) => ({ ...c, ...(c.n !== undefined ? chunks.get(c.n)?.[c.id] : undefined) }));
    return json({ total: all.length, cards, names: fav ? await names(env) : undefined });
  }
  if (path === '/api/export') return json({ ok: true, rows: await sendTable(env, user) });
  if (path === '/api/cards') {
    // Up to 4 flats with all details (comparison view).
    const cat = ((await env.KV.get('catalogue', 'json')) ?? {}) as Catalogue;
    const ids = (body.ids ?? []).filter((id) => cat[id]).slice(0, 4);
    const chunks = new Map<number, Record<string, CardDetails>>();
    for (const n of new Set(ids.map((id) => cat[id].n).filter((n): n is number => n !== undefined))) {
      chunks.set(n, ((await env.KV.get(`cards:${n}`, 'json')) ?? {}) as Record<string, CardDetails>);
    }
    const notes = await listNotes(env.KV);
    return json({ cards: ids.map((id) => ({ ...cat[id], id, m: [], ...(cat[id].n !== undefined ? chunks.get(cat[id].n!)?.[id] : undefined), nt: notes[id] })) });
  }
  if (path === '/api/note' && body.id) return json({ ok: true, note: await saveNote(env.KV, body.id, body.note ?? {}, user) });
  if (!body.id) return json({ error: 'no id' }, 400);
  if (path === '/api/react' && (body.kind === 'like' || body.kind === 'hide' || body.kind === 'super')) {
    await applyReaction(env, body.kind, user, body.id, undefined, body.mine === true);
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
