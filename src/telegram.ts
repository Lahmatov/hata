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
  const links = it.members.map((m) => `<a href="${esc(m.url)}">${esc(m.source)}</a>`).join(' · ');
  return `${head}${drop}\n${esc(factsLine(l))}\n${esc(it.summary)}${manual}\n🔗 ${links}`;
}

const TITLES = { new: '🆕 НОВЫЕ', drop: '📉 СНИЖЕНИЕ ЦЕНЫ', manual: '❓ ПРОВЕРИТЬ ВРУЧНУЮ' } as const;

/** Builds Telegram HTML messages: ≤15 items and ≤4096 chars each. */
export function buildMessages(items: DigestItem[], failed: string[], date: string, hiddenManual = 0): string[] {
  const max = config.telegram.maxItemsPerMessage;
  const header = `🏠 <b>Квартиры T3 · ${esc(date)}</b>`;
  const more = hiddenManual ? `\n\n…и ещё ${hiddenManual} для ручной проверки (дальше от школы), покажу в следующие дни.` : '';
  const footer = more + (failed.length ? `\n\n⚠️ Источники с ошибками сегодня: ${esc(failed.join(', '))}` : '\n\n✅ Все источники ответили');
  if (!items.length) return [`${header}\nНовых объявлений и снижений цены нет.${footer}`];

  const blocks: { section: string; text: string }[] = [];
  for (const g of ['new', 'drop', 'manual'] as const) {
    items.filter((i) => i.group === g).forEach((it, idx) => blocks.push({ section: `${TITLES[g]} (${items.filter((i) => i.group === g).length})`, text: renderItem(it, idx + 1) }));
  }
  const msgs: string[] = [];
  let cur = header;
  let count = 0;
  let section = '';
  for (const b of blocks) {
    const sectionHead = b.section !== section ? `\n\n<b>${b.section}</b>` : '';
    const add = `${sectionHead}\n\n${b.text}`;
    if (count >= max || cur.length + add.length + footer.length > 4000) {
      msgs.push(cur);
      cur = `${header} (продолжение)\n\n<b>${b.section}</b>\n\n${b.text}`;
      count = 1;
    } else {
      cur += add;
      count++;
    }
    section = b.section;
  }
  msgs.push(cur);
  msgs[msgs.length - 1] += footer;
  return msgs.map((m, i) => (msgs.length > 1 ? m.replace(header, `${header} [${i + 1}/${msgs.length}]`) : m));
}

export async function sendTelegram(text: string): Promise<void> {
  const { token, chatId } = config.telegram;
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set');
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
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
