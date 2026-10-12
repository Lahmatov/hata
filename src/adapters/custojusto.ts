import type { Adapter, Http, RawListing } from '../types.ts';
import { bedroomsFromT, factsFromText, nextData } from './text.ts';

const BASE = 'https://www.custojusto.pt';
const AREAS = ['amadora', 'oeiras', 'sintra'];

interface ListItem {
  listID: string; title: string; body?: string; type: string; price: number | null; url: string;
  locationNames?: { county?: string; parish?: string }; params?: { rooms?: string; size?: string };
}

export const custojusto: Adapter = {
  id: 'custojusto',
  name: 'CustoJusto',
  maxPages: 3, // 40 ads per page, newest first; no server-side T3 filter, so we filter here

  searchUrls: () => AREAS.map((a) => `${BASE}/lisboa/${a}/imobiliario/apartamentos-venda`),

  nextPageUrl(_body, url, pageNo) {
    const u = new URL(url);
    u.searchParams.set('o', String(pageNo + 1));
    return u.toString();
  },

  parse(body) {
    const items: ListItem[] = nextData(body).props?.pageProps?.listItems ?? [];
    return items
      .filter((i) => i.type === 'sell')
      .map((i): RawListing => {
        const text = factsFromText(`${i.title}\n${i.body ?? ''}`);
        const size = Number.parseFloat((i.params?.size ?? '').replace(',', '.'));
        return {
          source: 'custojusto',
          sourceId: i.listID,
          url: `${BASE}${i.url}`,
          title: i.title,
          price: i.price || null,
          area_m2: Number.isFinite(size) ? size : null,
          bedrooms: bedroomsFromT(i.params?.rooms) ?? bedroomsFromT(i.title),
          bathrooms: text.bathrooms,
          garage: text.garage,
          floor: null,
          elevator: text.elevator,
          condition: text.condition,
          neighborhood: i.locationNames?.parish ?? null,
          municipality: i.locationNames?.county ?? null,
          address: null,
          lat: null,
          lon: null,
          description: i.body ?? null,
        };
      });
  },

  async enrich(l: RawListing, http: Http): Promise<RawListing> {
    const page = await http.get(l.url);
    return { ...l, ...parseDetail(page.body, l) };
  },
};

/** Detail page has the full text and exact coordinates; structured bathrooms/garage are not published. */
export function parseDetail(body: string, l: Pick<RawListing, 'bathrooms' | 'garage' | 'elevator' | 'condition'>): Partial<RawListing> {
  const ad = nextData(body).props?.pageProps?.adData;
  if (!ad) return {};
  const text = factsFromText(`${ad.title ?? ''}\n${ad.body ?? ''}`);
  const floor = String(ad.body ?? '').match(/\b(\d{1,2})\s*[ºo°]\s*andar\b/i)?.[1] ?? (/r\/c|res-do-chao|rés-do-chão/i.test(ad.body ?? '') ? 'r/c' : null);
  return {
    bathrooms: text.bathrooms ?? l.bathrooms,
    garage: text.garage ?? l.garage,
    elevator: text.elevator ?? l.elevator,
    condition: text.condition ?? l.condition,
    floor,
    lat: ad.hasValidLocation ? (ad.location?.lat ?? null) : null,
    lon: ad.hasValidLocation ? (ad.location?.lon ?? null) : null,
    description: String(ad.body ?? '').slice(0, 1500),
  };
}
