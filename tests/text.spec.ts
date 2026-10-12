import { expect, test } from '@playwright/test';
import { bedroomsFromT, factsFromText } from '../src/adapters/text.ts';
import { robotsAllows, looksBlocked } from '../src/http.ts';

test.describe('text facts', () => {
  test('bathrooms, garage, elevator, condition from Portuguese text', () => {
    const f = factsFromText('Apartamento T3 totalmente remodelado, 2 casas de banho, lugar de garagem e elevador.');
    expect(f).toEqual({ bathrooms: 2, garage: true, elevator: true, condition: 'renovated' });
  });
  test('negations', () => {
    const f = factsFromText('T3 sem garagem, sem elevador, para recuperar');
    expect(f.garage).toBe(false);
    expect(f.elevator).toBe(false);
    expect(f.condition).toBe('needs_renovation');
  });
  test('silence stays unknown', () => {
    expect(factsFromText('Bonito apartamento com vista')).toEqual({ bathrooms: null, garage: null, elevator: null, condition: null });
  });
  test('T-number', () => {
    expect(bedroomsFromT('Apartamento T3+1 em Alfragide')).toBe(3);
    expect(bedroomsFromT('Moradia')).toBeNull();
  });
});

test.describe('politeness', () => {
  test('robots.txt matcher', () => {
    const r = 'User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /comprar\nAllow: /comprar/apartamento\nDisallow: /*?page=\n';
    expect(robotsAllows(r, '/comprar')).toBe(false);
    expect(robotsAllows(r, '/comprar/apartamento/x')).toBe(true);
    expect(robotsAllows(r, '/a?page=2')).toBe(false);
    expect(robotsAllows('', '/x')).toBe(true);
  });
  test('block detection: status codes and small interstitials only', () => {
    expect(looksBlocked(429, '')).toBe('HTTP 429');
    expect(looksBlocked(200, '<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x">')).toMatch(/challenge/);
    expect(looksBlocked(200, 'x'.repeat(100000) + 'g-recaptcha')).toBeNull();
  });
});
