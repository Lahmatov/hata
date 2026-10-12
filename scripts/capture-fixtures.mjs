#!/usr/bin/env node
// Saves one real search page per active source into tests/fixtures/real/ (git-ignored), politely.
import { mkdir, writeFile } from 'node:fs/promises';
const UA = 'HataMonitor/0.1 (+https://github.com/lahmatov/hata; personal apartment search)';
const PAGES = {
  imovirtual: 'https://www.imovirtual.com/pt/resultados/comprar/apartamento,t3/lisboa/amadora?priceMax=430000&by=LATEST&direction=DESC&limit=72',
  custojusto: 'https://www.custojusto.pt/lisboa/amadora/imobiliario/apartamentos-venda',
};
await mkdir('tests/fixtures/real', { recursive: true });
for (const [name, url] of Object.entries(PAGES)) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'pt-PT' } });
  await writeFile(`tests/fixtures/real/${name}-search.html`, await res.text());
  console.log(`${name}: HTTP ${res.status}`);
  await new Promise((r) => setTimeout(r, 6000));
}
