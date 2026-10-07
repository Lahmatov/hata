import type { Adapter, Condition, Http, RawListing } from '../types.ts';
import { factsFromText, nextData, stripHtml } from './text.ts';

const BASE = 'https://www.imovirtual.com';
// Imovirtual counts the living room: rooms_num 4 == T3.
const ROOMS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6, SEVEN: 7, EIGHT: 8, NINE: 9, TEN: 10 };
const FLOORS: Record<string, string> = {
  CELLAR: 'cave', GROUND: 'r/c', FIRST: '1', SECOND: '2', THIRD: '3', FOURTH: '4', FIFTH: '5', SIXTH: '6', SEVENTH: '7',
  EIGHTH: '8', NINTH: '9', TENTH: '10', ABOVE_TENTH: '10+', GARRET: 'мансарда',
};
const CONSTRUCTION: Record<string, Condition> = { ready_to_use: 'good', to_renovation: 'needs_renovation', to_completion: 'needs_renovation' };

// Municipality-level searches (T3, ≤ 430k, newest first). Parishes are filtered later by config.areas.
const AREAS = ['lisboa/amadora', 'lisboa/oeiras', 'lisboa/sintra', 'lisboa/lisboa'];

interface SearchItem {
  id: number; slug: string; title: string; estate: string; transaction: string; hidePrice: boolean;
  totalPrice: { value: number } | null; createdAtFirst?: string | null; dateCreated?: string | null; areaInSquareMeters: number | null; roomsNumber: string | null; floorNumber: string | null;
  location?: { address?: { street?: { name?: string | null; number?: string | null } | null } | null; reverseGeocoding?: { locations?: { locationLevel: string; name: string }[] } };
}

export const imovirtual: Adapter = {
  id: 'imovirtual',
  name: 'Imovirtual',
  maxPages: 6,

  searchUrls: () => AREAS.map((a) => `${BASE}/pt/resultados/comprar/apartamento,t3/${a}?priceMax=430000&by=LATEST&direction=DESC&limit=72`),

  nextPageUrl(body, url, pageNo) {
    const p = nextData(body).props?.pageProps?.data?.searchAds?.pagination;
    if (!p || pageNo >= p.totalPages) return null;
    const u = new URL(url);
    u.searchParams.set('page', String(pageNo + 1));
    return u.toString();
  },

  parse(body) {
    const items: SearchItem[] = nextData(body).props?.pageProps?.data?.searchAds?.items ?? [];
    return items
      .filter((i) => i.estate === 'FLAT' && i.transaction === 'SELL')
      .map((i): RawListing => {
        const locs = i.location?.reverseGeocoding?.locations ?? [];
        const street = i.location?.address?.street;
        const rooms = i.roomsNumber ? ROOMS[i.roomsNumber] : undefined;
        return {
          source: 'imovirtual',
          sourceId: String(i.id),
          url: `${BASE}/pt/anuncio/${i.slug}`,
          title: i.title,
          price: i.hidePrice ? null : (i.totalPrice?.value ?? null),
          area_m2: i.areaInSquareMeters ?? null,
          bedrooms: rooms ? rooms - 1 : null,
          bathrooms: null,
          garage: null,
          floor: i.floorNumber ? (FLOORS[i.floorNumber] ?? i.floorNumber) : null,
          elevator: null,
          condition: null,
          neighborhood: locs.find((l) => l.locationLevel === 'parish')?.name ?? null,
          municipality: locs.find((l) => l.locationLevel === 'council')?.name ?? null,
          address: street?.name ? [street.name, street.number].filter(Boolean).join(' ') : null,
          lat: null,
          lon: null,
          listed_since: i.createdAtFirst ?? i.dateCreated ?? null,
        };
      });
  },

  async enrich(l: RawListing, http: Http): Promise<RawListing> {
    const page = await http.get(l.url);
    return { ...l, ...parseDetail(page.body) };
  },
};

/** Detail page: bathrooms, garage, lift, condition, coordinates. Exported for fixture tests. */
export function parseDetail(body: string): Partial<RawListing> {
  const ad = nextData(body).props?.pageProps?.ad;
  if (!ad) return {};
  const info = new Map<string, string[]>(
    [...(ad.additionalInformation ?? []), ...(ad.topInformation ?? [])].map((x: { label: string; values: string[] }) => [x.label, x.values ?? []]),
  );
  const description = stripHtml(String(ad.description ?? ''));
  const text = factsFromText(`${ad.title ?? ''}\n${description}`);
  const baths = Number(info.get('bathrooms_num')?.[0] ?? ad.target?.Bathrooms_num?.[0]);
  const extras = [...(info.get('extras_types') ?? []), ...(ad.target?.Extras_types ?? [])].join(',');
  const lift = info.get('lift') ?? [];
  const status = (info.get('construction_status')?.[0] ?? '').replace('construction_status::', '');
  const coords = ad.location?.coordinates;
  return {
    bathrooms: Number.isFinite(baths) && baths > 0 ? baths : text.bathrooms,
    garage: /garage/.test(extras) ? true : text.garage,
    elevator: lift.some((v) => /y|yes|true|1/.test(v)) ? true : text.elevator,
    condition: text.condition ?? CONSTRUCTION[status] ?? null,
    lat: typeof coords?.latitude === 'number' ? coords.latitude : null,
    lon: typeof coords?.longitude === 'number' ? coords.longitude : null,
    description: description.slice(0, 1500),
  };
}
