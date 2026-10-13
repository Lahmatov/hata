import { EMAIL_MARK, type Store } from './db.ts';
import { esc } from './telegram.ts';
import type { Listing } from './types.ts';

// News about the flats either of you liked: 📉 cheaper, 🚫 no longer listed, ✅ back on sale. State per flat in
// the kv table; the first look at a flat only records it, so turning this on does not flood the chat.

const GONE_AFTER_DAYS = 3; // same "on sale" rule as the favourites list and the swipe app
const k = (n: number) => `${Math.round(n / 1000)}`;

/** Group ids liked (👍 or 🌟) by either person. */
export function favouriteGroups(store: Store): Set<string> {
  return new Set([...store.reactions('like'), ...store.reactions('super')]);
}

export function favouriteNews(store: Store, now = Date.now(), save = true): string[] {
  const fav = favouriteGroups(store);
  const byGroup = new Map<string, Listing[]>();
  for (const l of store.all()) if (fav.has(l.group_id)) byGroup.set(l.group_id, [...(byGroup.get(l.group_id) ?? []), l]);
  const lines: string[] = [];
  for (const [gid, members] of byGroup) {
    const last = members.reduce((a, b) => (a.last_seen > b.last_seen ? a : b));
    const fresh = members.filter((m) => now - Date.parse(m.last_seen) < 7 * 86400_000 && m.price !== null);
    const price = fresh.length ? Math.min(...fresh.map((m) => m.price!)) : null;
    // Flats known only from alert e-mails are never re-read, so "not seen" says nothing about them.
    const emailOnly = members.every((m) => (m.description ?? '').startsWith(EMAIL_MARK));
    const gone = !emailOnly && now - Date.parse(last.last_seen) > GONE_AFTER_DAYS * 86400_000;
    const prev = store.kvGet<{ p: number | null; gone: boolean }>(`fav:${gid}`);
    const place = [last.neighborhood, last.municipality].filter(Boolean).join(', ') || last.title;
    const link = `<a href="${esc(last.url)}">${esc(place)}</a>`;
    if (prev) {
      if (gone && !prev.gone) lines.push(`🚫 ${link}: не видим на сайтах ${GONE_AFTER_DAYS} дня, похоже, продана или снята`);
      else if (!gone && prev.gone) lines.push(`✅ ${link} снова в продаже${price ? `: ${k(price)} тыс. €` : ''}`);
      else if (!gone && price !== null && prev.p !== null && price < prev.p - 1) {
        lines.push(`📉 ${link} подешевела: ${k(prev.p)} → ${k(price)} тыс. € (−${String(Math.round(((prev.p - price) / prev.p) * 1000) / 10).replace('.', ',')}%)`);
      }
    }
    if (save) store.kvSet(`fav:${gid}`, { p: price ?? prev?.p ?? null, gone });
  }
  return lines;
}

export const favouriteNewsText = (lines: string[]) => (lines.length ? `⭐ <b>Новости по избранному</b>\n${lines.join('\n')}` : null);
