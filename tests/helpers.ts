import type { Listing } from '../src/types.ts';

export function mk(p: Partial<Listing> = {}): Listing {
  const id = p.id ?? `${p.source ?? 'test'}:${p.sourceId ?? Math.random().toString(36).slice(2)}`;
  return {
    id, source: 'test', sourceId: id.split(':')[1], url: `https://example.org/${id}`, title: 'Apartamento T3',
    price: 400000, area_m2: 110, bedrooms: 3, bathrooms: 2, garage: true, floor: '2', elevator: true,
    condition: 'good', neighborhood: 'Alfragide', municipality: 'Amadora', address: null, lat: null, lon: null,
    price_per_m2: 3636, first_seen: '2026-10-01T07:00:00Z', last_seen: '2026-10-07T07:00:00Z', prev_price: null,
    group_id: id, commute_min: 8, commute_approx: false, ...p,
  };
}
