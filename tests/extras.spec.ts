import { expect, test } from '@playwright/test';
import { dealNote, historyNote, routeUrl } from '../src/extras.ts';
import { mk } from './helpers.ts';

test.describe('deal, price history, route', () => {
  const pool = [3500, 3600, 3700, 3800, 3900, 4000, 4100].map((ppm, i) => mk({ id: `p:${i}`, neighborhood: 'Alfragide', price_per_m2: ppm }));

  test('flags flats clearly below the local median €/m²', () => {
    const cheap = mk({ id: 'x:1', neighborhood: 'Alfragide', price_per_m2: 3000 });
    expect(dealNote(cheap, pool)).toMatch(/^🔥 на 21% дешевле среднего по Alfragide/);
    expect(dealNote(mk({ id: 'x:2', neighborhood: 'Alfragide', price_per_m2: 3700 }), pool)).toBeNull();
  });
  test('falls back to the municipality when the parish has too few flats', () => {
    const l = mk({ id: 'x:3', neighborhood: 'Tercena', municipality: 'Amadora', price_per_m2: 3000 });
    expect(dealNote(l, pool)).toContain('по Amadora');
  });
  test('price history only when the price changed', () => {
    expect(historyNote([440000, 425000, 415000])).toBe('💶 история цены: 440 → 425 → 415 тыс.');
    expect(historyNote([415000])).toBeNull();
  });
  test('route link uses coordinates, else the address', () => {
    const school = { lat: 38.735766, lon: -9.226091 };
    expect(routeUrl(mk({ lat: 38.75, lon: -9.23 }), school)).toBe(
      'https://www.google.com/maps/dir/?api=1&origin=38.75%2C-9.23&destination=38.735766%2C-9.226091&travelmode=driving');
    expect(routeUrl(mk({ lat: null, lon: null, address: 'Rua X 1', neighborhood: 'Alfragide', municipality: 'Amadora' }), school))
      .toContain('origin=Rua+X+1%2C+Alfragide%2C+Amadora%2C+Portugal');
    expect(routeUrl(mk(), null)).toBeNull();
  });
});

test('price comparison: a flat on three portals counts once, and never as its own peer', async () => {
  const { comparablePool, localMedian } = await import('../src/extras.ts');
  const self = ['a', 'b', 'c'].map((s) => mk({ id: `${s}:1`, group_id: 'a:1', neighborhood: 'Benfica', price_per_m2: 4000 }));
  const others = [1, 2, 3, 4].map((i) => mk({ id: `o:${i}`, neighborhood: 'Benfica', price_per_m2: 5000 }));
  const small = mk({ id: 's:1', neighborhood: 'Benfica', price_per_m2: 1000, bedrooms: 2 });
  const pool = comparablePool([...self, ...others, small]);
  expect(pool.map((l) => l.id)).toEqual(['a:1', 'o:1', 'o:2', 'o:3', 'o:4']);
  // 4 real peers in Benfica are too few: the municipality instead (the same 4, still without the flat itself).
  expect(localMedian(self[1], pool)).toBeNull();
  expect(localMedian(self[1], [...pool, ...[5, 6].map((i) => mk({ id: `o:${i}`, neighborhood: 'Benfica', price_per_m2: 5000 }))])?.n).toBe(6);
});
