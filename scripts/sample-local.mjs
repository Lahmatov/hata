#!/usr/bin/env node
// Dumps compact structure of saved Casa Sapo / Trovit pages (+ one Casa Sapo detail page, politely).
// Usage: node scripts/sample-local.mjs > ~/Desktop/sample.txt
import { readFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';

const UA = 'HataMonitor/0.1 (+https://github.com/lahmatov/hata; personal apartment search)';
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
const squash = (s) => s.replace(/\s+/g, ' ').trim();

// ---------- Casa Sapo ----------
const cs = await readFile('probe-output/casasapo.html', 'utf8');
const $ = cheerio.load(cs);
const cards = $('a.property-info');
console.log(`\n===== CASA SAPO: ${cards.length} a.property-info cards`);
const card = cards.first().closest('[class*="property"]').parent();
console.log('card container classes:', cards.first().parents().slice(0, 4).map((_, e) => $(e).attr('class')).get());
console.log('card html:', clip(squash(card.html() ?? ''), 3500));
cards.slice(0, 5).each((_, a) => {
  const el = $(a);
  console.log('-', JSON.stringify({
    type: squash(el.find('.property-type').text()), loc: squash(el.find('.property-location').text()),
    feat: squash(el.find('.property-features-text').text()), tags: el.find('.property-features-tag span').map((_, t) => $(t).text()).get(),
    price: squash(el.find('.property-price-value').text()), href: clip(el.attr('href') ?? '', 300),
  }));
});
console.log('pagination links:', [...new Set($('a[href*="pn="]').map((_, a) => $(a).attr('href')).get())].slice(0, 5));
console.log('sort links:', [...new Set($('a[href*="comprar-apartamentos/t3/amadora"][href*="?"]').map((_, a) => $(a).attr('href')).get())].slice(0, 10));
console.log('JSON-LD types:', $('script[type="application/ld+json"]').map((_, s) => (s.children[0]?.data ?? '').match(/"@type":"[^"]+"/g)?.slice(0, 6).join(' ')).get());

const href = cards.first().attr('href') ?? '';
const detailUrl = decodeURIComponent(href.match(/[?&]l=([^&]+)/)?.[1] ?? href).replace(/\?g3pid=\d+.*/, '');
console.log('\n===== CASA SAPO DETAIL', detailUrl);
await new Promise((r) => setTimeout(r, 6000));
const res = await fetch(detailUrl, { headers: { 'User-Agent': UA, 'Accept-Language': 'pt-PT' } });
const d = await res.text();
console.log('status', res.status, 'bytes', d.length);
const $d = cheerio.load(d);
$d('script[type="application/ld+json"]').each((_, s) => console.log('detail JSON-LD:', clip(squash(s.children[0]?.data ?? ''), 1500)));
const text = squash($d('body').text());
for (const kw of ['Casas de banho', 'Casa de banho', 'WC', 'Garagem', 'Estacionamento', 'Elevador', 'Andar', 'Piso', 'Área útil', 'Estado', 'Certificado']) {
  const i = text.indexOf(kw);
  if (i >= 0) console.log(`[${kw}]`, clip(text.slice(Math.max(0, i - 60), i + 120), 200));
}
console.log('coords:', d.match(/(lat(itude)?["':= ]+-?\d{2}\.\d+)[^]{0,40}?(lo?ng(itude)?["':= ]+-?\d{1,2}\.\d+)/i)?.[0] ?? 'none');
const feats = $d('[class*="feature"], [class*="detail"] li').map((_, e) => squash($d(e).text())).get().filter((t) => t && t.length < 80);
console.log('feature-like items:', [...new Set(feats)].slice(0, 40));

// ---------- Trovit ----------
const tv = await readFile('probe-output/trovit.html', 'utf8');
const $t = cheerio.load(tv);
console.log('\n===== TROVIT');
$t('script[type="application/ld+json"]').each((_, s) => {
  try {
    const j = JSON.parse(s.children[0]?.data ?? '');
    const about = (Array.isArray(j) ? j : [j]).flatMap((x) => x.about ?? []);
    if (about.length) {
      console.log(`JSON-LD about[]: ${about.length} items; keys:`, Object.keys(about[0]));
      for (const it of about.slice(0, 2)) console.log(clip(JSON.stringify({ ...it, description: clip(it.description ?? '', 120), image: undefined }), 1500));
    }
  } catch {}
});
const classes = new Map();
$t('[class]').each((_, e) => ($t(e).attr('class') ?? '').split(/\s+/).forEach((c) => /item|snippet|card|result|ad-|listing/i.test(c) && classes.set(c, (classes.get(c) ?? 0) + 1)));
console.log('card-like classes:', [...classes].filter(([, n]) => n >= 10).slice(0, 25));
const start = tv.indexOf('1-30 de');
const priceIdx = tv.slice(start).search(/\d{2,3}[ . ]\d{3}\s?€/);
if (priceIdx > 0) console.log('first card html:', clip(squash(tv.slice(start + priceIdx - 2500, start + priceIdx + 1500)), 4000));
console.log('outgoing links sample:', [...new Set($t('a[href]').map((_, a) => $t(a).attr('href')).get().filter((h) => /rd\.|\/rd\/|redirect|imovel|anuncio|ad\//i.test(h)))].slice(0, 8));
