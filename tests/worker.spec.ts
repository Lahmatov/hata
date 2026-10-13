import { expect, test } from '@playwright/test';
import worker, { applyReaction, type Catalogue, deck, derivedSecret, favouritesText, handleUpdate, type KV, listReactions, setReaction, verifyInitData } from '../worker/index.ts';
import { createHash, createHmac } from 'node:crypto';

/** In-memory stand-in for Cloudflare KV. */
function memKV(): KV & { data: Map<string, { v: string; metadata?: unknown }>; ops: { put: number; del: number } } {
  const data = new Map<string, { v: string; metadata?: unknown }>();
  const ops = { put: 0, del: 0 };
  return {
    data, ops,
    async get(k) { const e = data.get(k); return e ? JSON.parse(e.v) : null; },
    async getWithMetadata(k) { const e = data.get(k); return { value: e ? e.v : null, metadata: e?.metadata ?? null }; },
    async put(k, v, o) { ops.put++; data.set(k, { v, metadata: o?.metadata }); },
    async delete(k) { ops.del++; data.delete(k); },
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

  test('a rejected KV write (same key within a second) is retried', async () => {
    const kv = memKV();
    const put = kv.put.bind(kv);
    let fails = 1;
    kv.put = async (k, v, o) => { if (fails-- > 0) throw new Error('KV PUT failed: 429 Too Many Requests'); return put(k, v, o); };
    await setReaction(kv, 'like', '1', 'g1', 1);
    expect((await listReactions(kv)).map((r) => r.kind)).toEqual(['like']);
    fails = 5;
    await expect(setReaction(kv, null, '1', 'g1', 1)).rejects.toThrow('429');
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

  test('💞 the second like of a flat tells both chats once; a repeat press or a 👎 does not', async () => {
    const kv = memKV();
    await kv.put('catalogue', JSON.stringify({ g1: { t: 'Benfica', u: 'https://x/1', p: 395000, a: 112, c: 14, s: '2026-10-12', m: [], q: 80 } }));
    const sent: [string, string][] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: { body: string }) => {
      const b = JSON.parse(init.body);
      if (String(url).endsWith('/sendMessage')) sent.push([String(b.chat_id), b.text]);
      return new Response(JSON.stringify({ ok: true }));
    }) as typeof fetch;
    try {
      const env = { KV: kv, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1,2' };
      expect(await applyReaction(env, 'like', '1', 'g1')).toBe(false);
      expect(sent).toEqual([]);
      expect(await applyReaction(env, 'super', '2', 'g1')).toBe(true); // the app plays the 💞 burst
      expect(sent.map((x) => x[0])).toEqual(['2', '1']);
      expect(sent[0][1]).toContain('Совпадение');
      expect(sent[0][1]).toContain('395 тыс. € · 112 м² · 🚗 14 мин · 🏆 80');
      sent.length = 0;
      expect(await applyReaction(env, 'like', '2', 'g1')).toBe(false); // already liked: no second match
      await applyReaction(env, 'hide', '1', 'g1');
      expect(sent).toEqual([]);
    } finally {
      globalThis.fetch = orig;
    }
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
      // 👎 in the favourites round: the other person may still like it, so their post stays.
      await applyReaction(env, 'hide', '1', 'g1', undefined, true);
      expect(calls.filter((c) => c[0] === 'deleteMessage').map((c) => c[1].chat_id)).toEqual(['1']);
      calls.length = 0;
      await handleUpdate(env, { message: { text: '/fav', chat: { id: 999 } } });
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

test.describe('swipe app', () => {
  const token = '123:secret';
  const signed = (fields: Record<string, string>) => {
    const check = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(token).digest();
    const hash = createHmac('sha256', secret).update(check).digest('hex');
    return new URLSearchParams({ ...fields, hash }).toString();
  };

  test('Telegram launch data: valid signature gives the user id; forged or stale data is refused', async () => {
    const now = Date.parse('2026-10-12T12:00:00Z');
    const fields = { auth_date: String(now / 1000 - 60), query_id: 'q', user: JSON.stringify({ id: 40556800, first_name: 'E' }) };
    expect(await verifyInitData(signed(fields), token, 7 * 86400, now)).toBe('40556800');
    expect(await verifyInitData(signed(fields).replace('40556800', '1'), token, 7 * 86400, now)).toBeNull();
    expect(await verifyInitData(signed(fields), 'other:token', 7 * 86400, now)).toBeNull();
    expect(await verifyInitData(signed({ ...fields, auth_date: String(now / 1000 - 8 * 86400) }), token, 7 * 86400, now)).toBeNull();
    expect(await verifyInitData('', token)).toBeNull();
  });

  test('deck: hides what anyone hid and what I judged, matches first, then closest', () => {
    const now = Date.parse('2026-10-12T12:00:00Z');
    const base = { u: 'u', p: 1, a: 100, s: '2026-10-12T07:00:00Z', m: [] as [string, number][] };
    const cat: Catalogue = {
      far: { ...base, t: 'far', c: 30, k: 'match' }, near: { ...base, t: 'near', c: 5, k: 'match' },
      manual: { ...base, t: 'manual', c: 1, k: 'manual' }, hiddenByWife: { ...base, t: 'h', c: 2, k: 'match' },
      likedByMe: { ...base, t: 'l', c: 2, k: 'match' }, likedByWife: { ...base, t: 'w', c: 9, k: 'match' },
      gone: { ...base, t: 'g', c: 1, k: 'match', s: '2026-10-01T07:00:00Z' },
    };
    const rs = [
      { kind: 'hide' as const, chat: 'wife', gid: 'hiddenByWife' }, { kind: 'like' as const, chat: 'me', gid: 'likedByMe' },
      { kind: 'like' as const, chat: 'wife', gid: 'likedByWife' },
    ];
    expect(deck(cat, rs, 'me', now).map((c) => c.id)).toEqual(['near', 'likedByWife', 'far', 'manual']);
  });

  test('deck API: details and photos come from the card chunk; strangers get 403', async () => {
    const kv = memKV();
    const now = new Date().toISOString();
    await kv.put('catalogue', JSON.stringify({ g1: { t: 'Alfragide', u: 'u', p: 1, a: 100, c: 5, s: now, m: [], k: 'match', n: 0 } }));
    await kv.put('cards:0', JSON.stringify({ g1: { h: 'T3', i: ['https://img/1.jpg', 'https://img/2.jpg'], f: 'facts' } }));
    const env = { KV: kv, TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: '40556800' };
    const ask = async (id: number) => worker.fetch(new Request('https://w/api/deck', { method: 'POST',
      body: JSON.stringify({ initData: signed({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id }) }) }) }), env);
    const ok = await ask(40556800);
    expect(await ok.json()).toEqual({ total: 1, cards: [expect.objectContaining({ id: 'g1', t: 'Alfragide', i: ['https://img/1.jpg', 'https://img/2.jpg'], f: 'facts' })] });
    expect((await ask(1)).status).toBe(403);
  });

  test('super like: its own list, replaces a plain like, and leaves the deck', async () => {
    const kv = memKV();
    const now = new Date().toISOString();
    await kv.put('catalogue', JSON.stringify({
      a: { t: 'Alfragide', u: 'https://x/a', p: 380000, a: 115, c: 4, s: now, m: [], k: 'match' },
      b: { t: 'Carnaxide', u: 'https://x/b', p: 395000, a: 98, c: 9, s: now, m: [], k: 'match' },
    }));
    const sent: { method: string; body: Record<string, unknown> }[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: { body: string }) => {
      sent.push({ method: String(url).split('/').pop()!, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true }));
    }) as typeof fetch;
    try {
      const env = { KV: kv, TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: '1' };
      await setReaction(kv, 'like', '1', 'a');
      await handleUpdate(env, { callback_query: { id: 'q', data: 's|a', message: { message_id: 7, chat: { id: 1 } } } });
      await setReaction(kv, 'like', '1', 'b');
      expect((await listReactions(kv)).map((r) => `${r.kind}:${r.gid}`).sort()).toEqual(['like:b', 'super:a']);
      expect(sent.find((x) => x.method === 'editMessageReplyMarkup')?.body.reply_markup).toEqual(expect.objectContaining({
        inline_keyboard: [[expect.anything(), expect.objectContaining({ text: '🌟 Супер!' }), expect.anything()]] }));

      sent.length = 0;
      await handleUpdate(env, { message: { text: '🌟 Суперлайки', chat: { id: 1 } } });
      const reply = String(sent.find((x) => x.method === 'sendMessage')?.body.text);
      expect(reply).toContain('🌟 <b>Суперлайки</b>: 1');
      expect(reply).toContain('Alfragide');
      expect(reply).not.toContain('Carnaxide');

      const cat = (await kv.get('catalogue', 'json')) as Catalogue;
      expect(deck(cat, await listReactions(kv), '1').map((c) => c.id)).toEqual([]);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test('reactions: one write per press, no deletes; older r: keys still count; undo hides them', async () => {
    const kv = memKV();
    await kv.put('r:like:1:imovirtual:ID9', '1', { metadata: { at: 'old' } }); // from before this change
    kv.ops.put = 0;
    expect((await listReactions(kv)).map((r) => `${r.kind}:${r.chat}:${r.gid}`)).toEqual(['like:1:imovirtual:ID9']);
    await setReaction(kv, 'hide', '1', 'imovirtual:ID9');
    await setReaction(kv, 'super', '2', 'imovirtual:ID9');
    expect(kv.ops).toEqual({ put: 2, del: 0 });
    expect((await listReactions(kv)).map((r) => `${r.kind}:${r.chat}`).sort()).toEqual(['hide:1', 'super:2']);
    await setReaction(kv, null, '1', 'imovirtual:ID9');
    expect((await listReactions(kv)).map((r) => `${r.kind}:${r.chat}`)).toEqual(['super:2']);
  });

  test('/sync after an undo does not bring the like back; /reactions reports the undo so the monitor drops it', async () => {
    const kv = memKV();
    const env = { KV: kv, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1,2' };
    const key = await derivedSecret('t', 'sync');
    const call = async (path: string, body?: unknown) => (await worker.fetch(new Request(`https://w${path}`, {
      method: 'POST', headers: { 'X-Hata-Key': key }, body: body ? JSON.stringify(body) : undefined }), env)).json();
    await setReaction(kv, 'like', '1', 'g1');
    await setReaction(kv, null, '1', 'g1'); // ↩ in the app
    // The monitor's database still has the like (pulled before the undo), plus one the worker never saw.
    const r = await call('/sync', { reactions: [{ kind: 'like', chat: '1', gid: 'g1' }, { kind: 'hide', chat: '1', gid: 'g2' }] });
    expect(r).toEqual({ ok: true, added: 1 });
    expect((await listReactions(kv)).map((x) => `${x.kind}:${x.gid}`)).toEqual(['hide:g2']);
    expect(await call('/reactions')).toEqual([{ kind: null, chat: '1', gid: 'g1', at: '' }, expect.objectContaining({ kind: 'hide', gid: 'g2' })]);
  });
});
