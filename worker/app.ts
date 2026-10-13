// The swipe app page (Telegram Mini App), served by the worker at /app. Plain HTML/CSS/JS, no build step.
// Cards come from /api/deck; swipe right is 👍, up is 🌟 super like, left is 👎 (same reactions as the post buttons).
// Tabs: all new flats, ⭐ favourites (second round over what either of you liked) and 🏆 the rating list.

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
    --yes: #2ecc71; --no: #ff4d5e; --undo: #f5b301; --super: #2f9bff;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text);
    font: 15px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; overflow: hidden; }
  #app { display: flex; flex-direction: column; height: 100%; padding: 8px 12px 12px; gap: 10px; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 0 2px; }
  header span { color: var(--hint); font-size: 12px; white-space: nowrap; }
  .tabs { display: flex; background: var(--card); border-radius: 10px; padding: 2px; }
  .tabs button { border: 0; background: none; color: var(--text); font: inherit; font-size: 13px; padding: 5px 9px; border-radius: 8px; cursor: pointer; white-space: nowrap; }
  .tabs button.on { background: var(--bg); box-shadow: 0 1px 4px rgba(0,0,0,.12); font-weight: 600; }
  .score { position: absolute; top: 18px; right: 10px; background: rgba(0,0,0,.6); color: #fff; border-radius: 12px; padding: 3px 9px;
    font-weight: 700; font-size: 14px; }
  .who { font-size: 13px; font-weight: 600; }
  .feats { display: flex; flex-wrap: wrap; gap: 4px; }
  .feats i { font-style: normal; font-size: 11px; padding: 1px 7px; border-radius: 9px; background: rgba(47,128,237,.12); color: var(--link); }
  .why { color: var(--hint); font-size: 12px; }
  #rank { position: absolute; inset: 0; overflow-y: auto; display: none; -webkit-overflow-scrolling: touch; }
  #rank .row { display: grid; grid-template-columns: 34px 1fr auto; gap: 2px 8px; padding: 9px 6px; border-bottom: 1px solid var(--card); cursor: pointer; }
  #rank .n { grid-row: span 2; font-size: 20px; font-weight: 700; color: var(--hint); text-align: center; }
  #rank .q { grid-row: span 2; font-size: 18px; font-weight: 700; align-self: center; }
  #rank .l1 { font-weight: 600; } #rank .l2 { font-size: 12px; color: var(--hint); }
  .export { display: block; width: 100%; margin: 10px 0 4px; padding: 11px; border: 0; border-radius: 12px; background: var(--link); color: #fff;
    font: inherit; font-weight: 600; cursor: pointer; }
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
  .stamp.super { top: auto; bottom: 130px; left: 50%; color: var(--super); border-color: var(--super); transform: translateX(-50%) rotate(-8deg); }
  .info { padding: 10px 14px 12px; font-size: 13px; display: flex; flex-direction: column; gap: 6px; }
  .chip { align-self: flex-start; padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; }
  .chip.match { background: rgba(46,204,113,.18); color: #1e9e57; }
  .chip.negotiate { background: rgba(245,179,1,.2); color: #b27f00; }
  .chip.manual { background: rgba(142,142,147,.2); color: var(--hint); }
  .facts { color: var(--hint); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .links { display: flex; flex-wrap: wrap; gap: 6px 14px; }
  .links a { color: var(--link); text-decoration: none; font-weight: 600; }
  nav { display: flex; justify-content: center; align-items: center; gap: 16px; padding-bottom: env(safe-area-inset-bottom); }
  nav button { border: 0; border-radius: 50%; background: var(--card); box-shadow: 0 3px 12px rgba(0,0,0,.12);
    display: grid; place-items: center; cursor: pointer; }
  nav .big { width: 64px; height: 64px; font-size: 28px; }
  nav .small { width: 46px; height: 46px; font-size: 20px; }
  nav .no { color: var(--no); } nav .yes { color: var(--yes); } nav .undo { color: var(--undo); } nav .super { color: var(--super); }
  nav button:disabled { opacity: .35; }
  nav .arrow { color: var(--hint); width: 40px; height: 40px; font-size: 16px; }
  nav.fav { gap: 10px; }
  .filters { display: none; gap: 6px; padding: 0 2px; }
  .filters button { border: 1px solid var(--card); background: var(--bg); color: var(--text); border-radius: 14px; padding: 4px 10px; font: inherit; font-size: 13px; cursor: pointer; }
  .filters button.on { background: #e0245e; border-color: #e0245e; color: #fff; font-weight: 600; }
  .filters #okf.on { background: #1e9e57; border-color: #1e9e57; }
  .okhint { display: none; font-size: 12px; color: var(--hint); padding: 0 4px; }
  .popbtns { display: flex; gap: 6px; margin-top: 6px; } .popbtns a { padding: 5px 8px; border-radius: 8px; background: #eef3fb; text-decoration: none; font-weight: 600; }
  .quick { display: flex; gap: 8px; flex-wrap: wrap; }
  .quick button { border: 1px solid var(--card); background: var(--card); color: var(--text); border-radius: 10px; padding: 5px 10px; font: inherit; font-size: 13px; cursor: pointer; }
  .quick button.on { background: rgba(46,204,113,.18); border-color: #2ecc71; color: #1e9e57; font-weight: 600; } nav button[hidden] { display: none; }
  .empty { position: absolute; inset: 0; display: grid; place-items: center; text-align: center; color: var(--hint); padding: 24px; }
  .empty div { font-size: 52px; margin-bottom: 8px; }
  .sheet { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: none; z-index: 10; }
  .sheet .box { position: absolute; left: 0; right: 0; bottom: 0; max-height: 88%; overflow: auto; background: var(--bg);
    border-radius: 16px 16px 0 0; padding: 14px 14px calc(14px + env(safe-area-inset-bottom)); }
  .sheet h3 { margin: 0 0 10px; font-size: 16px; display: flex; justify-content: space-between; align-items: center; }
  .sheet h3 button { border: 0; background: var(--card); color: var(--text); border-radius: 50%; width: 30px; height: 30px; font-size: 16px; }
  .sheet label { display: block; font-size: 12px; color: var(--hint); margin: 10px 0 4px; }
  .sheet select, .sheet input, .sheet textarea { width: 100%; font: inherit; padding: 9px; border-radius: 10px; border: 1px solid var(--card);
    background: var(--card); color: var(--text); }
  .sheet textarea { min-height: 80px; resize: vertical; }
  .btn { display: inline-block; border: 0; border-radius: 10px; padding: 10px 14px; font: inherit; font-weight: 600; background: var(--link); color: #fff; cursor: pointer; }
  .btn.ghost { background: var(--card); color: var(--link); }
  .row2 { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  .st { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 9px; background: rgba(245,179,1,.2); color: #a37500; margin-right: 4px; }
  .notel { font-size: 12px; } .notel a { color: var(--link); font-weight: 600; text-decoration: none; }
  .tools { display: flex; gap: 6px; margin: 10px 0 4px; } .tools .btn { flex: 1; padding: 10px 6px; font-size: 13px; }
  #rank .row { grid-template-columns: 22px 30px 1fr auto; } #rank .row input { grid-row: span 2; align-self: center; width: 18px; height: 18px; }
  .cmp { overflow-x: auto; } .cmp table { border-collapse: collapse; font-size: 12px; min-width: 100%; }
  .cmp th, .cmp td { border-bottom: 1px solid var(--card); padding: 6px; vertical-align: top; text-align: left; min-width: 110px; }
  .cmp th:first-child { position: sticky; left: 0; background: var(--bg); min-width: 80px; color: var(--hint); font-weight: 500; }
  .cmp img { width: 120px; height: 80px; object-fit: cover; border-radius: 8px; display: block; }
  .cmp .best { color: #1e9e57; font-weight: 700; }
  #map { height: 68vh; border-radius: 12px; }
  .pin { padding: 2px 6px; border-radius: 10px; color: #fff; font: 700 11px/1.3 -apple-system, sans-serif; white-space: nowrap;
    box-shadow: 0 1px 4px rgba(0,0,0,.4); border: 2px solid #fff; transform: translate(-50%, -50%); display: inline-block; }
  .pin.approx { border-style: dashed; opacity: .85; }
  #toast { position: fixed; left: 50%; top: 52px; transform: translateX(-50%); background: rgba(0,0,0,.8); color: #fff;
    padding: 8px 14px; border-radius: 12px; font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; }
</style>
</head>
<body>
<div id="app">
  <header>
    <div class="tabs"><button data-m="all" class="on">🏠 Новые</button><button data-m="fav">⭐ Избранное</button><button data-m="rank">🏆 Рейтинг</button></div>
    <span id="left"></span>
  </header>
  <div class="filters" id="filters"><button id="both">💞 Нравится обоим</button><button id="okf" title="Лифт, гараж, T3+, от 2 санузлов, до школы меньше 20 мин">✅ Всё подходит</button></div>
  <div class="okhint" id="okhint">✅ = лифт · гараж · T3 и больше · от 2 санузлов · до школы меньше 20 мин. Если что-то из этого неизвестно, квартира не попадает.</div>
  <div id="stack"></div>
  <div id="rankwrap" style="position:relative;flex:1;min-height:0;display:none"><div id="rank"></div></div>
  <nav>
    <button class="small arrow" id="prev" aria-label="Предыдущая" hidden>◀</button>
    <button class="small undo" id="undo" aria-label="Вернуть" disabled>↩</button>
    <button class="big no" id="no" aria-label="Не нравится">✖</button>
    <button class="small super" id="super" aria-label="Суперлайк">★</button>
    <button class="big yes" id="yes" aria-label="Нравится">♥</button>
    <button class="small arrow" id="next" aria-label="Следующая" hidden>▶</button>
  </nav>
</div>
<div class="sheet" id="sheet"><div class="box" id="sheetbox"></div></div>
<div id="toast"></div>
<script>
(() => {
  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg) { tg.ready(); tg.expand(); if (tg.disableVerticalSwipes) tg.disableVerticalSwipes(); }
  const initData = (tg && tg.initData) || '';
  const $ = (id) => document.getElementById(id);
  const stack = $('stack');
  let cards = [], total = 0, judged = 0, loading = false, failed = '', mode = 'all', names = {}, first = null;
  const me = String((tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.id) || '');
  const history = [];           // [{ card, kind }] for undo
  const sent = new Set();       // ids judged in this session (kept out of the next deck page)
  const viewed = [];            // favourites: cards passed (▶ or a swipe that keeps them), for ◀
  let favTotal = null;          // favourites in the list: set on the first page, minus 👎 in this session
  let bothOnly = false;         // 💞 filter: flats both of you liked (remembered on this phone)
  let okOnly = false;           // ✅ filter: lift, garage, T3+, 2+ bathrooms, under 20 min to school
  try { bothOnly = localStorage.getItem('hata.both') === '1'; okOnly = localStorage.getItem('hata.ok') === '1'; } catch (e) {}
  // Walk around: Google Street View at the flat (Maps URL, no key); approximate when only the area is known.
  const streetUrl = (g) => 'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=' + g[0] + ',' + g[1];

  const haptic = (t) => { try { tg.HapticFeedback.impactOccurred(t); } catch (e) {} };
  function toast(text) { const t = $('toast'); t.textContent = text; t.style.opacity = 1; clearTimeout(toast.h); toast.h = setTimeout(() => t.style.opacity = 0, 1800); }
  function open(url) { if (!url) return; if (tg && tg.openLink) tg.openLink(url); else window.open(url, '_blank'); }
  // Telegram's own "Share" in the ⋯ menu always shares the bot; this shares the flat itself.
  // Only the listing link: the phone's share sheet (WhatsApp, mail…) when there is one, else copied.
  function shareLink(c) {
    if (navigator.share) return navigator.share({ url: c.u }).catch(() => {});
    const done = () => toast('🔗 Ссылка скопирована');
    if (navigator.clipboard) return navigator.clipboard.writeText(c.u).then(done).catch(() => tgShare(c));
    tgShare(c);
  }
  function tgShare(c) {
    const url = 'https://t.me/share/url?url=' + encodeURIComponent(c.u);
    if (tg && tg.openTelegramLink) tg.openTelegramLink(url); else window.open(url, '_blank');
  }

  // 📨 One tap: sent to the realtor (shared with the other person, kept with the status and note).
  async function toggleRealtor(c, btn) {
    const on = !(c.nt && c.nt.r);
    try {
      const r = await api('/api/note', { id: c.id, note: { r: on } });
      c.nt = r.note;
      btn.classList.toggle('on', on); btn.textContent = on ? '📨 Отправлено риелтору ✓' : '📨 Риелтору';
      haptic('light');
    } catch (e) { toast('Не сохранилось, проверьте интернет'); }
  }
  const money = (n) => n == null ? 'цена ?' : n.toLocaleString('ru-RU').replace(/,/g, ' ') + ' €';
  const STATUSES = { call: '📞 позвонить', called: '☎️ позвонили', viewing: '📅 просмотр', seen: '👀 посмотрели', offer: '🤝 предложение', no: '✖️ отказ' };
  const SCHOOL = [38.735766, -9.226091];

  // ---- bottom sheet (status/note, comparison, map) ----
  function sheet(title) {
    const box = $('sheetbox');
    box.textContent = '';
    const h = el('h3', '', title);
    const x = el('button', '', '✕'); x.onclick = closeSheet; h.appendChild(x);
    box.appendChild(h);
    $('sheet').style.display = 'block';
    return box;
  }
  function closeSheet() { $('sheet').style.display = 'none'; $('sheetbox').textContent = ''; }
  $('sheet').onclick = (e) => { if (e.target.id === 'sheet') closeSheet(); };

  function calendarUrl(c, d) {
    const start = d.replace(/[-:]/g, '') + '00';
    const t = new Date(d + ':00Z'); t.setUTCHours(t.getUTCHours() + 1);
    const end = t.toISOString().slice(0, 16).replace(/[-:]/g, '') + '00';
    return 'https://calendar.google.com/calendar/render?action=TEMPLATE&ctz=Europe/Lisbon&text=' + encodeURIComponent('Просмотр квартиры: ' + (c.t || ''))
      + '&dates=' + start + '/' + end + '&details=' + encodeURIComponent(c.u + (c.nt && c.nt.t ? ' — ' + c.nt.t : '')) + '&location=' + encodeURIComponent(c.t || '');
  }

  // Shared status + note + viewing time for a flat (both of you see the same).
  function noteSheet(c, after) {
    const box = sheet('📝 ' + (c.t || 'Квартира'));
    const n = c.nt || {};
    box.appendChild(el('label', '', 'Статус'));
    const s = el('select');
    s.appendChild(new Option('—', ''));
    Object.keys(STATUSES).forEach((k) => s.appendChild(new Option(STATUSES[k], k, false, n.s === k)));
    box.appendChild(s);
    box.appendChild(el('label', '', 'Просмотр (дата и время)'));
    const d = el('input'); d.type = 'datetime-local'; d.value = n.d || ''; box.appendChild(d);
    box.appendChild(el('label', '', 'Заметка (видна обоим, до 300 символов)'));
    const t = el('textarea'); t.maxLength = 300; t.value = n.t || ''; box.appendChild(t);
    if (n.at) box.appendChild(el('label', '', 'Изменено ' + n.at.slice(0, 16).replace('T', ' ') + (names[n.by] ? ' · ' + names[n.by] : '')));
    const row = el('div', 'row2');
    const save = el('button', 'btn', 'Сохранить');
    save.onclick = async () => {
      if (d.value && !s.value) s.value = 'viewing';
      try {
        const r = await api('/api/note', { id: c.id, note: { s: s.value, d: d.value, t: t.value } });
        c.nt = r.note; toast('Сохранено, видно обоим'); closeSheet(); if (after) after();
      } catch (e) { toast('Не сохранилось, проверьте интернет'); }
    };
    row.appendChild(save);
    const cal = el('button', 'btn ghost', '📅 В календарь');
    cal.onclick = () => { if (!d.value) return toast('Сначала выберите дату просмотра'); open(calendarUrl(Object.assign({}, c, { nt: { t: t.value } }), d.value)); };
    row.appendChild(cal);
    box.appendChild(row);
  }

  function noteLine(c) {
    const n = c.nt || {};
    const box = el('div', 'notel');
    if (n.s) box.appendChild(el('span', 'st', STATUSES[n.s] + (n.d ? ' ' + n.d.slice(5, 16).replace('T', ' ') : '')));
    if (n.r) box.appendChild(el('span', 'st', '📨 риелтору'));
    if (n.t) box.appendChild(document.createTextNode(n.t.length > 80 ? n.t.slice(0, 80) + '…' : n.t));
    return box;
  }

  // ⚖️ Side by side: best value per row in green.
  async function compareSheet(ids) {
    const box = sheet('⚖️ Сравнение');
    box.appendChild(el('p', 'why', 'Загружаю…'));
    let d;
    try { d = await api('/api/cards', { ids }); } catch (e) { box.lastChild.textContent = 'Не удалось загрузить'; return; }
    box.removeChild(box.lastChild);
    const cs = d.cards;
    const ppm = (c) => c.p && c.a ? Math.round(c.p / c.a) : null;
    const rows = [
      ['', (c) => { const w = el('div'); if (c.i && c.i[0]) { const im = el('img'); im.src = c.i[0]; w.appendChild(im); } w.appendChild(el('div', '', c.t || '')); return w; }],
      ['Баллы', (c) => c.q, 'max'], ['Цена', (c) => c.p, 'min', money], ['Площадь, м²', (c) => c.a && Math.round(c.a), 'max'],
      ['€/м²', ppm, 'min', money], ['Спальни', (c) => c.b, 'max'], ['До школы, мин', (c) => c.c != null ? Math.round(c.c) : null, 'min'],
      ['Удобства', (c) => (c.e || []).join(', ') || '—'], ['Покупка и ипотека', (c) => c.z ? c.z.replace('💶 ', '') : '—'], ['Сделки рядом (INE)', (c) => c.v ? c.v.replace('📊 ', '') : '—'],
      ['Рядом', (c) => c.o || '—'], ['Подтопление', (c) => c.fz || '—'], ['Самолёты', (c) => c.pl || '—'], ['Факты', (c) => c.f || ''], ['Плюс / минус', (c) => c.x || ''],
      ['Кто лайкнул', (c) => whoLine(c) || '—'], ['Статус', (c) => c.nt && c.nt.s ? STATUSES[c.nt.s] : '—'], ['Заметка', (c) => (c.nt && c.nt.t) || '—'],
      ['', (c) => { const a = el('a', '', 'Открыть объявление'); a.href = '#'; a.onclick = (e) => { e.preventDefault(); open(c.u); }; return a; }],
    ];
    const table = el('table');
    for (const [label, get, best, fmt] of rows) {
      const tr = el('tr');
      tr.appendChild(el('th', '', label));
      const vals = cs.map(get);
      const nums = vals.filter((v) => typeof v === 'number');
      const target = best === 'max' ? Math.max(...nums) : best === 'min' ? Math.min(...nums) : null;
      vals.forEach((v) => {
        const td = el('td');
        if (v instanceof Node) td.appendChild(v);
        else td.textContent = v == null ? '?' : fmt ? fmt(v) : String(v);
        if (best && nums.length > 1 && v === target) td.className = 'best';
        tr.appendChild(td);
      });
      table.appendChild(tr);
    }
    const wrap = el('div', 'cmp'); wrap.appendChild(table); box.appendChild(wrap);
  }

  // 🗺 Map of favourites (OpenStreetMap tiles, Esri as a fallback; Leaflet loaded on first use).
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    return new Promise((ok, fail) => {
      const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
      document.head.appendChild(css);
      const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
      s.onload = ok; s.onerror = fail; document.head.appendChild(s);
    });
  }
  async function mapSheet(list) {
    const box = sheet('🗺 Избранное на карте');
    const m = el('div'); m.id = 'map'; box.appendChild(m);
    box.appendChild(el('p', 'why', 'Нажмите на точку: карточка квартиры или 🚶 прогулка по улице (Google Street View). Цена в тыс. €. 🔵 суперлайк · 🔴 нравится обоим · 🟢 одному · серый: отказ · пунктир: адрес известен только до района · 🏫 школа'));
    try { await loadLeaflet(); } catch (e) { m.textContent = 'Карта не загрузилась, проверьте интернет'; return; }
    const map = L.map(m).setView(SCHOOL, 12);
    // OpenStreetMap tiles; if they keep failing (the server may refuse a request), switch to Esri's street map.
    const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    let tileErrors = 0;
    osm.on('tileerror', () => {
      if (++tileErrors !== 3) return;
      map.removeLayer(osm);
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
        { maxZoom: 19, attribution: 'Tiles © Esri, © OpenStreetMap' }).addTo(map);
    });
    L.marker(SCHOOL, { icon: L.divIcon({ html: '🏫', className: '', iconSize: [24, 24] }) }).addTo(map).bindPopup('PaRK International School');
    const pts = [SCHOOL];
    const placed = list.filter((c) => c.g);
    // Flats known only to the neighbourhood share its centre: spread them on a small circle so each can be tapped.
    const same = {};
    placed.forEach((c) => { const k = c.g.join(','); (same[k] = same[k] || []).push(c); });
    const at = (c) => {
      const group = same[c.g.join(',')];
      if (group.length < 2) return c.g;
      const i = group.indexOf(c), r = 0.0012 * (1 + Math.floor(i / 8)), a = (i % 8) / 8 * 2 * Math.PI;
      return [c.g[0] + r * Math.sin(a), c.g[1] + r * 1.3 * Math.cos(a)];
    };
    placed.forEach((c) => {
      const color = c.nt && c.nt.s === 'no' ? '#8e8e93' : c.me === 'super' || c.ot === 'super' ? '#2f9bff' : c.me && c.ot ? '#e0245e' : '#2ecc71';
      const label = c.p ? Math.round(c.p / 1000) + 'k' : '?';
      const icon = L.divIcon({ className: '', html: '<span class="pin' + (c.ga ? ' approx' : '') + '" style="background:' + color + '">' + label + '</span>', iconSize: null });
      // Tap a point: straight into that flat's card.
      const pop = el('div');
      pop.appendChild(el('b', '', money(c.p) + (c.q != null ? ' · 🏆 ' + c.q : '') + (c.ok ? ' · ✅' : '')));
      pop.appendChild(el('div', '', (c.t || '') + (c.c != null ? ' · 🚗 ' + Math.round(c.c) + ' мин' : '')));
      const btns = el('div', 'popbtns');
      const go = el('a', '', 'Карточка'); go.href = '#'; go.onclick = (e) => { e.preventDefault(); closeSheet(); first = c.id; setMode('fav'); };
      const walk = el('a', '', c.ga ? '🚶 Погулять (район)' : '🚶 Погулять'); walk.href = '#'; walk.onclick = (e) => { e.preventDefault(); open(streetUrl(c.g)); };
      btns.append(go, walk);
      pop.appendChild(btns);
      L.marker(at(c), { icon, title: (c.t || '') + ' · ' + money(c.p) }).addTo(map).bindPopup(pop);
      pts.push(at(c));
    });
    const missing = list.length - placed.length;
    if (missing) box.appendChild(el('p', 'why', missing + ' кв. без адреса и района не на карте (появятся после следующего запуска, если район известен).'));
    map.fitBounds(pts, { padding: [24, 24] });
    setTimeout(() => map.invalidateSize(), 200);
  }

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
      const m = mode;
      const d = await api('/api/deck', { mode: m, first, both: m === 'fav' && bothOnly, ok: m === 'fav' && okOnly, exclude: cards.map((c) => c.id).concat([...sent]) });
      if (m !== mode) return;
      first = null;
      if (d.names) names = d.names;
      total = d.total + cards.length; judged = 0;
      if (m === 'fav' && favTotal === null) favTotal = d.total;
      for (const c of d.cards) if (!cards.some((x) => x.id === c.id)) cards.push(c);
      failed = '';
    } catch (e) {
      failed = e.message === 'forbidden' ? 'Нет доступа. Откройте свайпы из бота «Хата».' : 'Не удалось загрузить квартиры. Нажмите ⋯ → «Обновить страницу».';
    }
    loading = false;
    render();
  }

  // Who liked it: "❤️ вы · 🌟 Мария" (favourites only).
  function whoLine(c) {
    const other = Object.keys(names).filter((id) => id !== me).map((id) => names[id])[0] || 'второй';
    const icon = (k) => k === 'super' ? '🌟' : k === 'like' ? '❤️' : k === 'hide' ? '👎' : null;
    return [c.me && icon(c.me) + ' вы', c.ot && icon(c.ot) + ' ' + other].filter(Boolean).join(' · ');
  }

  async function loadRank() {
    const box = $('rank');
    box.innerHTML = '<p style="text-align:center;color:var(--hint)">Считаю рейтинг…</p>';
    try {
      const d = await api('/api/deck', { mode: 'fav', slim: true, both: bothOnly, ok: okOnly });
      names = d.names || names;
      box.textContent = '';
      $('left').textContent = '';
      if (!d.cards.length) {
        box.innerHTML = bothOnly ? '<p style="text-align:center;color:var(--hint)">Общих 💞 пока нет: квартир, которые нравятся вам обоим.</p>'
          : '<p style="text-align:center;color:var(--hint)">В избранном пока пусто.<br>Свайпайте вправо во вкладке «Новые».</p>';
        return;
      }
      const picked = new Set();
      const tools = el('div', 'tools');
      const ex = el('button', 'btn', '📊 Таблица'); ex.onclick = exportTable;
      const mp = el('button', 'btn ghost', '🗺 Карта'); mp.onclick = () => mapSheet(d.cards);
      const cmp = el('button', 'btn ghost', '⚖️ Сравнить');
      cmp.onclick = () => picked.size >= 2 ? compareSheet([...picked]) : toast('Отметьте 2–4 квартиры галочками');
      tools.append(ex, mp, cmp);
      box.appendChild(tools);
      d.cards.forEach((c, i) => {
        const r = el('div', 'row');
        const cb = el('input'); cb.type = 'checkbox';
        cb.onclick = (e) => {
          e.stopPropagation();
          if (cb.checked && picked.size >= 4) { cb.checked = false; return toast('Сравнить можно до 4 квартир'); }
          cb.checked ? picked.add(c.id) : picked.delete(c.id);
          cmp.textContent = '⚖️ Сравнить' + (picked.size ? ' (' + picked.size + ')' : '');
        };
        r.appendChild(cb);
        r.appendChild(el('div', 'n', String(i + 1)));
        r.appendChild(el('div', 'l1', [money(c.p), c.a != null ? Math.round(c.a) + ' м²' : null, c.c != null ? '🚗 ' + Math.round(c.c) + ' мин' : null].filter(Boolean).join(' · ')));
        r.appendChild(el('div', 'q', (c.ok ? '✅' : '') + (c.q != null ? String(c.q) : '–')));
        const l2 = el('div', 'l2', (c.t || '') + ' · ' + whoLine(c));
        if (c.nt) l2.appendChild(noteLine(c));
        r.appendChild(l2);
        r.onclick = () => { first = c.id; setMode('fav'); };
        box.appendChild(r);
      });
      box.appendChild(el('p', 'why', 'Баллы из 100: цена 25, дорога до школы 25, площадь 15, цена за м² против района 15, состояние 10, удобства 10. Нажмите на строку, чтобы открыть карточку; галочки — для сравнения. ✅ = лифт, гараж, T3+, от 2 санузлов и до школы меньше 20 мин.'));
    } catch (e) {
      box.innerHTML = '<p style="text-align:center;color:var(--hint)">Не удалось загрузить. Нажмите ⋯ → «Обновить страницу».</p>';
    }
  }

  async function exportTable() {
    toast('Собираю таблицу…');
    try { const d = await api('/api/export', {}); toast(d.rows ? '📊 Таблица в чате с ботом' : 'В избранном пока пусто'); }
    catch (e) { toast('Не получилось, попробуйте /export в чате'); }
  }

  function setMode(m) {
    mode = m;
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
    const rank = m === 'rank';
    $('stack').style.display = rank ? 'none' : '';
    $('rankwrap').style.display = rank ? 'block' : 'none';
    $('rank').style.display = rank ? 'block' : 'none';
    document.querySelector('nav').style.display = rank ? 'none' : '';
    document.querySelector('nav').classList.toggle('fav', m === 'fav');
    $('prev').hidden = $('next').hidden = m !== 'fav';
    $('filters').style.display = m === 'all' ? 'none' : 'flex';
    $('both').classList.toggle('on', bothOnly);
    $('okf').classList.toggle('on', okOnly);
    $('okhint').style.display = m !== 'all' && okOnly ? 'block' : 'none';
    cards = []; total = 0; judged = 0; history.length = 0; sent.clear(); failed = ''; viewed.length = 0; favTotal = null;
    if (rank) { loadRank(); return; }
    render();
    load();
  }
  document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => setMode(b.dataset.m));
  $('both').onclick = () => {
    bothOnly = !bothOnly;
    try { localStorage.setItem('hata.both', bothOnly ? '1' : '0'); } catch (e) {}
    setMode(mode);
  };
  $('okf').onclick = () => {
    okOnly = !okOnly;
    try { localStorage.setItem('hata.ok', okOnly ? '1' : '0'); } catch (e) {}
    setMode(mode);
  };

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
    if (c.q != null) photo.appendChild(el('div', 'score', '🏆 ' + c.q));
    photo.appendChild(el('div', 'stamp yes', 'ДА'));
    photo.appendChild(el('div', 'stamp no', 'НЕТ'));
    photo.appendChild(el('div', 'stamp super', 'СУПЕР'));
    card.appendChild(photo);

    const info = el('div', 'info');
    const chip = c.k === 'manual' ? ['manual', '❓ проверить: ' + (c.w || []).join(', ')]
      : c.k === 'negotiate' ? ['negotiate', '💬 выше бюджета, нужен торг'] : ['match', '✅ подходит по всем критериям'];
    if (mode === 'fav') {
      info.appendChild(el('div', 'who', whoLine(c)));
      const nl = noteLine(c);
      const a = el('a', '', c.nt ? ' ✏️ изменить' : '📝 Статус, заметка, просмотр'); a.href = '#';
      a.onclick = (e) => { e.preventDefault(); noteSheet(c, render); };
      nl.appendChild(a);
      info.appendChild(nl);
      const quick = el('div', 'quick');
      const rb = el('button', c.nt && c.nt.r ? 'on' : '', c.nt && c.nt.r ? '📨 Отправлено риелтору ✓' : '📨 Риелтору');
      rb.onclick = () => toggleRealtor(c, rb);
      const lb = el('button', '', '🔗 Ссылка'); lb.onclick = () => shareLink(c);
      quick.append(rb, lb);
      if (c.g) { const sv = el('button', '', c.ga ? '🚶 Улица (район)' : '🚶 Улица'); sv.onclick = () => open(streetUrl(c.g)); quick.append(sv); }
      info.appendChild(quick);
    }
    info.appendChild(el('span', 'chip ' + chip[0], chip[1]));
    if (c.e && c.e.length) { const fs = el('div', 'feats'); c.e.forEach((t) => fs.appendChild(el('i', '', t))); info.appendChild(fs); }
    if (c.x && /[^➕➖—\s]/u.test(c.x)) info.appendChild(el('div', '', c.x));
    if (c.f) info.appendChild(el('div', 'facts', c.f));
    if (c.y) info.appendChild(el('div', 'why', '🏆 ' + c.q + '/100: ' + c.y));
    if (mode === 'fav') for (const line of [c.o && '📍 ' + c.o, c.pl, c.fz, c.v, c.z]) if (line) info.appendChild(el('div', 'why', line));
    const links = el('div', 'links');
    const a1 = el('a', '', 'Открыть объявление'); a1.href = '#'; a1.onclick = (e) => { e.preventDefault(); open(c.u); };
    links.appendChild(a1);
    if (c.r) { const a2 = el('a', '', '🗺 Маршрут'); a2.href = '#'; a2.onclick = (e) => { e.preventDefault(); open(c.r); }; links.appendChild(a2); }
    if (mode !== 'fav') { const a3 = el('a', '', '🔗 Ссылка'); a3.href = '#'; a3.onclick = (e) => { e.preventDefault(); shareLink(c); }; links.appendChild(a3); }
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
    $('left').textContent = mode === 'fav' ? (favTotal ? Math.min(viewed.length + 1, favTotal) + ' из ' + favTotal : '')
      : cards.length ? 'осталось ' + left : '';
    $('prev').disabled = !viewed.length;
    $('next').disabled = !cards.length;
    if (!cards.length) {
      const e = el('div', 'empty');
      e.innerHTML = failed ? '<p></p>' : mode === 'fav' && bothOnly && !viewed.length ? '<p><div>💞</div>Общих пока нет: квартир, которые нравятся вам обоим.<br>Снимите фильтр «💞», чтобы видеть всё избранное.</p>'
        : mode === 'fav' ? '<p><div>⭐</div>Избранное пройдено.<br>Итог во вкладке «🏆 Рейтинг», там же таблица Excel.</p>'
        : '<p><div>🎉</div>Всё просмотрено.<br>Новые квартиры появятся после следующей рассылки.</p>';
      if (failed) e.firstChild.textContent = failed;
      if (loading) e.innerHTML = '<p>Загружаю квартиры…</p>';
      stack.appendChild(e);
      $('yes').disabled = $('no').disabled = $('super').disabled = true;
      return;
    }
    $('yes').disabled = $('no').disabled = $('super').disabled = false;
    if (cards[1]) stack.appendChild(cardEl(cards[1], true));
    const top = cardEl(cards[0], false);
    stack.appendChild(top);
    drag(top);
  }

  function drag(card) {
    let x0 = 0, y0 = 0, dx = 0, dy = 0, down = false, moved = false;
    const yes = card.querySelector('.stamp.yes'), no = card.querySelector('.stamp.no'), sup = card.querySelector('.stamp.super');
    card.addEventListener('pointerdown', (e) => {
      if (e.target.closest('a,button,input,select,textarea')) return;
      down = true; moved = false; x0 = e.clientX; y0 = e.clientY; dx = dy = 0;
      card.setPointerCapture(e.pointerId); card.style.transition = 'none';
    });
    card.addEventListener('pointermove', (e) => {
      if (!down) return;
      dx = e.clientX - x0; dy = e.clientY - y0;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) moved = true;
      if (!moved) return;
      const up = -dy > Math.abs(dx);  // mostly upwards: super like
      card.style.transform = 'translate(' + dx + 'px,' + (up ? dy : dy * 0.15) + 'px) rotate(' + dx / 18 + 'deg)';
      yes.style.opacity = up ? 0 : Math.max(0, Math.min(1, dx / 90));
      no.style.opacity = up ? 0 : Math.max(0, Math.min(1, -dx / 90));
      sup.style.opacity = up ? Math.max(0, Math.min(1, -dy / 90)) : 0;
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
      if (-dy > 110 && -dy > Math.abs(dx)) return judge('super', card);
      if (dx > 100) return judge('like', card);
      if (dx < -100) return judge('hide', card);
      card.style.transition = 'transform .25s'; card.style.transform = ''; yes.style.opacity = no.style.opacity = sup.style.opacity = 0;
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
  }

  function judge(kind, card) {
    const c = cards[0];
    if (!c) return;
    card = card || stack.lastChild;
    haptic(kind === 'hide' ? 'light' : kind === 'super' ? 'heavy' : 'medium');
    card.style.transition = 'transform .3s ease-out';
    card.style.transform = kind === 'super' ? 'translate(0, -130vh)'
      : 'translate(' + (kind === 'like' ? 150 : -150) + 'vw, 40px) rotate(' + (kind === 'like' ? 30 : -30) + 'deg)';
    // Favourites: swiping right on your own like just moves on (no write); undo restores the previous reaction.
    const write = !(mode === 'fav' && (c.me === kind || (kind === 'like' && c.me === 'super')));
    cards.shift(); judged++; sent.add(c.id); history.push({ card: c, kind, write, prev: c.me });
    if (mode === 'fav') { if (kind === 'hide') favTotal--; else viewed.push(c); }
    if (history.length > 20) history.shift();
    if (write) api('/api/react', { id: c.id, kind, mine: mode === 'fav' }).catch(() => toast('Не сохранилось, проверьте интернет'));
    if (mode === 'fav') toast(kind === 'hide' ? '👎 Убрал из вашего избранного' : kind === 'super' ? '🌟 Точно смотреть' : write ? '❤️ И вам нравится' : '❤️ Оставил');
    else if (kind === 'like') toast('❤️ В избранном');
    else if (kind === 'super') toast('🌟 Суперлайк: список /super');
    setTimeout(render, 220);
    if (cards.length < 5) load();
  }

  function undo() {
    const last = history.pop();
    if (!last) return;
    sent.delete(last.card.id); judged = Math.max(0, judged - 1);
    if (mode === 'fav') {
      if (last.kind === 'hide') favTotal++;
      else if (viewed[viewed.length - 1] === last.card) viewed.pop();
    }
    cards.unshift(last.card);
    if (last.write !== false) {
      (last.prev ? api('/api/react', { id: last.card.id, kind: last.prev }) : api('/api/undo', { id: last.card.id })).catch(() => toast('Не удалось вернуть'));
    }
    if (last.kind === 'hide') toast('Вернул. Пост в чате уже удалён, но карточка снова здесь');
    render();
  }

  $('yes').onclick = () => judge('like');
  $('no').onclick = () => judge('hide');
  $('super').onclick = () => judge('super');
  $('undo').onclick = undo;
  // Favourites: ◀ ▶ only browse, nothing is saved.
  function browse(d) {
    if (d > 0 && cards.length) { const c = cards.shift(); viewed.push(c); sent.add(c.id); judged++; if (cards.length < 5) load(); }
    else if (d < 0 && viewed.length) { const c = viewed.pop(); cards.unshift(c); judged = Math.max(0, judged - 1); }
    else return;
    haptic('light');
    render();
  }
  $('prev').onclick = () => browse(-1);
  $('next').onclick = () => browse(1);
  document.addEventListener('keydown', (e) => {
    if (mode === 'fav' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) return browse(e.key === 'ArrowRight' ? 1 : -1);
    if (e.key === 'ArrowRight') judge('like'); if (e.key === 'ArrowLeft') judge('hide'); if (e.key === 'ArrowUp') judge('super');
  });
  render();
  load();
})();
</script>
</body>
</html>`;
