import { expect, test } from '@playwright/test';
import { classify } from '../src/filter.ts';
import { mk } from './helpers.ts';

test.describe('criteria filter', () => {
  test('full match within budget', () => {
    expect(classify(mk()).verdict).toBe('match');
  });
  test('415k < price <= 430k is flagged for negotiation', () => {
    const c = classify(mk({ price: 425000 }));
    expect(c.verdict).toBe('negotiate');
  });
  test('price above 430k is rejected', () => {
    expect(classify(mk({ price: 430001 })).verdict).toBe('reject');
  });
  test('unknown garage goes to manual check, not reject', () => {
    const c = classify(mk({ garage: null }));
    expect(c.verdict).toBe('manual');
    expect(c.reasons).toContain('гараж');
  });
  test('known missing garage is rejected', () => {
    expect(classify(mk({ garage: false })).verdict).toBe('reject');
  });
  test('one bathroom is rejected, unknown bathrooms is manual', () => {
    expect(classify(mk({ bathrooms: 1 })).verdict).toBe('reject');
    expect(classify(mk({ bathrooms: null })).verdict).toBe('manual');
  });
  test('T2 and T4 are rejected', () => {
    expect(classify(mk({ bedrooms: 2 })).verdict).toBe('reject');
    expect(classify(mk({ bedrooms: 4 })).verdict).toBe('reject');
  });
  test('outside target area is rejected; accents do not matter', () => {
    expect(classify(mk({ neighborhood: 'Arroios', municipality: 'Lisboa' })).verdict).toBe('reject');
    expect(classify(mk({ neighborhood: 'Alges', municipality: 'Oeiras' })).verdict).toBe('match');
    expect(classify(mk({ neighborhood: 'Queluz e Belas', municipality: 'Sintra' })).verdict).toBe('match');
  });
  test('commute beyond hard limit is rejected', () => {
    expect(classify(mk({ commute_min: 40 })).verdict).toBe('reject');
  });
});

test.describe('area and commute thresholds', () => {
  test('area below 90 m2 is rejected, unknown area is manual', () => {
    expect(classify(mk({ area_m2: 89 })).verdict).toBe('reject');
    expect(classify(mk({ area_m2: 90 })).verdict).toBe('match');
    expect(classify(mk({ area_m2: null })).verdict).toBe('manual');
  });
  test('commute up to 20 min is not flagged as a minus', async () => {
    const { ruleBasedProsCons } = await import('../src/summarize.ts');
    expect(ruleBasedProsCons(mk({ commute_min: 19 }))).not.toContain('дорога');
    expect(ruleBasedProsCons(mk({ commute_min: 22 }))).toContain('дорога 22 мин');
  });
});

test.describe('location and listing age', () => {
  test('no location at all goes to manual check; Tercena and Benfica are in the area', () => {
    expect(classify(mk({ municipality: null, neighborhood: null, address: null })).verdict).toBe('manual');
    expect(classify(mk({ municipality: 'Oeiras', neighborhood: 'Tercena' })).verdict).toBe('match');
    expect(classify(mk({ municipality: 'Lisboa', neighborhood: 'Benfica' })).verdict).toBe('match');
    expect(classify(mk({ municipality: 'Lisboa', neighborhood: 'Parque das Nações' })).verdict).toBe('reject');
  });
  test('days on market: portal date first, else our first sighting', async () => {
    const { listedLine } = await import('../src/summarize.ts');
    const now = Date.parse('2026-10-07T08:00:00Z');
    expect(listedLine({ listed_since: '2026-09-07T10:00:00Z', first_seen: '2026-10-07T07:00:00Z' }, now)).toBe('📅 в продаже 29 дн.');
    expect(listedLine({ listed_since: '2026-06-01T00:00:00Z', first_seen: '2026-10-07T07:00:00Z' }, now)).toContain('повод торговаться');
    expect(listedLine({ listed_since: null, first_seen: '2026-10-01T07:00:00Z' }, now)).toBe('📅 в продаже ≥ 6 дн. (столько видим мы)');
  });
});
