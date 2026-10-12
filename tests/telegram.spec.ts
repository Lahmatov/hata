import { expect, test } from '@playwright/test';
import { buildPosts, type DigestItem } from '../src/telegram.ts';
import { mk } from './helpers.ts';

const item = (n: number, group: DigestItem['group'] = 'new', image: string | null = `https://img.example/${n}.jpg`): DigestItem => {
  const l = mk({ id: `t:${n}`, title: `Apartamento T3 <${n}> & garagem`, image });
  return { group, leader: l, members: [l], negotiate: n % 2 === 0, summary: '➕ тихо ➖ без лифта', reasons: group === 'manual' ? ['гараж'] : [] };
};

test.describe('telegram digest', () => {
  test('header, one post per flat with its photo, footer', () => {
    const items = [item(1), item(2, 'drop'), item(3, 'manual', null)];
    const posts = buildPosts(items, [], '07.10.2026 · утро');
    expect(posts).toHaveLength(5);
    expect(posts[0].text).toContain('🆕 НОВЫЕ: 1');
    expect(posts[0].text).toContain('📉 СНИЖЕНИЕ ЦЕНЫ: 1');
    expect(posts[1]).toMatchObject({ photo: 'https://img.example/1.jpg' });
    expect(posts[1].text).toContain('🆕 Новая 1/1');
    expect(posts[1].text).toContain('&lt;1&gt; &amp; garagem');
    expect(posts[1].item?.leader.id).toBe('t:1');
    expect(posts[2].text).toContain('нужен торг');
    expect(posts[3].photo).toBeNull();
    expect(posts[3].text).toContain('неизвестно: гараж');
    expect(posts[4].text).toContain('Все источники ответили');
  });
  test('deal, history and route lines are shown in the card', () => {
    const it = item(1);
    Object.assign(it, { deal: '🔥 на 20% дешевле среднего по Alfragide', history: '💶 история цены: 440 → 415 тыс.', route: 'https://www.google.com/maps/dir/?api=1&origin=1%2C2' });
    const [, post] = buildPosts([it], [], 'd');
    expect(post.text).toContain('🔥 на 20% дешевле');
    expect(post.text).toContain('💶 история цены: 440 → 415 тыс.');
    expect(post.text).toContain('<a href="https://www.google.com/maps/dir/?api=1&amp;origin=1%2C2">🗺 маршрут до школы</a>');
  });
  test('captions stay within the Telegram limit', () => {
    const it = item(1);
    it.summary = 'x'.repeat(2000);
    const [, post] = buildPosts([it], [], 'd');
    expect(post.text.replace(/<[^>]+>/g, '').length).toBeLessThanOrEqual(1024);
  });
  test('failed sources and empty digest', () => {
    const posts = buildPosts([], ['Casa Sapo (blocked: HTTP 429)'], '07.10.2026');
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain('Новых объявлений');
    expect(posts[0].text).toContain('Источники с ошибками: Casa Sapo');
  });
});
