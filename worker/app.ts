// The swipe app page (Telegram Mini App), served by the worker at /app. Plain HTML/CSS/JS, no build step.
// Cards come from /api/deck; a swipe right is 👍, left is 👎 (same reactions as the buttons under the posts).

export const APP_HTML = /* html */ `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>Хата</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  :root {
    --bg: var(--tg-theme-bg-color, #ffffff);
    --text: var(--tg-theme-text-color, #1d1d1f);
    --hint: var(--tg-theme-hint-color, #8e8e93);
    --card: var(--tg-theme-secondary-bg-color, #f2f2f7);
    --link: var(--tg-theme-link-color, #2f80ed);
    --yes: #2ecc71; --no: #ff4d5e; --undo: #f5b301;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text);
    font: 15px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; overflow: hidden; }
  #app { display: flex; flex-direction: column; height: 100%; padding: 8px 12px 12px; gap: 10px; }
  header { display: flex; justify-content: space-between; align-items: baseline; padding: 0 4px; }
  header b { font-size: 18px; }
  header span { color: var(--hint); font-size: 13px; }
  #stack { position: relative; flex: 1; min-height: 0; }
  .card { position: absolute; inset: 0; border-radius: 18px; overflow: hidden; background: var(--card);
    box-shadow: 0 6px 24px rgba(0,0,0,.14); display: flex; flex-direction: column; touch-action: none; user-select: none;
    will-change: transform; }
  .card.behind { transform: scale(.95) translateY(10px); opacity: .7; }
  .photo { position: relative; flex: 1; min-height: 0; background: #ccd5e0 center/cover no-repeat; }
  .photo .none { position: absolute; inset: 0; display: grid; place-items: center; font-size: 64px; opacity: .5; }
  .bars { position: absolute; top: 8px; left: 8px; right: 8px; display: flex; gap: 4px; }
  .bars i { flex: 1; height: 3px; border-radius: 2px; background: rgba(255,255,255,.45); }
  .bars i.on { background: #fff; }
  .shade { position: absolute; left: 0; right: 0; bottom: 0; padding: 40px 14px 12px; color: #fff;
    background: linear-gradient(transparent, rgba(0,0,0,.75)); }
  .price { font-size: 24px; font-weight: 700; }
  .sub { font-size: 15px; opacity: .95; }
  .place { font-size: 13px; opacity: .85; }
  .stamp { position: absolute; top: 28px; padding: 4px 12px; border: 4px solid; border-radius: 10px; font-size: 30px;
    font-weight: 800; letter-spacing: 2px; opacity: 0; transform: rotate(-14deg); pointer-events: none; }
  .stamp.yes { left: 18px; color: var(--yes); border-color: var(--yes); }
  .stamp.no { right: 18px; color: var(--no); border-color: var(--no); transform: rotate(14deg); }
  .info { padding: 10px 14px 12px; font-size: 13px; display: flex; flex-direction: column; gap: 6px; }
  .chip { align-self: flex-start; padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; }
  .chip.match { background: rgba(46,204,113,.18); color: #1e9e57; }
  .chip.negotiate { background: rgba(245,179,1,.2); color: #b27f00; }
  .chip.manual { background: rgba(142,142,147,.2); color: var(--hint); }
  .facts { color: var(--hint); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .links { display: flex; gap: 14px; }
  .links a { color: var(--link); text-decoration: none; font-weight: 600; }
  nav { display: flex; justify-content: center; align-items: center; gap: 22px; padding-bottom: env(safe-area-inset-bottom); }
  nav button { border: 0; border-radius: 50%; background: var(--card); box-shadow: 0 3px 12px rgba(0,0,0,.12);
    display: grid; place-items: center; cursor: pointer; }
  nav .big { width: 64px; height: 64px; font-size: 28px; }
  nav .small { width: 46px; height: 46px; font-size: 20px; }
  nav .no { color: var(--no); } nav .yes { color: var(--yes); } nav .undo { color: var(--undo); }
  nav button:disabled { opacity: .35; }
  .empty { position: absolute; inset: 0; display: grid; place-items: center; text-align: center; color: var(--hint); padding: 24px; }
  .empty div { font-size: 52px; margin-bottom: 8px; }
  #toast { position: fixed; left: 50%; top: 52px; transform: translateX(-50%); background: rgba(0,0,0,.8); color: #fff;
    padding: 8px 14px; border-radius: 12px; font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; }
</style>
</head>
<body>
<div id="app">
  <header><b>🏠 Хата</b><span id="left"></span></header>
  <div id="stack"></div>
  <nav>
    <button class="big no" id="no" aria-label="Не нравится">✖</button>
    <button class="small undo" id="undo" aria-label="Вернуть" disabled>↩</button>
    <button class="big yes" id="yes" aria-label="Нравится">♥</button>
  </nav>
</div>
<div id="toast"></div>
<script>
(() => {
  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg) { tg.ready(); tg.expand(); if (tg.disableVerticalSwipes) tg.disableVerticalSwipes(); }
  const initData = (tg && tg.initData) || '';
  const $ = (id) => document.getElementById(id);
  const stack = $('stack');
  let cards = [], total = 0, judged = 0, loading = false, failed = '';
  const history = [];           // [{ card, kind }] for undo
  const sent = new Set();       // ids judged in this session (kept out of the next deck page)

  const haptic = (t) => { try { tg.HapticFeedback.impactOccurred(t); } catch (e) {} };
  function toast(text) { const t = $('toast'); t.textContent = text; t.style.opacity = 1; clearTimeout(toast.h); toast.h = setTimeout(() => t.style.opacity = 0, 1800); }
  function open(url) { if (!url) return; if (tg && tg.openLink) tg.openLink(url); else window.open(url, '_blank'); }
  const money = (n) => n == null ? 'цена ?' : n.toLocaleString('ru-RU').replace(/,/g, ' ') + ' €';

  async function api(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ initData }, body)) });
    if (r.status === 403) throw new Error('forbidden');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  async function load() {
    if (loading) return;
    loading = true;
    try {
      const d = await api('/api/deck', { exclude: cards.map((c) => c.id).concat([...sent]) });
      total = d.total + cards.length; judged = 0;
      for (const c of d.cards) if (!cards.some((x) => x.id === c.id)) cards.push(c);
      failed = '';
    } catch (e) {
      failed = e.message === 'forbidden' ? 'Нет доступа. Откройте свайпы из бота «Хата».' : 'Не удалось загрузить квартиры. Потяните вниз или откройте снова.';
    }
    loading = false;
    render();
  }

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function cardEl(c, behind) {
    const card = el('div', 'card' + (behind ? ' behind' : ''));
    const photo = el('div', 'photo');
    const imgs = (c.i || []).filter(Boolean);
    let idx = 0;
    const bars = el('div', 'bars');
    imgs.forEach(() => bars.appendChild(el('i')));
    function show() {
      if (imgs.length) photo.style.backgroundImage = 'url("' + imgs[idx].replace(/"/g, '%22') + '")';
      [...bars.children].forEach((b, k) => b.classList.toggle('on', k === idx));
      if (imgs[idx + 1]) new Image().src = imgs[idx + 1];
    }
    if (!imgs.length) photo.appendChild(el('div', 'none', '🏠'));
    if (imgs.length > 1) photo.appendChild(bars);
    const shade = el('div', 'shade');
    shade.appendChild(el('div', 'price', money(c.p)));
    shade.appendChild(el('div', 'sub', [c.b != null ? 'T' + c.b : null, c.a != null ? Math.round(c.a) + ' м²' : null,
      c.c != null ? '🚗 ' + Math.round(c.c) + ' мин до школы' : null].filter(Boolean).join(' · ')));
    shade.appendChild(el('div', 'place', c.t || ''));
    photo.appendChild(shade);
    photo.appendChild(el('div', 'stamp yes', 'ДА'));
    photo.appendChild(el('div', 'stamp no', 'НЕТ'));
    card.appendChild(photo);

    const info = el('div', 'info');
    const chip = c.k === 'manual' ? ['manual', '❓ проверить: ' + (c.w || []).join(', ')]
      : c.k === 'negotiate' ? ['negotiate', '💬 выше бюджета, нужен торг'] : ['match', '✅ подходит по всем критериям'];
    info.appendChild(el('span', 'chip ' + chip[0], chip[1]));
    if (c.x && /[^➕➖—\s]/u.test(c.x)) info.appendChild(el('div', '', c.x));
    if (c.f) info.appendChild(el('div', 'facts', c.f));
    const links = el('div', 'links');
    const a1 = el('a', '', 'Открыть объявление'); a1.href = '#'; a1.onclick = (e) => { e.preventDefault(); open(c.u); };
    links.appendChild(a1);
    if (c.r) { const a2 = el('a', '', '🗺 Маршрут'); a2.href = '#'; a2.onclick = (e) => { e.preventDefault(); open(c.r); }; links.appendChild(a2); }
    info.appendChild(links);
    card.appendChild(info);
    show();
    card.nextPhoto = (d) => { if (imgs.length < 2) return; idx = (idx + d + imgs.length) % imgs.length; show(); haptic('light'); };
    return card;
  }

  function render() {
    stack.textContent = '';
    $('undo').disabled = !history.length;
    const left = Math.max(0, total - judged);
    $('left').textContent = cards.length ? 'осталось ' + left : '';
    if (!cards.length) {
      const e = el('div', 'empty');
      e.innerHTML = failed ? '<p></p>' : '<p><div>🎉</div>Всё просмотрено.<br>Новые квартиры появятся после следующей рассылки.</p>';
      if (failed) e.firstChild.textContent = failed;
      if (loading) e.innerHTML = '<p>Загружаю квартиры…</p>';
      stack.appendChild(e);
      $('yes').disabled = $('no').disabled = true;
      return;
    }
    $('yes').disabled = $('no').disabled = false;
    if (cards[1]) stack.appendChild(cardEl(cards[1], true));
    const top = cardEl(cards[0], false);
    stack.appendChild(top);
    drag(top);
  }

  function drag(card) {
    let x0 = 0, y0 = 0, dx = 0, dy = 0, down = false, moved = false;
    const yes = card.querySelector('.stamp.yes'), no = card.querySelector('.stamp.no');
    card.addEventListener('pointerdown', (e) => {
      if (e.target.closest('a')) return;
      down = true; moved = false; x0 = e.clientX; y0 = e.clientY; dx = dy = 0;
      card.setPointerCapture(e.pointerId); card.style.transition = 'none';
    });
    card.addEventListener('pointermove', (e) => {
      if (!down) return;
      dx = e.clientX - x0; dy = e.clientY - y0;
      if (Math.abs(dx) > 8) moved = true;
      if (!moved) return;
      card.style.transform = 'translate(' + dx + 'px,' + dy * 0.15 + 'px) rotate(' + dx / 18 + 'deg)';
      yes.style.opacity = Math.max(0, Math.min(1, dx / 90));
      no.style.opacity = Math.max(0, Math.min(1, -dx / 90));
    });
    const end = (e) => {
      if (!down) return;
      down = false;
      if (!moved) {
        // Tap on the photo (pointer capture hides the real target, so use coordinates): left third = back.
        const r = card.querySelector('.photo').getBoundingClientRect();
        if (e.clientY >= r.top && e.clientY <= r.bottom) card.nextPhoto(e.clientX - r.left < r.width / 3 ? -1 : 1);
        return;
      }
      if (dx > 100) return judge('like', card);
      if (dx < -100) return judge('hide', card);
      card.style.transition = 'transform .25s'; card.style.transform = ''; yes.style.opacity = no.style.opacity = 0;
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
  }

  function judge(kind, card) {
    const c = cards[0];
    if (!c) return;
    card = card || stack.lastChild;
    haptic(kind === 'like' ? 'medium' : 'light');
    card.style.transition = 'transform .3s ease-out';
    card.style.transform = 'translate(' + (kind === 'like' ? 150 : -150) + 'vw, 40px) rotate(' + (kind === 'like' ? 30 : -30) + 'deg)';
    cards.shift(); judged++; sent.add(c.id); history.push({ card: c, kind });
    if (history.length > 20) history.shift();
    api('/api/react', { id: c.id, kind }).catch(() => toast('Не сохранилось, проверьте интернет'));
    if (kind === 'like') toast('❤️ В избранном');
    setTimeout(render, 220);
    if (cards.length < 5) load();
  }

  function undo() {
    const last = history.pop();
    if (!last) return;
    sent.delete(last.card.id); judged = Math.max(0, judged - 1);
    cards.unshift(last.card);
    api('/api/undo', { id: last.card.id }).catch(() => toast('Не удалось вернуть'));
    if (last.kind === 'hide') toast('Вернул. Пост в чате уже удалён, но карточка снова здесь');
    render();
  }

  $('yes').onclick = () => judge('like');
  $('no').onclick = () => judge('hide');
  $('undo').onclick = undo;
  document.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') judge('like'); if (e.key === 'ArrowLeft') judge('hide'); });
  render();
  load();
})();
</script>
</body>
</html>`;
