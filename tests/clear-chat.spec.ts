import { expect, test } from '@playwright/test';
import { config } from '../src/config.ts';
import { CLEAR_WINDOW, clearChats } from '../src/telegram.ts';

test('clear chat: deletes ids 1..marker in batches of 100 and goes on when one recipient fails', async () => {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const orig = globalThis.fetch;
  const saved = { ...config.telegram };
  Object.assign(config.telegram, { token: 't', chatIds: ['blocked', '1'] });
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    const method = String(url).split('/').pop()!;
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    if (body.chat_id === 'blocked') return new Response(JSON.stringify({ ok: false, description: 'Forbidden' }), { status: 403 });
    return new Response(JSON.stringify({ ok: true, result: method === 'sendMessage' ? { message_id: 205 } : true }));
  }) as typeof fetch;
  try {
    expect(await clearChats(0)).toBe(1);
    const deletes = calls.filter((c) => c.method === 'deleteMessages').map((c) => c.body.message_ids as number[]);
    expect(deletes.map((ids) => [ids[0], ids.at(-1), ids.length])).toEqual([[1, 100, 100], [101, 200, 100], [201, 205, 5]]);
    expect(calls.every((c) => c.method !== 'deleteMessages' || c.body.chat_id === '1')).toBe(true);
  } finally {
    globalThis.fetch = orig;
    Object.assign(config.telegram, saved);
  }
});

test('clear chat: only the last ids are tried, and a refused batch with the marker means not cleared', async () => {
  const orig = globalThis.fetch;
  const saved = { ...config.telegram };
  Object.assign(config.telegram, { token: 't', chatIds: ['1'] });
  const firsts: number[] = [];
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    const method = String(url).split('/').pop()!;
    const body = JSON.parse(init.body);
    if (method === 'sendMessage') return new Response(JSON.stringify({ ok: true, result: { message_id: CLEAR_WINDOW + 250 } }));
    firsts.push(body.message_ids[0]);
    const hasMarker = body.message_ids.includes(CLEAR_WINDOW + 250);
    return new Response(JSON.stringify(hasMarker ? { ok: false, description: 'Bad Request' } : { ok: true, result: true }), { status: hasMarker ? 400 : 200 });
  }) as typeof fetch;
  try {
    expect(await clearChats(0)).toBe(0);
    expect(firsts[0]).toBe(251);
  } finally {
    globalThis.fetch = orig;
    Object.assign(config.telegram, saved);
  }
});
