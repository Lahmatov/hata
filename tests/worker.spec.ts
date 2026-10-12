import { expect, test } from '@playwright/test';
import { type Catalogue, derivedSecret, handleUpdate, favouritesText, type KV, listReactions, setReaction } from '../worker/index.ts';
import { createHash } from 'node:crypto';

/** In-memory stand-in for Cloudflare KV. */
function memKV(): KV & { data: Map<string, { v: string; metadata?: unknown }> } {
  const data = new Map<string, { v: string; metadata?: unknown }>();
  return {
    data,
    async get(k) { const e = data.get(k); return e ? JSON.parse(e.v) : null; },
    async put(k, v, o) { data.set(k, { v, metadata: o?.metadata }); },
    async delete(k) { data.delete(k); },
    async list({ prefix }) {
      return { keys: [...data].filter(([k]) => k.startsWith(prefix)).map(([name, e]) => ({ name, metadata: e.metadata })), list_complete: true };
    },
  };
}

test.describe('telegram worker', () => {
  test('a press replaces the opposite one; group ids with ":" survive', async () => {
    const kv = memKV();
    await setReaction(kv, 'hide', '1', 'imovirtual:ID1');
    await setReaction(kv, 'like', '1', 'imovirtual:ID1');
    await setReaction(kv, 'like', '2', 'casasapo:abc');
    const rs = (await listReactions(kv)).map((r) => [r.kind, r.chat, r.gid]).sort();
    expect(rs).toEqual([['like', '1', 'imovirtual:ID1'], ['like', '2', 'casasapo:abc']]);
  });

  test('favourites: on sale only, closest first', () => {
    const now = Date.parse('2026-10-12T12:00:00Z');
    const cat: Catalogue = {
      a: { t: 'Alfragide', u: 'https://x/a', p: 400000, a: 100, c: 12, s: '2026-10-12T07:00:00Z', m: [] },
      b: { t: 'Carnaxide', u: 'https://x/b', p: 380000, a: 95, c: 5, s: '2026-10-11T07:00:00Z', m: [] },
      c: { t: 'Old', u: 'https://x/c', p: 1, a: 1, c: 1, s: '2026-09-01T07:00:00Z', m: [] },
    };
    const text = favouritesText(new Set(['a', 'b', 'c', 'zz']), cat, now);
    expect(text).toContain('⭐ <b>Избранное</b>: 2');
    expect(text.indexOf('Carnaxide')).toBeLessThan(text.indexOf('Alfragide'));
    expect(text).toContain('(ещё 1 уже сняты с продажи)');
    expect(favouritesText(new Set(), cat, now)).toContain('пока пусто');
  });

  test('derived secrets match the GitHub side (node:crypto)', async () => {
    const node = createHash('sha256').update('123:abc:hata-sync').digest('hex').slice(0, 40);
    expect(await derivedSecret('123:abc', 'sync')).toBe(node);
  });

  test('👎 answers at once and deletes the posts in both chats; strangers are ignored', async () => {
    const kv = memKV();
    await kv.put('catalogue', JSON.stringify({ g1: { t: 'x', u: 'u', p: 1, a: 1, c: 1, s: '2026-10-12', m: [['1', 10], ['2', 20]] } }));
    const calls: [string, Record<string, unknown>][] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: { body: string }) => {
      calls.push([String(url).split('/').pop()!, JSON.parse(init.body)]);
      return new Response(JSON.stringify({ ok: true }));
    }) as typeof fetch;
    try {
      const env = { KV: kv, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1,2' };
      await handleUpdate(env, { callback_query: { id: 'q', data: 'h|g1', message: { message_id: 10, chat: { id: 1 } } } });
      expect(calls[0][0]).toBe('answerCallbackQuery');
      expect(calls.filter((c) => c[0] === 'deleteMessage').map((c) => [c[1].chat_id, c[1].message_id])).toEqual([['1', 10], ['2', 20]]);
      expect((await listReactions(kv)).map((r) => r.kind)).toEqual(['hide']);
      calls.length = 0;
      await handleUpdate(env, { message: { text: '/fav', chat: { id: 999 } } });
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
