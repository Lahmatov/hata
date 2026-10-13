import * as cheerio from 'cheerio';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { config, norm } from '../config.ts';
import { EMAIL_MARK } from '../db.ts';
import { log } from '../log.ts';
import type { Adapter, RawListing } from '../types.ts';
import { bedroomsFromT, factsFromText } from './text.ts';

// Reads saved-search alert e-mails that the portals send to a dedicated mailbox (IMAP, read-only).
// This is the portals' own notification feature: nothing is scraped from their websites.

/** Listing URL patterns per portal: [source id, regex with the listing id in group 1]. */
const PORTALS: [string, RegExp][] = [
  ['idealista', /idealista\.pt\/(?:[a-z]{2}\/)?(?:imovel|imoveis)\/(\d+)/],
  ['imovirtual', /imovirtual\.com\/(?:pt\/)?anuncio\/[^"'\s?#]*?-(ID\w+)/],
  ['supercasa', /supercasa\.pt\/[^"'\s?#]+\/i(\d+)/],
  ['casasapo', /casa\.sapo\.pt\/[^"'\s?#]*?([0-9a-f]{8}-[0-9a-f-]{27,})\.html/],
  ['olx', /olx\.pt\/d\/anuncio\/[^"'\s?#]*?-(ID\w+)\.html/],
  ['remax', /remax\.pt\/(?:pt\/)?imoveis\/[^"'\s?#]*?\/(\d{6,}-\d+)/],
  ['century21', /century21\.pt\/[^"'\s?#]*?\/(\d{6,})/],
  ['era', /era\.pt\/imovel\/[^"'\s?#]*?(\d{6,})/],
  ['custojusto', /custojusto\.pt\/[^"'\s?#]+-(\d{7,})(?:[?#]|$)/],
  ['zome', /zome\.pt\/[^"'\s?#]*?imovel[^"'\s?#]*?(\d{5,})/],
  ['kw', /kwportugal\.pt\/[^"'\s?#]*?im[oó]vel[^"'\s?#]*?(\d{5,})/],
  ['trovit', /trovit\.pt\/detail\/(trovit-PT-\d+)/],
];

/** Tracking redirects hide the real URL in a parameter (sometimes encoded twice): unwrap it. */
export function unwrapUrl(href: string): string {
  let cur = href;
  for (let i = 0; i < 3; i++) {
    const inner = cur.match(/[?&][^=]{1,20}=(https?(?:%3A|:)[^&]+)/i)?.[1];
    if (!inner) break;
    cur = decodeURIComponent(inner);
  }
  return cur;
}

/** "339,000 €" / "565.000 €" / "390 000 €": a whole price, not glued to a preceding reference number. */
const PRICE_RE = /(?<![\w.,])(\d{1,3}(?:([ .,\u00a0])\d{3})(?:\2\d{3})*)\s?€/g;
const intOf = (s: string) => Number(s.replace(/\D/g, ''));

const keyOf = (href: string): string | null => {
  const u = unwrapUrl(href);
  for (const [source, re] of PORTALS) {
    const m = u.match(re);
    if (m) return `${source}:${m[1]}`;
  }
  return null;
};

const num = (s: string | undefined) => {
  const n = Number((s ?? '').replace(/[^\d,]/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** E-mails that are not new-listing or price alerts: newsletters, removed favourites, replies, account notices. */
export function skipEmail(from: string, subject: string): boolean {
  return /news@|newsletter|mailing\./i.test(from)
    || /no longer listed|já não está|deixou de estar|removed|retirad|response about|resposta|início de sessão|sign[- ]?in|login|confirmação de registo|registration/i.test(subject);
}

/** Flats known only from alerts stay in play (unsent ones are retried, unmentioned ones expire) for two weeks. */
export const EMAIL_MAX_AGE_DAYS = 14;
/** Only e-mails from the last day are read (the monitor runs several times a day; each e-mail is read once). */
export const EMAIL_READ_DAYS = Number(process.env.EMAIL_READ_DAYS ?? 1);

/** Pure parser for one alert e-mail (HTML). Exported for fixture tests. */
export function parseAlertEmail(html: string, receivedAt: string | null = null): RawListing[] {
  const $ = cheerio.load(html);
  const found = new Map<string, RawListing>();
  $('a[href]').each((_, a) => {
    const href = unwrapUrl($(a).attr('href') ?? '');
    for (const [source, re] of PORTALS) {
      const m = href.match(re);
      if (!m) continue;
      const key = `${source}:${m[1]}`;
      // The listing card: climb to the closest ancestor whose text mentions a price, but never
      // into a container that also holds another listing (alert e-mails list several cards).
      let block = $(a);
      for (let i = 0; i < 15 && !/\d\s?€/.test(block.text()); i++) {
        const up = block.parent();
        if (!up.length) break;
        const others = up.find('a[href]').toArray().some((o) => { const k = keyOf($(o).attr('href') ?? ''); return k !== null && k !== key; });
        if (others) break;
        block = up;
      }
      const text = block.text().replace(/\s+/g, ' ').trim();
      // Rentals ("3000 €/month", "arrendamento") are never what we look for.
      if (/€\s*\/\s*(?:month|m[eê]s|мес)|\barrendamento\b|\/arrendar[-/]|-arrendamento-/i.test(text + ' ' + href)) break;
      const prev = found.get(key);
      const clean = (t: string) => t.replace(/\s+/g, ' ').replace(/^(?:Смотреть больше|See|Ver(?: mais)?)\s+\d+\s+\S+\s*/i, '').replace(/\s*Ref:.*$/, '').trim();
      const title = clean($(a).attr('title') || $(a).find('img').attr('title') || $(a).text());
      const facts = factsFromText(text);
      const img = block.find('img').toArray().map((e) => $(e).attr('src') ?? '').find((u) => /^https?:\/\//.test(u) && !/logo|pixel|track|spacer|badge/i.test(u)) ?? null;
      const prices = [...text.matchAll(PRICE_RE)].map((x) => intOf(x[1])).filter((p) => p > 30000);
      const slug = norm(href.split(/[?#]/)[0].replace(/-/g, ' '));
      const bedrooms = bedroomsFromT(text) ?? num(href.match(/-t(\d)(?:[-/]|$)/i)?.[1])
        ?? num(text.match(/(\d)\s*(?:quartos?|-?bedrooms?|комнат)/i)?.[1]) ?? prev?.bedrooms ?? null;
      const garage = facts.garage ?? (/гараж|\bgarage\b/i.test(text) ? true : null);
      const elevator = facts.elevator ?? (/лифт|\blift\b|\belevator\b/i.test(text) ? true : null);
      const area = config.areas.find((ar) => norm(text).includes(norm(ar)))
        ?? config.areas.find((ar) => slug.includes(norm(ar))) ?? null;
      const listing: RawListing = {
        source,
        sourceId: m[1],
        url: href.split(/[?#]/)[0],
        title: prev?.title || title || clean(text).slice(0, 80),
        price: prices[0] ?? prev?.price ?? null,
        area_m2: num(text.match(/(\d{2,4}(?:[.,]\d+)?)\s?m(?:²|2)(?!\w)/)?.[1]) ?? prev?.area_m2 ?? null,
        bedrooms,
        bathrooms: facts.bathrooms ?? prev?.bathrooms ?? null,
        garage: garage ?? prev?.garage ?? null,
        floor: null,
        elevator: elevator ?? prev?.elevator ?? null,
        condition: facts.condition ?? prev?.condition ?? null,
        neighborhood: area ?? prev?.neighborhood ?? null,
        municipality: null,
        address: null,
        lat: null,
        lon: null,
        description: `${EMAIL_MARK} ${source}: ${text.slice(0, 300)}`,
        listed_since: prev?.listed_since ?? receivedAt,
        emailed_at: receivedAt,
        image: prev?.image ?? img,
        images: prev?.images ?? (img ? [img] : null),
      };
      found.set(key, listing);
      break;
    }
  });
  return [...found.values()];
}

export const emailAlerts: Adapter = {
  id: 'email',
  name: 'Почтовые рассылки',
  enabled: () => Boolean(process.env.IMAP_USER && process.env.IMAP_PASSWORD),
  searchUrls: () => [],
  parse: () => [],

  async fetchAll({ kvGet, kvSet }) {
    const client = new ImapFlow({
      host: process.env.IMAP_HOST ?? 'imap.gmail.com',
      port: Number(process.env.IMAP_PORT ?? 993),
      secure: true,
      auth: { user: process.env.IMAP_USER!, pass: process.env.IMAP_PASSWORD! },
      logger: false,
    });
    await client.connect();
    const out: RawListing[] = [];
    const lock = await client.getMailboxLock(process.env.IMAP_FOLDER ?? 'INBOX', { readOnly: true });
    try {
      const lastUid = kvGet<number>('email:lastUid') ?? 0;
      const since = new Date(Date.now() - EMAIL_READ_DAYS * 86400_000); // first run: the last day
      const query = lastUid ? { uid: `${lastUid + 1}:*` } : { since };
      let maxUid = lastUid;
      let mails = 0;
      for await (const msg of client.fetch(query, { uid: true, source: true, envelope: true }, { uid: true })) {
        if (msg.uid <= lastUid || !msg.source) continue;
        maxUid = Math.max(maxUid, msg.uid);
        const parsed = await simpleParser(msg.source);
        if (skipEmail(parsed.from?.text ?? '', parsed.subject ?? '')) continue;
        if (parsed.date && Date.now() - parsed.date.getTime() > EMAIL_READ_DAYS * 86400_000) continue;
        const html = typeof parsed.html === 'string' ? parsed.html : (parsed.textAsHtml ?? '');
        const got = parseAlertEmail(html, parsed.date?.toISOString() ?? null);
        mails++;
        out.push(...got);
      }
      kvSet('email:lastUid', maxUid);
      log.info(`email: ${mails} new e-mails, ${out.length} listing links`);
    } finally {
      lock.release();
      await client.logout();
    }
    return out;
  },
};
