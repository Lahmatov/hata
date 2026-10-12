import { config } from './config.ts';
import type { Store } from './db.ts';
import type { Listing } from './types.ts';
import { log } from './log.ts';
import { esc } from './telegram.ts';

// Telegram buttons under each flat: 👍 interesting / 👎 hide, plus the "⭐ Избранное" command. The bot is not
// a server: presses and messages wait in Telegram (up to 24 h) and are collected by getUpdates on each run
// and by a light job every few minutes.

const FAV_BUTTON = '⭐ Избранное';
const replyKeyboard = { keyboard: [[{ text: FAV_BUTTON }]], resize_keyboard: true, is_persistent: true };
const HELP = `Я присылаю квартиры три раза в день.\n👍 под квартирой: добавить в избранное, 👎: больше не показывать (для обоих).\n${FAV_BUTTON} (кнопка внизу или /fav): список избранного в любой момент.\nОтвечаю не сразу, а в течение 5–15 минут.`;

export const keyboard = (groupId: string, chosen?: 'like' | 'hide') => ({
  inline_keyboard: [[
    { text: chosen === 'like' ? '✅ Интересно' : '👍 Интересно', callback_data: `l|${groupId}`.slice(0, 64) },
    { text: chosen === 'hide' ? '🚫 Скрыто' : '👎 Скрыть', callback_data: `h|${groupId}`.slice(0, 64) },
  ]],
});

interface Update {
  update_id: number;
  callback_query?: { id: string; data?: string; from: { first_name?: string }; message?: { message_id: number; chat: { id: number } } };
  message?: { text?: string; chat: { id: number } };
}

/** Flats marked 👍 that are still on sale (seen in the last 3 days), as Telegram HTML; null when none. */
export function favouritesText(store: Store, title = 'Избранное'): string | null {
  const liked = store.reactions('like');
  if (!liked.size) return null;
  const byGroup = new Map<string, Listing>();
  for (const l of store.all()) {
    if (!liked.has(l.group_id)) continue;
    const cur = byGroup.get(l.group_id);
    if (!cur || Date.parse(l.last_seen) > Date.parse(cur.last_seen) || (l.price ?? Infinity) < (cur.price ?? Infinity)) byGroup.set(l.group_id, l);
  }
  const all = [...byGroup.values()];
  const onSale = all.filter((l) => Date.now() - Date.parse(l.last_seen) < 3 * 86400_000)
    .sort((a, b) => (a.commute_min ?? 99) - (b.commute_min ?? 99));
  const gone = all.length - onSale.length;
  const lines = onSale.map((l, i) => {
    const place = [l.neighborhood, l.municipality].filter(Boolean).join(', ');
    const facts = [l.price ? `${Math.round(l.price / 1000)} тыс. €` : 'цена ?', l.area_m2 ? `${Math.round(l.area_m2)} м²` : null,
      l.commute_min !== null ? `🚗 ${Math.round(l.commute_min)} мин` : null].filter(Boolean).join(' · ');
    return `${i + 1}. <a href="${esc(l.url)}">${esc(place || l.title)}</a> — ${esc(facts)}`;
  });
  const tail = gone ? `\n\n(ещё ${gone} из избранного уже сняты с продажи)` : '';
  return `⭐ <b>${esc(title)}</b>: ${onSale.length}\n${lines.join('\n')}${tail}`;
}

/** Telegram limits a message to 4096 characters: split on line breaks. */
function chunks(text: string, max = 3800): string[] {
  const out: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > max) { out.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + line;
  }
  return cur ? [...out, cur] : out;
}

async function reply(chatId: number, text: string) {
  for (const part of chunks(text)) {
    await api('sendMessage', { chat_id: chatId, text: part, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: replyKeyboard });
  }
}

async function api<T>(method: string, payload: Record<string, unknown>): Promise<T | null> {
  const res = await fetch(`https://api.telegram.org/bot${config.telegram.token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });
  const body = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!body.ok) log.debug(`telegram ${method}: ${body.description}`);
  return body.ok ? (body.result ?? null) : null;
}

/** Applies pending 👍/👎 presses and answers commands. Returns how many updates were handled. */
export async function processUpdates(store: Store): Promise<number> {
  if (!config.telegram.token) return 0;
  if (store.kvGet<number>('tg:commands') !== 1) {
    await api('setMyCommands', { commands: [{ command: 'fav', description: 'Избранное' }, { command: 'help', description: 'Как пользоваться' }] });
    store.kvSet('tg:commands', 1);
  }
  const offset = store.kvGet<number>('tg:offset') ?? 0;
  const updates = (await api<Update[]>('getUpdates', { offset, timeout: 0, allowed_updates: ['callback_query', 'message'] })) ?? [];
  let n = 0;
  for (const u of updates) {
    store.kvSet('tg:offset', u.update_id + 1);
    const msg = u.message;
    // Commands only from our own recipients: favourites are private.
    if (msg?.text && config.telegram.chatIds.includes(String(msg.chat.id))) {
      const t = msg.text.trim().toLowerCase();
      if (/^\/fav|избранн|^⭐/.test(t)) await reply(msg.chat.id, favouritesText(store) ?? '⭐ Избранное пока пусто: нажимайте 👍 под квартирами.');
      else await reply(msg.chat.id, HELP);
      n++;
      continue;
    }
    const q = u.callback_query;
    const m = q?.data?.match(/^([lh])\|(.+)$/);
    if (!q || !m) continue;
    const kind = m[1] === 'l' ? 'like' : 'hide';
    const chatId = String(q.message?.chat.id ?? '');
    store.setReaction(m[2], kind, chatId);
    n++;
    // Late answers are fine to try: they fail silently if the press is too old.
    await api('answerCallbackQuery', { callback_query_id: q.id, text: kind === 'like' ? 'Отмечено 👍' : 'Больше не покажу' });
    if (q.message) {
      await api('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: keyboard(m[2], kind) });
    }
  }
  if (n) log.info(`telegram: ${n} button press(es) / command(s) handled`);
  return n;
}
