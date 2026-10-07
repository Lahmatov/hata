import * as cheerio from 'cheerio';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { config, norm } from '../config.ts';
import { log } from '../log.ts';
import type { Adapter, RawListing } from '../types.ts';
import { bedroomsFromT, factsFromText } from './text.ts';

// Reads saved-search alert e-mails that the portals send to a dedicated mailbox (IMAP, read-only).
// This is the portals' own notification feature: nothing is scraped from their websites.

/** Listing URL patterns per portal: [source id, regex with the listing id in group 1]. */
const PORTALS: [string, RegExp][] = [
  ['idealista', /idealista\.pt\/(?:imovel|imoveis)\/(\d+)/],
  ['imovirtual', /imovirtual\.com\/(?:pt\/)?anuncio\/[^"'\s?#]*?-(ID\w+)/],
  ['supercasa', /supercasa\.pt\/[^"'\s?#]+\/i(\d+)/],
  ['casasapo', /casa\.sapo\.pt\/[^"'\s?#]*?([0-9a-f]{8}-[0-9a-f-]{27,})\.html/],
  ['olx', /olx\.pt\/d\/anuncio\/[^"'\s?#]*?-(ID\w+)\.html/],
  ['remax', /remax\.pt\/(?:pt\/)?imoveis\/[^"'\s?#]*?\/(\d{6,}-\d+)/],
  ['century21', /century21\.pt\/[^"'\s?#]*?\/(\d{6,})/],
  ['era', /era\.pt\/imovel\/[^"'\s?#]*?(\d{6,})/],
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

const num = (s: string | undefined) => {
  const n = Number((s ?? '').replace(/[^\d,]/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

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
      // The listing card: the closest ancestor whose text mentions a price.
      let block = $(a);
      for (let i = 0; i < 6 && !/\d[\d . ]{3,}\s?€/.test(block.text()); i++) block = block.parent();
      const text = block.text().replace(/\s+/g, ' ').trim();
      const prev = found.get(key);
      const title = $(a).text().replace(/\s+/g, ' ').trim();
      const facts = factsFromText(text);
      const prices = [...text.matchAll(/(\d{1,3}(?:[ . ]\d{3})+)\s?€/g)].map((x) => num(x[1])!).filter((p) => p > 30000);
      const area = config.areas.find((ar) => norm(text).includes(norm(ar))) ?? null;
      const listing: RawListing = {
        source,
        sourceId: m[1],
        url: href.split(/[?#]/)[0],
        title: prev?.title || title || text.slice(0, 80),
        price: prices[0] ?? prev?.price ?? null,
        area_m2: num(text.match(/(\d{2,4}(?:[.,]\d+)?)\s?m(?:²|2)(?!\w)/)?.[1]) ?? prev?.area_m2 ?? null,
        bedrooms: bedroomsFromT(text) ?? num(text.match(/(\d)\s+quartos?/i)?.[1]) ?? prev?.bedrooms ?? null,
        bathrooms: facts.bathrooms ?? prev?.bathrooms ?? null,
        garage: facts.garage ?? prev?.garage ?? null,
        floor: null,
        elevator: facts.elevator ?? prev?.elevator ?? null,
        condition: facts.condition ?? prev?.condition ?? null,
        neighborhood: area ?? prev?.neighborhood ?? null,
        municipality: null,
        address: null,
        lat: null,
        lon: null,
        description: `Из почтовой рассылки ${source}: ${text.slice(0, 300)}`,
        listed_since: prev?.listed_since ?? receivedAt,
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
      const since = new Date(Date.now() - 14 * 86400_000); // first run: last two weeks
      const query = lastUid ? { uid: `${lastUid + 1}:*` } : { since };
      let maxUid = lastUid;
      let mails = 0;
      for await (const msg of client.fetch(query, { uid: true, source: true, envelope: true }, { uid: true })) {
        if (msg.uid <= lastUid || !msg.source) continue;
        maxUid = Math.max(maxUid, msg.uid);
        const parsed = await simpleParser(msg.source);
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
