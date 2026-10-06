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

test.describe('Idealista API adapter', () => {
  test('maps API elements; parking counts only when included in price', async () => {
    const { parseIdealista } = await import('../src/adapters/idealista.ts');
    const ls = parseIdealista(JSON.parse(fx('idealista-search.json')));
    expect(ls[0]).toMatchObject({ sourceId: '34000001', price: 410000, bedrooms: 3, bathrooms: 2, garage: true, elevator: true, condition: 'good' });
    expect(ls[1].garage).toBe(false);
    expect(ls[2]).toMatchObject({ garage: null, condition: 'needs_renovation' });
  });
});

test.describe('Casa Sapo adapter', () => {
  test('search page: real URL from click counter, apartments only, tags, condition, geo', async () => {
    const { casasapo } = await import('../src/adapters/casasapo.ts');
    const ls = casasapo.parse(fx('casasapo-search.html'), '');
    expect(ls).toHaveLength(2);
    expect(ls[0]).toMatchObject({
      url: 'https://casa.sapo.pt/comprar-apartamento-t3-amadora-aaaaaaaa-1111-11f1-9e61-060000000001.html',
      sourceId: 'aaaaaaaa-1111-11f1-9e61-060000000001', price: 399000, area_m2: 112, bedrooms: 3, garage: true,
      bathrooms: 2, elevator: true, condition: 'good', neighborhood: 'Alfragide', municipality: 'Amadora',
      address: 'Rua das Flores', lat: 38.736, lon: -9.225,
    });
    expect(ls[1]).toMatchObject({ garage: null, condition: 'new', neighborhood: 'Queluz e Belas', municipality: 'Sintra' });
  });
  test('pagination follows pn links only while they exist', async () => {
    const { casasapo } = await import('../src/adapters/casasapo.ts');
    const url = 'https://casa.sapo.pt/comprar-apartamentos/t3/amadora/';
    expect(casasapo.nextPageUrl!(fx('casasapo-search.html'), url, 1)).toBe(`${url}?pn=2`);
    expect(casasapo.nextPageUrl!(fx('casasapo-search.html'), url, 2)).toBeNull();
  });
  test('detail page: labelled fields and coordinates', async () => {
    const { parseDetail } = await import('../src/adapters/casasapo.ts');
    const base = { bathrooms: null, garage: null, elevator: null, condition: null, lat: null, lon: null };
    expect(parseDetail(fx('casasapo-detail.html'), base)).toMatchObject({
      bathrooms: 2, garage: true, elevator: true, floor: '3', condition: 'good', lat: 38.7833, lon: -9.2336,
    });
  });
});

test.describe('Trovit adapter', () => {
  test('snippets + JSON-LD bedrooms/bathrooms, price and area from text', async () => {
    const { trovit } = await import('../src/adapters/trovit.ts');
    const ls = trovit.parse(fx('trovit-search.html'), 'https://casa.trovit.pt/t3-municipio-amadora');
    expect(ls[0]).toMatchObject({
      source: 'trovit', sourceId: 'tv1', price: 395000, area_m2: 110, bedrooms: 3, bathrooms: 2, garage: true,
      municipality: 'Amadora', url: 'https://casa.trovit.pt/listing/apartamento-1.html?origin=1',
    });
    expect(ls[1]).toMatchObject({ bedrooms: 2, bathrooms: 1 });
  });
});
