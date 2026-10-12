// Cloudflare Worker for the Telegram bot: answers 👍/👎 and "⭐ Избранное" instantly (Telegram webhook).
// The daily monitor on GitHub pulls the reactions from here and pushes a small catalogue of the flats it
// sent (title, link, price, message ids), so 👎 can delete the posts and ⭐ can list favourites.
// Free-tier friendly: one KV write per press, one per digest.

export interface KV {
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string, opts?: { metadata?: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts: { prefix: string; cursor?: string }): Promise<{ keys: { name: string; metadata?: unknown }[]; list_complete: boolean; cursor?: string }>;
}
export interface Env { KV: KV; TELEGRAM_BOT_TOKEN: string; TELEGRAM_CHAT_ID: string }

/** One flat as pushed by the monitor: title, url, price, area, commute, last seen, posts [chat, message]. */
export interface CatalogueItem { t: string; u: string; p: number | null; a: number | null; c: number | null; s: string; m: [string, number][] }
export type Catalogue = Record<string, CatalogueItem>;
type Kind = 'like' | 'hide';

const FAV_BUTTON = '⭐ Избранное';
const replyKeyboard = { keyboard: [[{ text: FAV_BUTTON }]], resize_keyboard: true, is_persistent: true };
const HELP = `Я присылаю квартиры три раза в день.\n👍 под квартирой: добавить в избранное, 👎: убрать квартиру из чата у обоих.\n${FAV_BUTTON} (кнопка внизу или /fav): список избранного.`;

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const keyboard = (groupId: string, chosen?: Kind) => ({
  inline_keyboard: [[
    { text: chosen === 'like' ? '✅ Интересно' : '👍 Интересно', callback_data: `l|${groupId}`.slice(0, 64) },
    { text: chosen === 'hide' ? '🚫 Скрыто' : '👎 Скрыть', callback_data: `h|${groupId}`.slice(0, 64) },
  ]],
});

/** Shared secrets derived from the bot token, so no extra secret has to be configured. */
export async function derivedSecret(token: string, purpose: 'webhook' | 'sync'): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${token}:hata-${purpose}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

const chatIds = (env: Env) => env.TELEGRAM_CHAT_ID.split(/[^-\w@]+/).filter((s) => /^(-?\d+|@\w+)$/.test(s));
// Reaction keys: r:<kind>:<chat>:<group id> (the group id may itself contain ':').
const rKey = (kind: Kind, chat: string, gid: string) => `r:${kind}:${chat}:${gid}`;

export async function listReactions(kv: KV): Promise<{ kind: Kind; chat: string; gid: string; at: string }[]> {
  const out: { kind: Kind; chat: string; gid: string; at: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: 'r:', cursor });
    for (const k of page.keys) {
      const [, kind, chat, ...rest] = k.name.split(':');
      out.push({ kind: kind as Kind, chat, gid: rest.join(':'), at: (k.metadata as { at?: string } | undefined)?.at ?? '' });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

export async function setReaction(kv: KV, kind: Kind, chat: string, gid: string) {
  await kv.put(rKey(kind, chat, gid), '1', { metadata: { at: new Date().toISOString() } });
  await kv.delete(rKey(kind === 'like' ? 'hide' : 'like', chat, gid));
}

/** 👍 flats still on sale (seen by the monitor in the last 3 days), closest to school first. */
export function favouritesText(liked: Set<string>, cat: Catalogue, now = Date.now()): string {
  const items = [...liked].map((g) => cat[g]).filter((x): x is CatalogueItem => Boolean(x));
  const onSale = items.filter((x) => now - Date.parse(x.s) < 3 * 86400_000).sort((a, b) => (a.c ?? 99) - (b.c ?? 99));
  if (!onSale.length && !items.length) return '⭐ Избранное пока пусто: нажимайте 👍 под квартирами.';
  const lines = onSale.map((x, i) => {
    const facts = [x.p ? `${Math.round(x.p / 1000)} тыс. €` : 'цена ?', x.a ? `${Math.round(x.a)} м²` : null,
      x.c !== null ? `🚗 ${Math.round(x.c)} мин` : null].filter(Boolean).join(' · ');
    return `${i + 1}. <a href="${esc(x.u)}">${esc(x.t)}</a> — ${esc(facts)}`;
  });
  const gone = items.length - onSale.length;
  return `⭐ <b>Избранное</b>: ${onSale.length}\n${lines.join('\n')}${gone ? `\n\n(ещё ${gone} уже сняты с продажи)` : ''}`;
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

export async function handleUpdate(env: Env, u: Update): Promise<void> {
  const allowed = chatIds(env);
  const q = u.callback_query;
  if (q) {
    const m = q.data?.match(/^([lh])\|(.+)$/);
    const chat = String(q.message?.chat.id ?? '');
    if (!m || !allowed.includes(chat)) { await tg(env, 'answerCallbackQuery', { callback_query_id: q.id }); return; }
    const kind: Kind = m[1] === 'l' ? 'like' : 'hide';
    const gid = m[2];
    await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: kind === 'like' ? 'Добавлено в избранное ⭐' : 'Убрано' });
    await setReaction(env.KV, kind, chat, gid);
    if (kind === 'like') {
      if (q.message) await tg(env, 'editMessageReplyMarkup', { chat_id: chat, message_id: q.message.message_id, reply_markup: keyboard(gid, 'like') });
      return;
    }
    // 👎: delete the flat's posts in every recipient's chat (fall back to marking them hidden).
    const cat = ((await env.KV.get('catalogue', 'json')) ?? {}) as Catalogue;
    const posts = new Map<string, [string, number]>();
    for (const [c, id] of cat[gid]?.m ?? []) posts.set(`${c}:${id}`, [c, id]);
    if (q.message) posts.set(`${chat}:${q.message.message_id}`, [chat, q.message.message_id]);
    for (const [c, id] of posts.values()) {
      if (!(await tg(env, 'deleteMessage', { chat_id: c, message_id: id }))) {
        await tg(env, 'editMessageReplyMarkup', { chat_id: c, message_id: id, reply_markup: keyboard(gid, 'hide') });
      }
    }
    return;
  }
  const msg = u.message;
  if (!msg?.text || !allowed.includes(String(msg.chat.id))) return;
  const t = msg.text.trim().toLowerCase();
  let text = HELP;
  if (/^\/fav|избранн|^⭐/.test(t)) {
    const liked = new Set((await listReactions(env.KV)).filter((r) => r.kind === 'like').map((r) => r.gid));
    text = favouritesText(liked, ((await env.KV.get('catalogue', 'json')) ?? {}) as Catalogue);
  }
  for (const part of chunks(text)) {
    await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: part, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: replyKeyboard });
  }
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
        await env.KV.put(rKey(r.kind, r.chat, r.gid), '1', { metadata: { at: new Date().toISOString() } });
        added++;
      }
      return json({ ok: true, added });
    }
    return new Response('hata bot');
  },
};
