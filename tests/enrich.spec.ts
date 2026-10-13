import { expect, test } from '@playwright/test';
import { ineLine, ineMedian, type InePrices } from '../src/ine.ts';
import { nearbyLine, nearestOf, overpassQuery } from '../src/nearby.ts';
import { mk } from './helpers.ts';

test('nearby: closest of each kind, named stations only, short line', () => {
  const p = { lat: 38.7505, lon: -9.2008 };
  const n = nearestOf(p, [
    { lat: 38.7443704, lon: -9.1996207, tags: { railway: 'station', name: 'Benfica' } },
    { lat: 38.7506, lon: -9.2009, tags: { railway: 'station' } }, // unnamed siding: ignored
    { center: { lat: 38.7496103, lon: -9.2040783 }, tags: { shop: 'supermarket', name: 'Pingo Doce' } },
    { lat: 38.7460968, lon: -9.2059045, tags: { shop: 'supermarket', name: 'Lidl' } },
    { lat: 38.750655, lon: -9.2008027, tags: { amenity: 'pharmacy', name: 'Farmácia Marques' } },
    { center: { lat: 38.7485531, lon: -9.2046029 }, tags: { leisure: 'park', name: 'Parque Silva Porto' } },
  ]);
  expect(n.station?.name).toBe('Benfica');
  expect(n.supermarket?.name).toBe('Pingo Doce');
  expect(n.playground).toBeUndefined();
  expect(nearbyLine(n)).toBe('🚇 Benfica 690 м · 🛒 Pingo Doce 300 м · 💊 20 м · 🌳 Parque Silva Porto 390 м (по прямой)');
  expect(overpassQuery(p)).toContain('nwr(around:1200,38.7505,-9.2008)[station=subway];');
  expect(nearbyLine(undefined)).toBeNull();
});

test('INE: parish median when published, else the municipality; the gap in percent', () => {
  const prices: InePrices = { period: '1.º Trimestre de 2026', muni: { '1A01115': 3143, '1A01106': 5082 }, parish: { '1A01106': { 'sao domingos de benfica': 5182, benfica: 4500 }, '1A01110': { 'uniao das freguesias de carnaxide e queijas': 3988 } } };
  expect(ineMedian(prices, { municipality: 'Lisboa', neighborhood: 'Benfica' })).toEqual({ v: 4500, where: 'Benfica' });
  expect(ineMedian(prices, { municipality: 'Amadora', neighborhood: 'Venteira' })).toEqual({ v: 3143, where: 'Amadora' });
  expect(ineMedian({ ...prices, muni: { ...prices.muni, '1A01110': 4297 } }, { municipality: 'Oeiras', neighborhood: 'Carnaxide e Queijas' })?.v).toBe(3988);
  expect(ineMedian(prices, { municipality: 'Cascais', neighborhood: 'Parede' })).toBeNull();
  expect(ineLine(prices, mk({ municipality: 'Amadora', neighborhood: 'Venteira', price_per_m2: 3457 }))).toBe('📊 сделки в Amadora: 3 143 €/м² (INE, 12 мес.), эта на 10% дороже');
});
