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
  // Benfica hidden by INE (few sales): no fallback to São Domingos de Benfica, the municipality instead.
  expect(ineMedian({ ...prices, parish: { '1A01106': { 'sao domingos de benfica': 5182 } } }, { municipality: 'Lisboa', neighborhood: 'Benfica' })?.v).toBe(5082);
  expect(ineLine(prices, mk({ municipality: 'Amadora', neighborhood: 'Venteira', price_per_m2: 3457 }))).toBe('📊 сделки в Amadora: 3 143 €/м² (INE, 12 мес.), эта на 10% дороже');
});

test('flood: extent with the shortest return period, else a risk area within 500 m, else nothing', async () => {
  const { floodAt, floodCell, floodLine } = await import('../src/flood.ts');
  const orig = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    const body = String(url).includes('Diretiva200760CE_2c/MapServer/1/')
      ? { features: [{ attributes: { pretorno: 'T100' } }, { attributes: { pretorno: '20' } }] }
      : { features: [{ attributes: { name: 'LOURES E PARTE DE ODIVELAS (TRANCÃO)' } }] };
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  try {
    const f = await floodAt({ lat: 38.7929, lon: -9.1838 });
    expect(f).toEqual({ periods: [20, 100], near: ['LOURES E PARTE DE ODIVELAS (TRANCÃO)'] });
    expect(urls[1]).toContain('distance=500');
    expect(floodLine(f)).toBe('🌊 в зоне затопления APA (паводок раз в 20 лет)');
    expect(floodLine({ periods: [], near: f.near })).toBe('🌊 до 500 м зона риска подтопления: Loures E Parte De Odivelas (Trancão)');
    expect(floodCell({ periods: [], near: [] })).toBe('нет на картах APA');
    expect(floodCell(undefined)).toBe('');
  } finally {
    globalThis.fetch = orig;
  }
});

test('planes: low airborne aircraft only; a track passing between two samples counts once', async () => {
  const { lowAircraft, planeStats, planesLine } = await import('../src/planes.ts');
  const st = (icao: string, lat: number, lon: number, alt: number, ground = false) => [icao, 'TAP1', 'Portugal', 0, 0, lon, lat, alt, ground, 70, 30, -3, null, alt];
  expect(lowAircraft([st('a', 38.75, -9.2, 500), st('b', 38.75, -9.2, 3000), st('c', 38.77, -9.13, 0, true)] as never)).toEqual([['a', 38.75, -9.2, 500]]);
  const flat = { lat: 38.7505, lon: -9.2008 };
  // Plane "x" flies over the flat between two samples 20 s apart (1.4 km each side), at 400 m; "y" stays 3 km away.
  const samples = Array.from({ length: 540 }, (_, i) => ({ t: 1000 + i * 20, e: 20, a: [] as [string, number, number, number][] }));
  samples[10].a.push(['x', 38.7505 - 0.0063, -9.2008 - 0.0063, 420], ['y', 38.78, -9.2, 300]);
  samples[11].a.push(['x', 38.7505 + 0.0063, -9.2008 + 0.0063, 380], ['y', 38.781, -9.2, 300]);
  samples[12].a.push(['x', 38.7505 + 0.019, -9.2008 + 0.019, 300]);
  const s = planeStats(samples, flat);
  expect(s).toEqual({ passes: 1, hours: 3, lowest: 380 });
  expect(planesLine(s)).toBe('✈️ ≈ 0,3 низких пролёта в час, самый низкий ~380 м (до 1 км от дома; 3 ч наблюдений OpenSky)');
  expect(planesLine({ passes: 0, hours: 3, lowest: null })).toBe('✈️ низких пролётов рядом не было (3 ч наблюдений OpenSky)');
  expect(planesLine({ passes: 5, hours: 1, lowest: 300 })).toBeNull();
});

test('overpass: a 200 answer with a runtime-error remark is not stored as "nothing nearby"', async () => {
  const { Store } = await import('../src/db.ts');
  const { cachedNearby, fillNearby } = await import('../src/nearby.ts');
  const store = new Store(':memory:');
  const p = { lat: 38.75, lon: -9.2 };
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ remark: 'runtime error: Query timed out in "query" at line 3', elements: [] }))) as typeof fetch;
  try {
    expect(await fillNearby(store, [p], 5)).toBe(0);
    expect(cachedNearby(store, p)).toBeUndefined(); // asked again on the next run
  } finally {
    globalThis.fetch = orig;
  }
});

test('nominatim: after a 429 the run stops geocoding (blocked), and nothing is cached', async () => {
  const { Store } = await import('../src/db.ts');
  const { geocode } = await import('../src/geo.ts');
  const store = new Store(':memory:');
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response('slow down', { status: 429 }); }) as typeof fetch;
  try {
    expect(await geocode(store, 'Rua A, Benfica')).toBeNull();
    expect(await geocode(store, 'Rua B, Carnide')).toBeNull();
    expect(calls).toBe(1); // no retries, no second address
    expect(store.kvGet('geo:rua a, benfica')).toBeUndefined();
  } finally {
    globalThis.fetch = orig;
  }
});

test('planes: a line cut short in the samples file is skipped, not fatal', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadSamples } = await import('../src/planes.ts');
  const file = join(mkdtempSync(join(tmpdir(), 'planes-')), 'planes.jsonl');
  const now = Date.parse('2026-10-13T12:00:00Z');
  writeFileSync(file, `${JSON.stringify({ t: now / 1000 - 60, e: 0, a: [] })}\n{"t":17604`);
  expect(loadSamples(file, now)).toHaveLength(1);
});
