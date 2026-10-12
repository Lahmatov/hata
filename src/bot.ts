import { config } from './config.ts';
import type { Store } from './db.ts';
import { log } from './log.ts';

// Telegram buttons under each flat: 👍 interesting / 👎 hide. The bot is not a server: button presses wait
// in Telegram (up to 24 h) and are collected by getUpdates on each run (and by a light job every 15 min).

export const keyboard = (groupId: string, chosen?: 'like' | 'hide') => ({
  inline_keyboard: [[
    { text: chosen === 'like' ? '✅ Интересно' : '👍 Интересно', callback_data: `l|${groupId}`.slice(0, 64) },
    { text: chosen === 'hide' ? '🚫 Скрыто' : '👎 Скрыть', callback_data: `h|${groupId}`.slice(0, 64) },
  ]],
});

interface Update {
  update_id: number;
  callback_query?: { id: string; data?: string; from: { first_name?: string }; message?: { message_id: number; chat: { id: number } } };
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

/** Applies pending 👍/👎 presses. Returns how many were processed. */
export async function processUpdates(store: Store): Promise<number> {
  if (!config.telegram.token) return 0;
  const offset = store.kvGet<number>('tg:offset') ?? 0;
  const updates = (await api<Update[]>('getUpdates', { offset, timeout: 0, allowed_updates: ['callback_query', 'message'] })) ?? [];
  let n = 0;
  for (const u of updates) {
    store.kvSet('tg:offset', u.update_id + 1);
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
  if (n) log.info(`telegram: ${n} button press(es) applied`);
  return n;
}
