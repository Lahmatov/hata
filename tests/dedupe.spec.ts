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

test('alert e-mail flat (place name only) matches the portal flat it repeats', () => {
  const portal = mk({ id: 'imovirtual:1', source: 'imovirtual', neighborhood: 'Algueirão-Mem Martins', municipality: 'Sintra',
    lat: 38.7999, lon: -9.334, address: null, price: 380000, area_m2: 161.45 });
  const mail = mk({ id: 'idealista:9', source: 'idealista', neighborhood: 'Algueirao', municipality: null, address: null,
    lat: null, lon: null, price: 380000, area_m2: 161 });
  expect(sameProperty(portal, mail)).toBe(true);
  // A different flat in the same parish: other area.
  expect(sameProperty(portal, { ...mail, area_m2: 175 })).toBe(false);
  // Only the municipality in common: numbers must be near-identical.
  const wide = mk({ id: 'idealista:8', source: 'idealista', neighborhood: 'Sintra', municipality: null, address: null, lat: null, lon: null, price: 380000, area_m2: 161.45 });
  expect(sameProperty(portal, wide)).toBe(true);
  expect(sameProperty(portal, { ...wide, price: 383000 })).toBe(false);
});
