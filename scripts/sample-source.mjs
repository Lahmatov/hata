#!/usr/bin/env node
// Fetches one search page + one detail page per source and prints the pruned data structures.
// Plain requests, identifiable UA, 8 s between requests. Usage: node scripts/sample-source.mjs imovirtual custojusto olx
import { mkdir, writeFile } from 'node:fs/promises';

const UA = 'HataMonitor/0.1 (+https://github.com/lahmatov/hata; personal apartment search; 1 req per 8s)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'pt-PT,pt;q=0.9' }, signal: AbortSignal.timeout(30000) });
  const body = await res.text();
  console.log(`GET ${url} -> ${res.status}, ${body.length} bytes`);
  await sleep(8000);
  return body;
}
function prune(v, depth = 0) {
  if (depth > 7) return '…';
  if (Array.isArray(v)) return v.length > 4 ? [...v.slice(0, 4).map((x) => prune(x, depth + 1)), `…+${v.length - 4}`] : v.map((x) => prune(x, depth + 1));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (/image|photo|picture|thumbnail|tracking|seo|i18n|translations/i.test(k)) continue;
      o[k] = prune(x, depth + 1);
    }
    return o;
  }
  return typeof v === 'string' && v.length > 160 ? v.slice(0, 160) + '…' : v;
}
const nextData = (html) => JSON.parse(html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)[1]);
const show = (label, v) => console.log(`\n--- ${label} ---\n${JSON.stringify(prune(v), null, 1).slice(0, 9000)}`);
await mkdir('probe-output/samples', { recursive: true });
const save = (name, html) => writeFile(`probe-output/samples/${name}.html`, html);

const SOURCES = {
  async imovirtual() {
    const html = await get('https://www.imovirtual.com/pt/resultados/comprar/apartamento,t3/lisboa/amadora');
    await save('imovirtual-search', html);
    const items = nextData(html).props.pageProps.data.searchAds.items;
    show('imovirtual search item[0]', items[0]);
    show('imovirtual searchAds keys/pagination', Object.fromEntries(Object.entries(nextData(html).props.pageProps.data.searchAds).filter(([k]) => k !== 'items')));
    const detail = await get(`https://www.imovirtual.com/pt/anuncio/${items[0].slug}`);
    await save('imovirtual-detail', detail);
    const ad = nextData(detail).props.pageProps.ad;
    console.log('\nimovirtual ad keys:', Object.keys(ad));
    show('imovirtual ad.characteristics', ad.characteristics);
    show('imovirtual ad.featuresByCategory', ad.featuresByCategory ?? ad.features);
    show('imovirtual ad.location', ad.location);
    show('imovirtual ad.target', ad.target);
  },
  async custojusto() {
    const html = await get('https://www.custojusto.pt/lisboa/amadora/imobiliario/apartamentos-venda');
    await save('custojusto-search', html);
    const pp = nextData(html).props.pageProps;
    show('custojusto listItems[0..1]', pp.listItems.slice(0, 2));
    show('custojusto queryData', pp.queryData);
    const detail = await get(`https://www.custojusto.pt${pp.listItems[0].url}`);
    await save('custojusto-detail', detail);
    const dp = nextData(detail).props.pageProps;
    console.log('\ncustojusto detail pageProps keys:', Object.keys(dp));
    show('custojusto detail (pruned)', dp.adData ?? dp.ad ?? dp);
  },
  async olx() {
    const html = await get('https://www.olx.pt/imoveis/apartamento-casa-a-venda/apartamentos-venda/amadora/?search%5Bfilter_enum_tipologia%5D%5B0%5D=t3');
    await save('olx-search', html);
    const m = html.match(/window\.__PRERENDERED_STATE__\s*=\s*("(?:[^"\\]|\\.)*")/);
    if (!m) { console.log('no __PRERENDERED_STATE__; script ids:', [...html.matchAll(/<script[^>]*id="([^"]+)"/g)].map((x) => x[1])); return; }
    const state = JSON.parse(JSON.parse(m[1]));
    console.log('\nolx state keys:', Object.keys(state), 'listing keys:', Object.keys(state.listing ?? {}));
    const ads = state.listing?.listing?.ads ?? [];
    console.log('olx ads:', ads.length, 'external urls:', ads.filter((a) => !/olx\.pt/.test(a.url)).length);
    show('olx ad[0]', ads.find((a) => /olx\.pt/.test(a.url)) ?? ads[0]);
  },
};

for (const id of process.argv.slice(2)) {
  console.log(`\n================ ${id} ================`);
  try { await SOURCES[id](); } catch (e) { console.log(`${id} failed:`, e.message); }
}
