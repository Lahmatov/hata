import { expect, test } from '@playwright/test';
import { featuresFromText, featuresList } from '../src/adapters/text.ts';
import { Store } from '../src/db.ts';
import { classify } from '../src/filter.ts';
import { score } from '../src/score.ts';
import { tableRow } from '../src/table.ts';
import { buildCatalogue } from '../src/worker-sync.ts';
import { type Catalogue, favDeck, favouritesTable, type KV } from '../worker/index.ts';
import { TABLE_COLS } from '../worker/table.ts';
import { colName, xlsx } from '../worker/xlsx.ts';
import { mk } from './helpers.ts';

function memKV(init: Record<string, unknown> = {}, reactions: [string, string, string][] = []): KV {
  const data = new Map<string, { v: string; metadata?: unknown }>(Object.entries(init).map(([k, v]) => [k, { v: JSON.stringify(v) }]));
  for (const [kind, chat, gid] of reactions) data.set(`v:${chat}:${gid}`, { v: '1', metadata: { kind, at: '' } });
  return {
    async get(k) { const e = data.get(k); return e ? JSON.parse(e.v) : null; },
    async put(k, v, o) { data.set(k, { v, metadata: o?.metadata }); },
    async delete(k) { data.delete(k); },
    async list({ prefix }) { return { keys: [...data].filter(([k]) => k.startsWith(prefix)).map(([name, e]) => ({ name, metadata: e.metadata })), list_complete: true }; },
  };
}

/** Reads the entries of a zip with stored (uncompressed) entries. */
function unzip(buf: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let at = 0; dv.getUint32(at, true) === 0x04034b50;) {
    const size = dv.getUint32(at + 18, true);
    const nameLen = dv.getUint16(at + 26, true);
    const name = new TextDecoder().decode(buf.subarray(at + 30, at + 30 + nameLen));
    out.set(name, new TextDecoder().decode(buf.subarray(at + 30 + nameLen, at + 30 + nameLen + size)));
    at += 30 + nameLen + size;
  }
  return out;
}

test.describe('rating and favourites table', () => {
  test('extras from Portuguese ad text; absent means "not mentioned"', () => {
    const f = featuresFromText('Apartamento T3 com varanda, ar condicionado e arrecadação. Duas suítes. Certificado energético: B-. Construído em 2004. Condomínio fechado com piscina.');
    expect(f).toMatchObject({ balcony: true, ac: true, storage: true, pool: true, closedCondo: true, suites: 2, energy: 'B-', year: 2004, terrace: false });
    expect(featuresList(f)).toEqual(['балкон', 'бассейн', 'кондиционер', 'кладовка', 'закрытый комплекс', '2 спальни с санузлом']);
    expect(featuresFromText(null)).toMatchObject({ balcony: false, energy: null, year: null, suites: null });
    expect(featuresFromText('Classe energética C').energy).toBe('C');
  });

  test('score: cheaper and closer ranks higher; parts add up to the total; unknowns are middling', () => {
    const pool = Array.from({ length: 8 }, () => mk({ price_per_m2: 3600 }));
    const good = score(mk({ price: 350000, commute_min: 9, area_m2: 130, price_per_m2: 2700, condition: 'renovated', bathrooms: 3, description: 'varanda, arrecadação' }), pool);
    const bad = score(mk({ price: 428000, commute_min: 34, area_m2: 90, price_per_m2: 4700, condition: 'needs_renovation', elevator: false }), pool);
    const unknown = score(mk({ price: null, commute_min: null, area_m2: null, price_per_m2: null, condition: null, elevator: null }), pool);
    expect(good.total).toBeGreaterThan(90);
    expect(bad.total).toBeLessThan(15);
    expect(unknown.total).toBeGreaterThan(bad.total);
    expect(unknown.total).toBeLessThan(good.total);
    for (const s of [good, bad, unknown]) {
      expect(s.parts.reduce((a, p) => a + p[1], 0)).toBe(s.total);
      expect(s.parts.reduce((a, p) => a + p[2], 0)).toBe(100);
    }
    expect(good.text).toContain('цена 25/25 · дорога 25/25');
  });

  test('a table row has a cell for every column, with links and the price history', () => {
    const l = mk({ price: 395000, description: 'Com terraço e lareira.', listed_since: '2026-09-01T00:00:00Z' });
    const other = mk({ group_id: l.group_id, source: 'idealista', url: 'https://www.idealista.pt/imovel/1/' });
    const row = tableRow(l, classify(l), score(l, []), { members: [l, other], prices: [420000, 395000], school: { lat: 38.7, lon: -9.2 }, now: Date.parse('2026-10-11T00:00:00Z') });
    expect(row).toHaveLength(TABLE_COLS.length);
    const at = (h: string) => row[TABLE_COLS.findIndex((c) => c.h === h)];
    expect(at('Цена')).toBe(395000);
    expect(at('История цены')).toBe('420 → 395 тыс.');
    expect(at('Удобства (из текста)')).toBe('терраса, камин');
    expect(at('В продаже, дней')).toBe(40);
    expect(at('Объявление')).toEqual({ u: l.url, t: 'открыть' });
    expect(at('Где ещё опубликовано')).toBe('Idealista: https://www.idealista.pt/imovel/1/');
    expect((at('Маршрут') as { u: string }).u).toContain('google.com/maps/dir');
  });

  test('favourites deck: either person\'s likes, minus my 👎, best rating first, with who liked it', () => {
    const s = new Date().toISOString();
    const item = (q: number) => ({ t: 'x', u: 'u', p: 1, a: 1, c: 10, s, m: [], q });
    const cat: Catalogue = { a: item(50), b: item(80), c: item(70), d: item(90), e: item(60) };
    const d = favDeck(cat, [
      { kind: 'like', chat: '1', gid: 'a' }, { kind: 'like', chat: '2', gid: 'b' }, { kind: 'super', chat: '1', gid: 'c' },
      { kind: 'hide', chat: '1', gid: 'd' }, { kind: 'like', chat: '2', gid: 'd' }, { kind: 'hide', chat: '2', gid: 'e' },
    ], '1');
    expect(d.map((c) => [c.id, c.me, c.ot])).toEqual([['b', undefined, 'like'], ['c', 'super', undefined], ['a', 'like', undefined]]);
  });

  test('favourites table: rated rows of what either liked, each person\'s verdict in front; old flats get the basics', async () => {
    const s = new Date().toISOString();
    const cat: Catalogue = {
      g1: { t: 'Benfica', u: 'https://x/1', p: 400000, a: 100, c: 12, s, m: [], n: 0, q: 60 },
      g2: { t: 'Carnide', u: 'https://x/2', p: 380000, a: 110, c: 8, s, m: [], n: 0, q: 85 },
      g3: { t: 'Amadora', u: 'https://x/3', p: 390000, a: 95, c: 15, s, m: [] },
      g4: { t: 'Sintra', u: 'https://x/4', p: 300000, a: 95, c: 30, s, m: [], q: 99 },
    };
    const row = (q: number) => [q, ...TABLE_COLS.slice(1).map(() => 'v')];
    const kv = memKV({ catalogue: cat, 'rows:0': { g1: row(60), g2: row(85) } },
      [['like', '1', 'g1'], ['super', '2', 'g2'], ['hide', '1', 'g2'], ['like', '2', 'g3'], ['hide', '1', 'g4']]);
    const { cols, rows } = await favouritesTable(kv, { 1: 'Женя', 2: 'Маша' });
    expect(cols.slice(0, 3).map((c) => c.h)).toEqual(['№', 'Женя', 'Маша']);
    expect(cols).toHaveLength(TABLE_COLS.length + 3);
    expect(rows.map((r) => r.slice(0, 4))).toEqual([[1, '👎 нет', '🌟 супер', 85], [2, '👍 да', '—', 60], [3, '—', '👍 да', null]]);
    for (const r of rows) expect(r).toHaveLength(cols.length);
    expect(rows[2][3 + TABLE_COLS.findIndex((c) => c.h === 'Район')]).toBe('Amadora');
  });

  test('xlsx: a valid zip with header, formats and clickable links', () => {
    expect([0, 25, 26, 27, 51, 52].map(colName)).toEqual(['A', 'Z', 'AA', 'AB', 'AZ', 'BA']);
    const file = xlsx('Избранное', [{ h: 'Цена', f: 'eur' }, { h: 'Ссылка', f: 'link' }, { h: 'Текст', f: 'wrap' }],
      [[395000, { u: 'https://x/?a=1&b=2', t: 'открыть' }, 'a <b> & "c"'], [null, '', 'ok']]);
    const files = unzip(file);
    expect([...files.keys()]).toContain('xl/worksheets/_rels/sheet1.xml.rels');
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<c r="A2" s="2"><v>395000</v></c>');
    expect(sheet).toContain('a &lt;b&gt; &amp; &quot;c&quot;');
    expect(sheet).toContain('<hyperlink ref="B2" r:id="rId1"/>');
    expect(sheet).toContain('<autoFilter ref="A1:C3"/>');
    expect(files.get('xl/worksheets/_rels/sheet1.xml.rels')).toContain('Target="https://x/?a=1&amp;b=2"');
  });

  test('catalogue push carries the rating, extras and a spreadsheet row per flat', () => {
    const store = new Store(':memory:');
    const now = new Date().toISOString();
    store.upsert({ source: 'imovirtual', sourceId: 'A1', url: 'https://www.imovirtual.com/pt/anuncio/a1', title: 'T3', price: 390000, area_m2: 120,
      bedrooms: 3, bathrooms: 2, garage: true, floor: '3', elevator: true, condition: 'good', neighborhood: 'Benfica', municipality: 'Lisboa',
      address: null, lat: null, lon: null, description: 'Com varanda.' }, now);
    store.setCommute('imovirtual:A1', 14, false);
    store.markNotified('imovirtual:A1', 390000);
    const gid = store.get('imovirtual:A1')!.group_id;
    const { catalogue, cards, rows } = buildCatalogue(store);
    expect(catalogue[gid].q).toBeGreaterThan(40);
    expect(cards[0][gid].e).toEqual(['балкон']);
    expect(cards[0][gid].y).toContain('дорога');
    expect(rows[0][gid]).toHaveLength(TABLE_COLS.length);
  });
});
