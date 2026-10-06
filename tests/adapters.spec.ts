import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { custojusto, parseDetail as cjDetail } from '../src/adapters/custojusto.ts';
import { imovirtual, parseDetail as imoDetail } from '../src/adapters/imovirtual.ts';

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test.describe('Imovirtual adapter', () => {
  test('search page: flats only, rooms_num-1 = bedrooms, hidden price = null', () => {
    const ls = imovirtual.parse(fx('imovirtual-search.html'), '');
    expect(ls).toHaveLength(2);
    expect(ls[0]).toMatchObject({
      source: 'imovirtual', sourceId: '101', price: 398600, area_m2: 110, bedrooms: 3, floor: '3',
      neighborhood: 'Alfragide', municipality: 'Amadora', address: 'Rua Elias Garcia 12',
      url: 'https://www.imovirtual.com/pt/anuncio/apartamento-t3-com-garagem-box-ID1aaa',
    });
    expect(ls[1].price).toBeNull();
  });
  test('pagination stops at totalPages', () => {
    const url = 'https://www.imovirtual.com/pt/resultados/comprar/apartamento,t3/lisboa/amadora?priceMax=430000';
    expect(imovirtual.nextPageUrl!(fx('imovirtual-search.html'), url, 1)).toContain('page=2');
    expect(imovirtual.nextPageUrl!(fx('imovirtual-search.html'), url, 3)).toBeNull();
  });
  test('detail page: bathrooms, garage from extras, "sem elevador" from text, coords', () => {
    expect(imoDetail(fx('imovirtual-detail.html'))).toMatchObject({
      bathrooms: 2, garage: true, elevator: false, condition: 'good', lat: 38.7338, lon: -9.2209,
    });
  });
});

test.describe('CustoJusto adapter', () => {
  test('search page: sales only, T-number and size parsed, facts from text', () => {
    const ls = custojusto.parse(fx('custojusto-search.html'), '');
    expect(ls.map((l) => l.sourceId)).toEqual(['9001', '9003']);
    expect(ls[0]).toMatchObject({ bedrooms: 3, area_m2: 112, bathrooms: 2, garage: true, condition: 'renovated', neighborhood: 'Alfragide' });
    expect(ls[1]).toMatchObject({ area_m2: 98.5, garage: null, municipality: 'Sintra', neighborhood: 'Queluz e Belas' });
  });
  test('detail page: full text facts and coordinates', () => {
    const base = { bathrooms: null, garage: null, elevator: null, condition: null };
    expect(cjDetail(fx('custojusto-detail.html'), base)).toMatchObject({
      bathrooms: 2, garage: false, elevator: true, floor: '4', lat: 38.756, lon: -9.254,
    });
  });
});

// Optional: real pages captured locally with `npm run fixtures:capture`.
for (const [name, adapter] of [['imovirtual', imovirtual], ['custojusto', custojusto]] as const) {
  const file = new URL(`./fixtures/real/${name}-search.html`, import.meta.url);
  test(`${name}: real captured page still parses`, () => {
    test.skip(!existsSync(file), 'no real fixture captured');
    const ls = adapter.parse(readFileSync(file, 'utf8'), '');
    expect(ls.length).toBeGreaterThan(0);
    for (const l of ls) {
      expect(l.url).toMatch(/^https:\/\//);
      expect(l.price === null || l.price > 10000).toBeTruthy();
    }
  });
}
