#!/usr/bin/env node
// Step 0: probe each candidate source with a plain, identifiable request.
// No headless browser, no proxies, no retries around bot protection.
// Usage: node scripts/probe-sources.mjs [--only=imovirtual,olx]
// Output: probe-output/report.md (+ raw HTML per source, reusable as test fixtures).

import { mkdir, writeFile } from 'node:fs/promises';

const UA = 'HataMonitor/0.1 (+https://github.com/lahmatov/hata; personal apartment search; 1 req per 6s)';
const DELAY_MS = 6000;
const OUT = 'probe-output';

// Search URLs are best guesses; if a source is "ok" but shows no listings, the path may need adjusting.
const SOURCES = [
  { id: 'imovirtual', base: 'https://www.imovirtual.com', search: '/pt/resultados/comprar/apartamento,t3/lisboa/amadora' },
  { id: 'casasapo', base: 'https://casa.sapo.pt', search: '/comprar-apartamentos/t3/amadora/' },
  { id: 'supercasa', base: 'https://supercasa.pt', search: '/comprar-casas/amadora' },
  { id: 'custojusto', base: 'https://www.custojusto.pt', search: '/lisboa/amadora/imobiliario/apartamentos' },
  { id: 'olx', base: 'https://www.olx.pt', search: '/imoveis/apartamento-casa-a-venda/apartamentos-venda/amadora/' },
  { id: 'trovit', base: 'https://casa.trovit.pt', search: '/t3-municipio-amadora' },
  { id: 'remax', base: 'https://www.remax.pt', search: '/pt/comprar/imoveis/habitacao/lisboa/amadora/r/t' },
  { id: 'century21', base: 'https://www.century21.pt', search: '/comprar/imoveis/distrito-lisboa/concelho-amadora' },
  { id: 'era', base: 'https://www.era.pt', search: '/comprar?ob=1&tp=1&ord=3&page=1' },
  { id: 'kw', base: 'https://www.kwportugal.pt', search: '/pt/imoveis' },
  { id: 'zome', base: 'https://www.zome.pt', search: '/pt/pesquisar/comprar-casa/apartamento/t3/l1-lisboa/l2-amadora' },
  // Bank portals (Novo Banco and BPI have no own listing portal: their stock is on Casa Sapo / agencies).
  { id: 'millennium', base: 'https://millenniumimoveis.janeladigital.com', search: '/Default.aspx' },
  { id: 'santander', base: 'https://imoveis.santander.pt', search: '/imoveis' },
  { id: 'cgd', base: 'https://www.caixaimobiliario.pt', search: '/' },
  { id: 'montepio', base: 'https://www.montepioimoveis.pt', search: '/' },
  { id: 'idealista', base: 'https://www.idealista.pt', search: '/comprar-casas/amadora/' },
];

const CHALLENGE = /captcha|cf-chl|challenge-platform|just a moment|datadome|px-captcha|_incapsula_|perimeterx|cf-turnstile|access denied|request unsuccessful/i;
const PRICE = /\d{2,3}[.\s ]\d{3}(?:[.,]\d{2})?\s?(?:€|&euro;|EUR)/g;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*', 'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8' },
    });
    const body = await res.text();
    return { status: res.status, url: res.url, body, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, url, body: '', ms: Date.now() - t0, error: String(e.cause?.code ?? e.message) };
  }
}

// Minimal robots.txt matcher: groups for "*" (or our UA token), longest match wins, Allow beats Disallow on tie.
function robotsAllows(robots, path) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [, k, v] = m;
    const key = k.toLowerCase();
    if (key === 'user-agent') {
      if (!lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(v.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === 'allow' || key === 'disallow') && v) cur.rules.push({ allow: key === 'allow', pattern: v });
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a.includes('hatamonitor')));
  const rules = (mine.length ? mine : groups.filter((g) => g.agents.includes('*'))).flatMap((g) => g.rules);
  let best = null;
  for (const r of rules) {
    const re = new RegExp('^' + r.pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(path) && (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow))) best = r;
  }
  return best ? best.allow : true;
}

function classify(page, robotsOk) {
  if (page.status === 0) return { verdict: 'error', notes: page.error };
  if (!robotsOk) return { verdict: 'skip (robots.txt)', notes: 'search path disallowed for *' };
  // Big pages often mention "captcha" in config; only small pages with markers are interstitials.
  if ([401, 403, 429, 503].includes(page.status) || (page.body.length < 60000 && CHALLENGE.test(page.body))) {
    const marker = page.body.match(CHALLENGE)?.[0];
    return { verdict: 'blocked', notes: `HTTP ${page.status}${marker ? `, marker "${marker}"` : ''}` };
  }
  if (page.status >= 400) return { verdict: 'error', notes: `HTTP ${page.status}` };
  const prices = (page.body.match(PRICE) ?? []).length;
  const how = [
    /__NEXT_DATA__/.test(page.body) && '__NEXT_DATA__',
    /application\/ld\+json/.test(page.body) && 'JSON-LD',
    /__NUXT__|window\.__INITIAL_STATE__|window\.__PRELOADED_STATE__/.test(page.body) && 'inline state',
  ].filter(Boolean);
  if (prices >= 5) return { verdict: 'ok', notes: `${prices} prices in HTML${how.length ? '; ' + how.join(', ') : ''}` };
  return { verdict: 'unclear', notes: `HTTP ${page.status}, ${prices} prices — JS-rendered or wrong search URL${how.length ? '; ' + how.join(', ') : ''}` };
}

async function probe(src) {
  const robots = await get(src.base + '/robots.txt');
  const robotsText = robots.status === 200 && !/<html/i.test(robots.body) ? robots.body : '';
  await sleep(DELAY_MS);
  const page = await get(src.base + src.search);
  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}/${src.id}.html`, page.body);
  await writeFile(`${OUT}/${src.id}.robots.txt`, robots.body);
  const robotsOk = robotsAllows(robotsText, src.search);
  const res = { ...src, robots: robots.status, status: page.status, finalUrl: page.url, ms: page.ms, size: page.body.length, ...classify(page, robotsOk) };
  console.log(`${src.id.padEnd(11)} ${res.verdict.padEnd(18)} ${res.notes}`);
  return res;
}

const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',');
const list = only ? SOURCES.filter((s) => only.includes(s.id)) : SOURCES;
console.log(`Probing ${list.length} sources (different hosts in parallel, ${DELAY_MS / 1000}s between requests per host)...\n`);
const results = await Promise.all(list.map(probe));

const rows = results.map((r) => `| ${r.id} | ${r.verdict} | HTTP ${r.status}, robots ${r.robots}, ${Math.round(r.size / 1024)} KB | ${r.notes} | ${r.base + r.search} |`);
const md = `# Source probe ${new Date().toISOString()}\n\nUA: \`${UA}\`\n\n| source | verdict | how | notes | url |\n|---|---|---|---|---|\n${rows.join('\n')}\n`;
await writeFile(`${OUT}/report.md`, md);
console.log(`\nReport: ${OUT}/report.md (send me this file or paste its contents)`);
