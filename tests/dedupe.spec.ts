import { expect, test } from '@playwright/test';
import { groupDuplicates, sameProperty } from '../src/dedupe.ts';
import { mk } from './helpers.ts';

test.describe('cross-portal dedupe', () => {
  test('same address, area and price within 3% are one property', () => {
    const a = mk({ id: 'imovirtual:1', source: 'imovirtual', address: 'Rua Elias Garcia 10', price: 400000, area_m2: 110 });
    const b = mk({ id: 'custojusto:9', source: 'custojusto', address: 'Rua Elias Garcia, 10', price: 410000, area_m2: 112 });
    expect(sameProperty(a, b)).toBe(true);
  });
  test('price difference above 3% is not a duplicate', () => {
    const a = mk({ id: 'a:1', address: 'Rua X 1', price: 400000 });
    const b = mk({ id: 'b:1', address: 'Rua X 1', price: 420000 });
    expect(sameProperty(a, b)).toBe(false);
  });
  test('close coordinates match when there is no address', () => {
    const a = mk({ id: 'a:1', lat: 38.7338, lon: -9.2209 });
    const b = mk({ id: 'b:1', lat: 38.7342, lon: -9.2212 });
    expect(sameProperty(a, b)).toBe(true);
  });
  test('group leader is the earliest seen listing', () => {
    const a = mk({ id: 'imovirtual:1', source: 'imovirtual', address: 'Rua X 1', first_seen: '2026-10-02T00:00:00Z' });
    const b = mk({ id: 'custojusto:1', source: 'custojusto', address: 'Rua X 1', first_seen: '2026-10-01T00:00:00Z' });
    const c = mk({ id: 'custojusto:2', source: 'custojusto', address: 'Rua Y 5' });
    const g = groupDuplicates([a, b, c]);
    expect(g.get('imovirtual:1')).toBe('custojusto:1');
    expect(g.get('custojusto:2')).toBe('custojusto:2');
  });
});

test('same portal: exact re-post is grouped, similar flats are not', () => {
  const a = mk({ id: 'imovirtual:1', source: 'imovirtual', neighborhood: 'Encosta do Sol', price: 350000, area_m2: 104 });
  const b = mk({ id: 'imovirtual:2', source: 'imovirtual', neighborhood: 'Encosta do Sol', price: 350000, area_m2: 104 });
  const c = mk({ id: 'imovirtual:3', source: 'imovirtual', neighborhood: 'Encosta do Sol', price: 351000, area_m2: 104 });
  const g = groupDuplicates([a, b, c]);
  expect(g.get('imovirtual:2')).toBe(g.get('imovirtual:1'));
  expect(g.get('imovirtual:3')).toBe('imovirtual:3');
});
