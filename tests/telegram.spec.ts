import { expect, test } from '@playwright/test';
import { buildMessages, type DigestItem } from '../src/telegram.ts';
import { mk } from './helpers.ts';

const item = (n: number, group: DigestItem['group'] = 'new'): DigestItem => {
  const l = mk({ id: `t:${n}`, title: `Apartamento T3 <${n}> & garagem` });
  return { group, leader: l, members: [l], negotiate: n % 2 === 0, summary: '➕ тихо ➖ без лифта', reasons: group === 'manual' ? ['гараж'] : [] };
};

test.describe('telegram digest', () => {
  test('max 15 items per message and under 4096 chars', () => {
    const msgs = buildMessages(Array.from({ length: 40 }, (_, i) => item(i, i < 25 ? 'new' : i < 33 ? 'drop' : 'manual')), [], '07.10.2026');
    expect(msgs.length).toBeGreaterThanOrEqual(3);
    for (const m of msgs) {
      expect(m.length).toBeLessThanOrEqual(4096);
      expect((m.match(/🔗/g) ?? []).length).toBeLessThanOrEqual(15);
    }
  });
  test('groups are labelled and HTML is escaped', () => {
    const [m] = buildMessages([item(1), item(2, 'drop'), item(3, 'manual')], [], '07.10.2026');
    expect(m).toContain('🆕 НОВЫЕ');
    expect(m).toContain('📉 СНИЖЕНИЕ ЦЕНЫ');
    expect(m).toContain('❓ ПРОВЕРИТЬ ВРУЧНУЮ');
    expect(m).toContain('&lt;1&gt; &amp; garagem');
    expect(m).toContain('нужен торг');
  });
  test('failed sources line and empty digest', () => {
    const [m] = buildMessages([], ['Casa Sapo (blocked: HTTP 429)'], '07.10.2026');
    expect(m).toContain('Новых объявлений');
    expect(m).toContain('Источники с ошибками сегодня: Casa Sapo');
  });
});
