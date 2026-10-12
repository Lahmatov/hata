import { expect, test } from '@playwright/test';
import { favouritesText } from '../src/bot.ts';
import { Store } from '../src/db.ts';
import type { RawListing } from '../src/types.ts';

const raw = (sourceId: string, p: Partial<RawListing> = {}): RawListing => ({
  source: 'imovirtual', sourceId, url: `https://www.imovirtual.com/pt/anuncio/x-${sourceId}`, title: `Apartamento T3 ${sourceId}`,
  price: 400000, area_m2: 100, bedrooms: 3, bathrooms: 2, garage: true, floor: null, elevator: null, condition: null,
  neighborhood: 'Alfragide', municipality: 'Amadora', address: null, lat: null, lon: null, ...p,
});

test.describe('favourites on demand', () => {
  test('lists 👍 flats still on sale, closest first, and counts the ones gone', () => {
    const store = new Store(':memory:');
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 10 * 86400_000).toISOString();
    store.upsert(raw('IDa', { price: 410000 }), now);
    store.upsert(raw('IDb', { neighborhood: 'Carnaxide', municipality: 'Oeiras', price: 380000 }), now);
    store.upsert(raw('IDc'), old);
    store.upsert(raw('IDd'), now);
    store.setCommute('imovirtual:IDa', 12, false);
    store.setCommute('imovirtual:IDb', 5, false);
    for (const id of ['IDa', 'IDb', 'IDc']) store.setReaction(`imovirtual:${id}`, 'like', '1');

    const text = favouritesText(store)!;
    expect(text).toContain('⭐ <b>Избранное</b>: 2');
    expect(text.indexOf('Carnaxide')).toBeLessThan(text.indexOf('Alfragide'));
    expect(text).toContain('380 тыс. € · 100 м² · 🚗 5 мин');
    expect(text).toContain('ещё 1 из избранного уже сняты');
    expect(text).not.toContain('IDd');
  });

  test('nothing liked: null', () => {
    expect(favouritesText(new Store(':memory:'))).toBeNull();
  });
});
