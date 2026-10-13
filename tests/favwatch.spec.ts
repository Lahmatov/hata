import { expect, test } from '@playwright/test';
import { Store } from '../src/db.ts';
import { favouriteNews } from '../src/favwatch.ts';
import type { RawListing } from '../src/types.ts';

const raw = (p: Partial<RawListing> = {}): RawListing => ({
  source: 'imovirtual', sourceId: 'A1', url: 'https://www.imovirtual.com/pt/anuncio/a1', title: 'T3', price: 400000, area_m2: 110,
  bedrooms: 3, bathrooms: 2, garage: true, floor: null, elevator: null, condition: null, neighborhood: 'Benfica', municipality: 'Lisboa',
  address: null, lat: null, lon: null, ...p,
});

test('favourites news: first look is silent, then cheaper, gone and back', () => {
  const store = new Store(':memory:');
  const day = (d: number) => new Date(Date.parse('2026-10-10T08:00:00Z') + d * 86400_000);
  store.upsert(raw(), day(0).toISOString());
  store.upsert(raw({ sourceId: 'B2', url: 'https://x/b2', neighborhood: 'Carnide', price: 380000 }), day(0).toISOString());
  const gid = store.get('imovirtual:A1')!.group_id;
  store.setReaction(gid, 'like', '1');
  expect(favouriteNews(store, day(0).getTime())).toEqual([]); // records only; B2 is not a favourite

  store.upsert(raw({ price: 385000 }), day(1).toISOString());
  const drop = favouriteNews(store, day(1).getTime());
  expect(drop).toHaveLength(1);
  expect(drop[0]).toContain('подешевела: 400 → 385 тыс. € (−3,8%)');
  expect(favouriteNews(store, day(1).getTime())).toEqual([]); // told once

  expect(favouriteNews(store, day(5).getTime())[0]).toContain('🚫');
  store.upsert(raw({ price: 385000 }), day(6).toISOString());
  expect(favouriteNews(store, day(6).getTime())[0]).toContain('✅');
});
