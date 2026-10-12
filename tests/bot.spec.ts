import { expect, test } from '@playwright/test';
import { favouritesText } from '../src/bot.ts';
import { Store } from '../src/db.ts';
import type { RawListing } from '../src/types.ts';

const raw = (sourceId: string, p: Partial<RawListing> = {}): RawListing => ({
  source: 'imovirtual', sourceId, url: `https://www.imovirtual.com/pt/anuncio/x-${sourceId}`, title: `Apartamento T3 ${sourceId}`,
  price: 400000, area_m2: 100, bedrooms: 3, bathrooms: 2, garage: true, floor: null, elevator: null, condition: null,
  neighborhood: 'Alfragide', municipality: 'Amadora', address: null, lat: null, lon: null, ...p,
});

test.describe('favourites on demand', () => {
  test('lists 👍 flats still on sale, closest first, and counts the ones gone', () => {
    const store = new Store(':memory:');
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 10 * 86400_000).toISOString();
    store.upsert(raw('IDa', { price: 410000 }), now);
    store.upsert(raw('IDb', { neighborhood: 'Carnaxide', municipality: 'Oeiras', price: 380000 }), now);
    store.upsert(raw('IDc'), old);
    store.upsert(raw('IDd'), now);
    store.setCommute('imovirtual:IDa', 12, false);
    store.setCommute('imovirtual:IDb', 5, false);
    for (const id of ['IDa', 'IDb', 'IDc']) store.setReaction(`imovirtual:${id}`, 'like', '1');

    const text = favouritesText(store)!;
    expect(text).toContain('⭐ <b>Избранное</b>: 2');
    expect(text.indexOf('Carnaxide')).toBeLessThan(text.indexOf('Alfragide'));
    expect(text).toContain('380 тыс. € · 100 м² · 🚗 5 мин');
    expect(text).toContain('ещё 1 из избранного уже сняты');
    expect(text).not.toContain('IDd');
  });

  test('nothing liked: null', () => {
    expect(favouritesText(new Store(':memory:'))).toBeNull();
  });

  test('a flat sent with unknown price counts as sent; unsent e-mail listings stay available', () => {
    const store = new Store(':memory:');
    const now = new Date().toISOString();
    store.upsert(raw('IDx', { source: 'idealista', price: null, description: 'Из почтовой рассылки idealista: …' }), now);
    store.upsert(raw('IDy', { source: 'idealista', description: 'Из почтовой рассылки idealista: …' }), now);
    expect(store.unsentFromEmail(14).map((l) => l.id).sort()).toEqual(['idealista:IDx', 'idealista:IDy']);
    store.markNotified('idealista:IDx', null);
    expect(store.notifiedPrice('idealista:IDx')).not.toBeNull();
    expect(store.unsentFromEmail(14).map((l) => l.id)).toEqual(['idealista:IDy']);
  });

  test('flats seen only in old alert e-mails expire with their posts; fresh ones and cross-portal groups stay', () => {
    const store = new Store(':memory:');
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 30 * 86400_000).toISOString();
    const mail = (id: string, emailed: string) => store.upsert(raw(id, { source: 'idealista', description: 'Из почтовой рассылки idealista: …', emailed_at: emailed, listed_since: emailed }), now);
    mail('OLD', old);
    mail('FRESH', now);
    mail('DUP', old);
    store.upsert(raw('IMO'), now);
    store.setGroup('imovirtual:IMO', 'idealista:DUP');
    store.saveMessages('idealista:OLD', [{ chatId: '1', messageId: 10 }, { chatId: '2', messageId: 20 }]);

    const r = store.expireEmailOnly(14);
    expect(r.groups).toBe(1);
    expect(r.posts).toEqual([{ chatId: '1', messageId: 10 }, { chatId: '2', messageId: 20 }]);
    expect(store.get('idealista:OLD')).toBeUndefined();
    expect(store.get('idealista:FRESH')).toBeDefined();
    expect(store.get('idealista:DUP')).toBeDefined();
    expect(store.messages('idealista:OLD')).toEqual([]);

    // A newer e-mail about the same flat keeps it alive (newest date wins).
    mail('FRESH', old);
    expect(store.expireEmailOnly(14).groups).toBe(0);
  });
});
