import { config } from './config.ts';
import { factsLine } from './summarize.ts';
import type { Listing } from './types.ts';

export interface DigestItem {
  group: 'new' | 'drop' | 'manual';
  leader: Listing;
  members: Listing[]; // same property on other portals
  negotiate: boolean;
  summary: string;
  reasons: string[];
}

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtEur = (n: number) => `${Math.round(n).toLocaleString('pt-PT').replace(/\s/g, ' ')} €`;

function renderItem(it: DigestItem, n: number): string {
  const l = it.leader;
  const where = [l.neighborhood, l.municipality].filter(Boolean).join(', ') || '?';
  const flag = it.negotiate ? ' ⚠️ <b>нужен торг</b>' : '';
  const head = `${n}. <b>${esc(where)}</b> — ${esc(l.title).slice(0, 90)}${flag}`;
  const drop = it.group === 'drop' && l.prev_price && l.price
    ? `\n📉 было ${fmtEur(l.prev_price)} → ${fmtEur(l.price)} (${(((l.price - l.prev_price) / l.prev_price) * 100).toFixed(1)}%)`
    : '';
  const manual = it.group === 'manual' && it.reasons.length ? `\n❓ неизвестно: ${esc(it.reasons.join(', '))}` : '';
  const links = [...new Map(it.members.map((m) => [m.url, m])).values()].map((m) => `<a href="${esc(m.url)}">${esc(m.source)}</a>`).join(' · ');
  return `${head}${drop}\n${esc(factsLine(l))}\n${esc(it.summary)}${manual}\n🔗 ${links}`;
}

const TITLES = { new: '🆕 НОВЫЕ', drop: '📉 СНИЖЕНИЕ ЦЕНЫ', manual: '❓ ПРОВЕРИТЬ ВРУЧНУЮ' } as const;
const TAGS = { new: '🆕 Новая', drop: '📉 Цена снижена', manual: '❓ Проверить вручную' } as const;

/** One Telegram post: a photo with an HTML caption, or plain HTML text. */
export interface Post {
  photo?: string | null;
  text: string;
  item?: DigestItem; // the flat this post is about (to mark it as notified once sent)
}

const CAPTION_LIMIT = 1024; // Telegram caption limit (visible characters)
const visibleLength = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&(lt|gt|amp);/g, '_').length;

/** Header post, one post per flat (with its photo when known), footer post. */
export function buildPosts(items: DigestItem[], failed: string[], date: string, hiddenManual = 0): Post[] {
  const header = `🏠 <b>Квартиры T3 · ${esc(date)}</b>`;
  const more = hiddenManual ? `\n…и ещё ${hiddenManual} для ручной проверки (дальше от школы), покажу в следующие дни.` : '';
  const sources = failed.length ? `⚠️ Источники с ошибками: ${esc(failed.join(', '))}` : '✅ Все источники ответили';
  if (!items.length) return [{ text: `${header}\nНовых объявлений и снижений цены нет.\n\n${sources}` }];

  const counts = (['new', 'drop', 'manual'] as const)
    .map((g) => [g, items.filter((i) => i.group === g).length] as const)
    .filter(([, n]) => n)
    .map(([g, n]) => `${TITLES[g]}: ${n}`);
  const posts: Post[] = [{ text: `${header}\n${counts.join(' · ')}` }];
  for (const g of ['new', 'drop', 'manual'] as const) {
    const group = items.filter((i) => i.group === g);
    group.forEach((it, idx) => {
      let text = `${TAGS[g]} ${idx + 1}/${group.length}\n${renderItem(it, idx + 1).replace(/^\d+\. /, '')}`;
      const photo = it.members.find((m) => m.image)?.image ?? null;
      // Captions are limited: drop the free-text summary first, then shorten the title.
      if (photo && visibleLength(text) > CAPTION_LIMIT) text = text.replace(`\n${esc(it.summary)}`, '');
      if (photo && visibleLength(text) > CAPTION_LIMIT) text = text.slice(0, CAPTION_LIMIT - 50);
      posts.push({ photo, text, item: it });
    });
  }
  posts.push({ text: `${sources}${more}` });
  return posts;
}

/** Sends one post to every recipient; fails only if nobody got it. */
export async function sendPost(post: Post): Promise<void> {
  const { token, chatIds } = config.telegram;
  if (!token || !chatIds.length) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set');
  const errors: string[] = [];
  for (const chatId of chatIds) {
    try {
      if (post.photo) {
        try {
          await call(token, 'sendPhoto', { chat_id: chatId, photo: post.photo, caption: post.text, parse_mode: 'HTML' });
        } catch {
          // Photo URL rejected (expired, too large...): send the text alone.
          await call(token, 'sendMessage', { chat_id: chatId, text: post.text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
        }
      } else {
        await call(token, 'sendMessage', { chat_id: chatId, text: post.text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
      }
    } catch (e) {
      errors.push(`${chatId}: ${(e as Error).message}`);
    }
  }
  if (errors.length === chatIds.length) throw new Error(errors.join('; '));
  for (const e of errors) console.error(`Telegram: ${e}`);
  await new Promise((r) => setTimeout(r, 1100)); // stay under ~1 message/s per chat
}

export async function sendTelegram(text: string): Promise<void> {
  await sendPost({ text });
}

async function call(token: string, method: string, payload: Record<string, unknown>): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });
    const body = (await res.json()) as { ok: boolean; description?: string; parameters?: { retry_after?: number } };
    if (body.ok) return;
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, ((body.parameters?.retry_after ?? 2 ** attempt) + 1) * 1000));
      continue;
    }
    throw new Error(`Telegram API error ${res.status}: ${body.description}`);
  }
  throw new Error('Telegram API: retries exhausted');
}
