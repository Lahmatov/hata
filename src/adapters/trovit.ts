import * as cheerio from 'cheerio';
import type { Adapter, RawListing } from '../types.ts';
import { bedroomsFromT, factsFromText } from './text.ts';

// Trovit is a public aggregator (it also indexes listings from portals we can't read directly).
// We only read its own result pages; outgoing links are kept as-is and never followed.
const BASE = 'https://casa.trovit.pt';
const SEARCHES = ['/t3-municipio-amadora', '/t3-municipio-oeiras', '/t3-queluz', '/t3-rio-de-mouro'];

const num = (s: string | undefined) => {
  const n = Number((s ?? '').replace(/[^\d,]/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

export const trovit: Adapter = {
  id: 'trovit',
  name: 'Trovit',
  maxPages: 3, // 30 per page

  searchUrls: () => SEARCHES.map((p) => `${BASE}${p}`),

  nextPageUrl(_body, url, pageNo) {
    return `${url.replace(/\/\d+$/, '')}/${pageNo + 1}`;
  },

  parse(body, pageUrl) {
    const $ = cheerio.load(body);
    // JSON-LD "about" lists the same 30 results in page order, with bedrooms/bathrooms.
    const ld: { numberOfBedrooms?: number; numberOfBathroomsTotal?: number; description?: string }[] = [];
    $('script[type="application/ld+json"]').each((_, s) => {
      try {
        const j = JSON.parse($(s).text());
        for (const x of Array.isArray(j) ? j : [j]) ld.push(...(x.about ?? []));
      } catch { /* ignore */ }
    });
    const place = decodeURIComponent(pageUrl.split('/').filter(Boolean).find((p) => p.startsWith('t3-')) ?? '').replace(/^t3-(municipio-)?/, '').replace(/-/g, ' ');
    return $('.snippet-listing').map((i, n): RawListing | null => {
      const el = $(n);
      const link = el.find('a[href]').filter((_, a) => !/javascript:|#$/.test($(a).attr('href') ?? '')).first();
      const href = link.attr('href') ?? el.attr('data-url') ?? '';
      if (!href) return null;
      const title = el.find('.snippet-listing-content-header-title').first().text().replace(/\s+/g, ' ').trim()
        || link.attr('title') || '';
      const all = el.text().replace(/\s+/g, ' ');
      const description = el.find('.snippet-listing-content-header-description').text().replace(/\s+/g, ' ').trim() || null;
      const meta = ld[i] ?? {};
      const facts = factsFromText(`${title} ${all} ${meta.description ?? ''}`);
      const id = el.attr('data-id') ?? el.attr('id') ?? href.match(/[?&](?:id|cod)=([^&]+)/)?.[1] ?? href;
      return {
        source: 'trovit',
        sourceId: String(id),
        url: new URL(href, BASE).toString(),
        title,
        price: num(all.match(/(\d{1,3}(?:[ . ]\d{3})+)\s?€/)?.[1]),
        area_m2: num(all.match(/(\d{2,4}(?:[.,]\d+)?)\s?m²/)?.[1]),
        bedrooms: meta.numberOfBedrooms ?? num(all.match(/(\d)\s+(?:quartos?|dorm)/i)?.[1]) ?? bedroomsFromT(`${title} ${description ?? ''}`),
        bathrooms: meta.numberOfBathroomsTotal ?? num(all.match(/(\d)\s+(?:casas? de banho|wc|banhos?)/i)?.[1]) ?? facts.bathrooms,
        garage: facts.garage,
        floor: null,
        elevator: facts.elevator,
        condition: facts.condition,
        neighborhood: place ? place.replace(/\b\w/g, (c) => c.toUpperCase()) : null,
        municipality: /amadora/.test(pageUrl) ? 'Amadora' : /oeiras/.test(pageUrl) ? 'Oeiras' : 'Sintra',
        address: null,
        lat: null,
        lon: null,
        description: description ?? meta.description ?? null,
      };
    }).get().filter((l): l is RawListing => !!l && !/moradia|vivenda|terreno|loja/i.test(l.title));
  },
};
