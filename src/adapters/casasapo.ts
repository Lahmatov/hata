import * as cheerio from 'cheerio';
import type { Adapter, Condition, Http, RawListing } from '../types.ts';
import { bedroomsFromT, factsFromText } from './text.ts';

const BASE = 'https://casa.sapo.pt';
const AREAS = ['amadora', 'oeiras', 'sintra', 'lisboa'];
const CONDITION: Record<string, Condition> = {
  novo: 'new', 'em construcao': 'new', 'em construção': 'new', renovado: 'renovated', remodelado: 'renovated',
  usado: 'good', 'em uso': 'good', 'para recuperar': 'needs_renovation', ruina: 'needs_renovation', 'em ruínas': 'needs_renovation',
};
const cond = (s: string | undefined) => (s ? (CONDITION[s.trim().toLowerCase()] ?? null) : null);
const num = (s: string | undefined) => {
  const n = Number((s ?? '').replace(/[^\d,]/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** The card link goes through a click counter; the real listing URL is in its `l` parameter. */
export function realUrl(href: string): string {
  const l = href.match(/[?&]l=([^&]+)/)?.[1];
  const u = l ? decodeURIComponent(l) : href;
  return new URL(u, BASE).toString().replace(/\?g3pid=.*$/, '');
}

export const casasapo: Adapter = {
  id: 'casasapo',
  name: 'Casa Sapo',
  maxPages: 8, // 25 per page

  searchUrls: () => AREAS.map((a) => `${BASE}/comprar-apartamentos/t3/${a}/`),

  nextPageUrl(body, url, pageNo) {
    const $ = cheerio.load(body);
    const next = `pn=${pageNo + 1}`;
    if (!$(`a[href*="${next}"]`).length) return null;
    const u = new URL(url);
    u.searchParams.set('pn', String(pageNo + 1));
    return u.toString();
  },

  parse(body) {
    const $ = cheerio.load(body);
    // Search-page JSON-LD offers carry coordinates; match them to cards by name/price.
    const geo = new Map<string, { lat: number; lon: number }>();
    $('script[type="application/ld+json"]').each((_, s) => {
      try {
        const j = JSON.parse($(s).text());
        const g = j?.availableAtOrFrom?.geo;
        if (j?.['@type'] === 'Offer' && g?.latitude) geo.set(`${j.price?.[0] ?? ''}|${j.availableAtOrFrom?.address?.addressRegion ?? ''}`, { lat: g.latitude, lon: g.longitude });
      } catch { /* ignore */ }
    });
    return $('a.property-info').map((_, a): RawListing => {
      const el = $(a);
      const card = el.closest('.property');
      const url = realUrl(el.attr('href') ?? '');
      const type = el.find('.property-type').text().trim();
      const loc = el.find('.property-location').text().split(',').map((s) => s.trim());
      const [state, areaTxt] = el.find('.property-features-text').text().split('·').map((s) => s.trim());
      const tags = el.find('.property-features-tag span').map((_, t) => $(t).text().trim().toLowerCase()).get();
      const priceTxt = el.find('.property-price-value').text().trim();
      const description = card.find('.property-description').text().trim() || null;
      const text = factsFromText(description);
      const parish = loc.length >= 3 ? loc[loc.length - 3] : null;
      const g = geo.get(`${priceTxt}|${parish ?? ''}`);
      return {
        source: 'casasapo',
        sourceId: url.match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.html/)?.[1] ?? url,
        url,
        title: `${type}${loc[0] ? `, ${loc[0]}` : ''}`,
        price: num(priceTxt),
        area_m2: num(areaTxt),
        bedrooms: bedroomsFromT(type),
        bathrooms: text.bathrooms,
        garage: tags.some((t) => t.includes('garagem') || t.includes('estacionamento')) ? true : text.garage,
        floor: null,
        elevator: text.elevator,
        condition: cond(state) ?? text.condition,
        neighborhood: parish,
        municipality: loc.length >= 2 ? loc[loc.length - 2] : null,
        address: loc.length >= 4 ? loc[0] : null,
        lat: g?.lat ?? null,
        lon: g?.lon ?? null,
        description,
      };
    }).get().filter((l) => /^apartamento/i.test(l.title));
  },

  async enrich(l: RawListing, http: Http): Promise<RawListing> {
    const page = await http.get(l.url);
    return { ...l, ...parseDetail(page.body, l) };
  },
};

/** Detail page: items like "Casa(s) de Banho: 2", "Garagem: 1", "Elevador: 1", "Piso: 3", "Conservação: Em Uso" + JSON-LD geo. */
export function parseDetail(body: string, l: Pick<RawListing, 'bathrooms' | 'garage' | 'elevator' | 'condition' | 'lat' | 'lon'>): Partial<RawListing> {
  const $ = cheerio.load(body);
  const fields = new Map<string, string>();
  $('li, div, span, p').each((_, e) => {
    if ($(e).children().length > 2) return;
    const m = $(e).text().replace(/\s+/g, ' ').trim().match(/^([^:]{2,30}):\s*(.{1,40})$/);
    if (m && !fields.has(m[1].toLowerCase())) fields.set(m[1].toLowerCase(), m[2].trim());
  });
  let lat = l.lat;
  let lon = l.lon;
  let description: string | null = null;
  $('script[type="application/ld+json"]').each((_, s) => {
    try {
      const j = JSON.parse($(s).text());
      const g = j?.availableAtOrFrom?.geo;
      if (g?.latitude) { lat = g.latitude; lon = g.longitude; }
      if (j?.['@type'] === 'Offer' && j.description) description = String(j.description).replace(/<br\s*\/?>/g, '\n');
    } catch { /* ignore */ }
  });
  const fromText = factsFromText(description);
  const baths = num(fields.get('casa(s) de banho'));
  const garage = fields.get('garagem');
  const lift = fields.get('elevador');
  return {
    bathrooms: baths ?? fromText.bathrooms ?? l.bathrooms,
    garage: garage !== undefined ? Number(garage) > 0 : (fromText.garage ?? l.garage),
    elevator: lift !== undefined ? Number(lift) > 0 : (fromText.elevator ?? l.elevator),
    floor: fields.get('piso') ?? null,
    condition: cond(fields.get('conservação')) ?? fromText.condition ?? l.condition,
    lat, lon,
    ...(description ? { description: (description as string).slice(0, 1500) } : {}),
  };
}
