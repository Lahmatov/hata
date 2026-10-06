import { config } from '../config.ts';
import { log } from '../log.ts';
import type { Adapter, Condition, RawListing } from '../types.ts';

// Official idealista Search API (https://developers.idealista.com). Needs an approved key + secret.
// One search per day around the school, newest first; a monthly quota guard keeps us inside the plan.
const API = 'https://api.idealista.com';
const MONTHLY_QUOTA = Number(process.env.IDEALISTA_MONTHLY_QUOTA ?? 90);
const RADIUS_M = Number(process.env.IDEALISTA_RADIUS_M ?? 9000);

interface Element {
  propertyCode: string; url: string; price?: number; size?: number; rooms?: number; bathrooms?: number;
  floor?: string; hasLift?: boolean; status?: string; address?: string; neighborhood?: string; district?: string;
  municipality?: string; latitude?: number; longitude?: number; description?: string; suggestedTexts?: { title?: string };
  parkingSpace?: { hasParkingSpace?: boolean; isParkingSpaceIncludedInPrice?: boolean };
  propertyType?: string;
}

const STATUS: Record<string, Condition> = { good: 'good', renew: 'needs_renovation', newdevelopment: 'new' };

/** Pure mapping of an API response (tested with a fixture). */
export function parseIdealista(json: { elementList?: Element[] }): RawListing[] {
  return (json.elementList ?? []).map((e) => ({
    source: 'idealista',
    sourceId: e.propertyCode,
    url: e.url,
    title: e.suggestedTexts?.title ?? `${e.propertyType ?? 'Apartamento'} T${e.rooms ?? '?'}`,
    price: e.price ?? null,
    area_m2: e.size ?? null,
    bedrooms: e.rooms ?? null,
    bathrooms: e.bathrooms ?? null,
    // Parking only counts if it is included in the price.
    garage: e.parkingSpace ? !!(e.parkingSpace.hasParkingSpace && e.parkingSpace.isParkingSpaceIncludedInPrice) : null,
    floor: e.floor ?? null,
    elevator: e.hasLift ?? null,
    condition: e.status ? (STATUS[e.status] ?? null) : null,
    neighborhood: e.neighborhood ?? e.district ?? null,
    municipality: e.municipality ?? null,
    address: e.address ?? null,
    lat: e.latitude ?? null,
    lon: e.longitude ?? null,
    description: e.description ?? null,
  }));
}

async function token(key: string, secret: string): Promise<string> {
  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${encodeURIComponent(key)}:${encodeURIComponent(secret)}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body: 'grant_type=client_credentials&scope=read',
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`idealista oauth HTTP ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

export const idealista: Adapter = {
  id: 'idealista',
  name: 'Idealista (API)',
  enabled: () => Boolean(process.env.IDEALISTA_API_KEY && process.env.IDEALISTA_API_SECRET),
  searchUrls: () => [],
  parse: () => [],

  async fetchAll({ kvGet, kvSet }) {
    const month = new Date().toISOString().slice(0, 7);
    const used = kvGet<number>(`idealista:quota:${month}`) ?? 0;
    if (used + 2 > MONTHLY_QUOTA) {
      log.warn(`idealista: monthly quota guard reached (${used}/${MONTHLY_QUOTA}), skipping`);
      return [];
    }
    const school = kvGet<{ lat: number; lon: number }>(`geo:${config.school.address.toLowerCase()}`)
      ?? (config.school.lat !== null ? { lat: config.school.lat, lon: config.school.lon! } : null);
    if (!school) throw new Error('school coordinates unknown yet (set SCHOOL_LAT/SCHOOL_LON or run once)');

    const t = await token(process.env.IDEALISTA_API_KEY!, process.env.IDEALISTA_API_SECRET!);
    const params = new URLSearchParams({
      operation: 'sale', propertyType: 'homes', center: `${school.lat},${school.lon}`, distance: String(RADIUS_M),
      maxPrice: String(config.criteria.maxPriceNegotiable), bedrooms: String(config.criteria.bedrooms),
      maxItems: '50', numPage: '1', order: 'publicationDate', sort: 'desc', language: 'pt',
    });
    const res = await fetch(`${API}/3.5/pt/search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(30000),
    });
    kvSet(`idealista:quota:${month}`, used + 2); // token + search
    if (!res.ok) throw new Error(`idealista search HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return parseIdealista(await res.json() as { elementList?: Element[] });
  },
};
