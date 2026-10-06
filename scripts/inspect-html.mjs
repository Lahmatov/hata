#!/usr/bin/env node
// Prints structural hints for saved pages (used to design adapters without a browser).
// Usage: node scripts/inspect-html.mjs probe-output/*.html
import { readFile } from 'node:fs/promises';

const CHALLENGE = /captcha|cf-chl|challenge-platform|just a moment|datadome|px-captcha|_incapsula_|perimeterx|cf-turnstile|access denied/gi;
const PRICEISH = /price|preco|valor|amount/i;

// Find arrays of objects that look like listings (have a price-ish key), anywhere in a JSON tree.
function findListingArrays(node, path = '$', out = []) {
  if (Array.isArray(node)) {
    const objs = node.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (objs.length >= 3 && objs.some((o) => Object.keys(o).some((k) => PRICEISH.test(k)))) out.push({ path, len: node.length, sample: objs[0] });
    node.slice(0, 50).forEach((v, i) => findListingArrays(v, `${path}[${i}]`, out));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) findListingArrays(v, `${path}.${k}`, out);
  }
  return out;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

for (const file of process.argv.slice(2)) {
  const html = await readFile(file, 'utf8');
  console.log(`\n===== ${file} (${html.length} bytes) =====`);
  console.log('title:', html.match(/<title[^>]*>([^<]*)/i)?.[1]?.trim());
  const ch = [...html.matchAll(CHALLENGE)].slice(0, 3).map((m) => clip(html.slice(Math.max(0, m.index - 80), m.index + 60).replace(/\s+/g, ' '), 160));
  if (ch.length) console.log('challenge contexts:', ch);

  const ld = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  for (const block of ld.slice(0, 4)) {
    try {
      const j = JSON.parse(block);
      const types = JSON.stringify(j).match(/"@type":"[^"]+"/g) ?? [];
      console.log('JSON-LD types:', [...new Set(types)].slice(0, 12).join(' '));
      console.log('JSON-LD sample:', clip(JSON.stringify(j), 1200));
    } catch { console.log('JSON-LD (unparsable):', clip(block, 200)); }
  }

  const nd = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (nd) {
    try {
      const j = JSON.parse(nd);
      console.log('__NEXT_DATA__ page:', j.page, 'pageProps keys:', Object.keys(j.props?.pageProps ?? {}).slice(0, 20));
      for (const a of findListingArrays(j).slice(0, 4)) console.log(`listing-like array ${a.path} (${a.len}):`, clip(JSON.stringify(a.sample), 2500));
    } catch (e) { console.log('__NEXT_DATA__ parse error', e.message); }
  }

  const ps = html.match(/window\.__PRERENDERED_STATE__\s*=\s*("(?:[^"\\]|\\.)*")/)?.[1];
  if (ps) {
    try {
      const j = JSON.parse(JSON.parse(ps));
      for (const a of findListingArrays(j).slice(0, 2)) console.log(`PRERENDERED listing-like array ${a.path} (${a.len}):`, clip(JSON.stringify(a.sample), 3000));
    } catch (e) { console.log('__PRERENDERED_STATE__ parse error', e.message); }
  }
  for (const block of ld) {
    try {
      const items = JSON.stringify(JSON.parse(block)).match(/\{"@context":"https:\/\/schema.org","@type":"(?:SingleFamilyResidence|Apartment|Residence|Accommodation|Offer)"[^]*?\}\}/g);
      if (items) console.log('JSON-LD item sample:', clip(items[0], 2500));
    } catch {}
  }
  const priceIdx = [...html.matchAll(/\d{2,3}[.\s\u00a0]\d{3}\s?(?:€|&euro;|&#x20AC;)/g)].map((m) => m.index);
  if (priceIdx.length >= 3) {
    const i = priceIdx[2];
    console.log('card snippet:', html.slice(Math.max(0, i - 2500), i + 1500).replace(/\s+/g, ' '));
  }

  const links = [...new Set([...html.matchAll(/href="([^"#]+)"/g)].map((m) => m[1]))];
  const listingLinks = links.filter((l) => /imove|anuncio|comprar|venda|apartamento|propert|listing/i.test(l));
  console.log(`links: ${links.length}, listing-ish (${listingLinks.length}):`, listingLinks.slice(0, 25));
  const apis = [...new Set([...html.matchAll(/["'](https?:\/\/[^"']*\/api\/[^"']{0,80}|\/api\/[^"']{0,80})["']/g)].map((m) => m[1]))];
  if (apis.length) console.log('api hints:', apis.slice(0, 15));
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  console.log('visible text:', clip(text, 600));
}
