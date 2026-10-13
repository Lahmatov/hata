// One-off check from a GitHub runner: which open-data sources for the favourites enrichment answer, and how.
// Prints short excerpts only. Run: node scripts/probe-data.mjs
const UA = 'hata-apartment-monitor/1.0 (personal, non-commercial; github.com/Lahmatov/hata)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(label, url, init = {}) {
  console.log(`\n=== ${label}\n${url.slice(0, 300)}`);
  try {
    const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    console.log(`HTTP ${res.status} ${res.headers.get('content-type')} ${text.length} bytes`);
    await sleep(2000);
    return { status: res.status, text };
  } catch (e) {
    console.log(`ERROR ${e.message}`);
    return { status: 0, text: '' };
  }
}
const json = (t) => { try { return JSON.parse(t); } catch { return null; } };
const show = (v, n = 1500) => console.log(JSON.stringify(v, null, 1).slice(0, n));

// 1. INE median sale €/m² (last 12 months), municipalities and freguesias
const meta = await get('INE meta 0012234', 'https://www.ine.pt/ine/json_indicador/pindicaMeta.jsp?varcd=0012234&lang=PT');
const m = json(meta.text);
if (m) {
  const s = JSON.stringify(m);
  console.log(s.slice(0, 1200));
  const geos = [...s.matchAll(/"cat_id":"(1A01(?:106|115|110|111|116)\d*)","categ_dsg":"([^"]+)"/g)].map((x) => `${x[1]}=${x[2]}`);
  console.log('geo codes found:', geos.length, geos.slice(0, 80).join(' | '));
}
const muni = '1A01106,1A01115,1A01110,1A01111,1A01116';
const d = await get('INE data municipalities', `https://www.ine.pt/ine/json_indicador/pindica.jsp?op=2&varcd=0012234&lang=PT&Dim2=${muni}&Dim3=H1`);
show(json(d.text), 2500);
const f = await get('INE data freguesias (Benfica, Carnide, SDB, AMM)', 'https://www.ine.pt/ine/json_indicador/pindica.jsp?op=2&varcd=0012234&lang=PT&Dim2=1A0110608,1A0110618,1A0110666,1A0111101&Dim3=H1');
show(json(f.text), 2000);

// 2. APA flood zones (Directive 2007/60/EC, 2nd cycle)
for (const svc of ['SNIAmb/Diretiva200760CE_2c', 'SNIAmb/Risco_Inundacao_Potencialmente_Significativas', 'Visualizador/END_externo']) {
  const r = await get(`APA ${svc} layers`, `https://sniambgeoogc.apambiente.pt/getogc/rest/services/${svc}/MapServer?f=json`);
  const j = json(r.text);
  if (j?.layers) console.log(j.layers.map((l) => `${l.id}:${l.name}`).join(' | ').slice(0, 2500));
  else console.log(r.text.slice(0, 500));
}
// Odivelas centre (near the Trancão / ribeira de Odivelas) and Benfica
for (const [name, lat, lon] of [['Odivelas', 38.7929, -9.1838], ['Benfica', 38.7505, -9.2008]]) {
  const r = await get(`APA flood point ${name}`, `https://sniambgeoogc.apambiente.pt/getogc/rest/services/SNIAmb/Diretiva200760CE_2c/MapServer/identify?geometry=${lon},${lat}&geometryType=esriGeometryPoint&sr=4326&layers=all&tolerance=2&mapExtent=${lon - 0.01},${lat - 0.01},${lon + 0.01},${lat + 0.01}&imageDisplay=400,400,96&returnGeometry=false&f=json`);
  console.log(r.text.slice(0, 800));
}

// 3. Noise: EEA, Lisbon open data
const eea = await get('EEA noise services', 'https://noise.discomap.eea.europa.eu/arcgis/rest/services/Noise?f=json');
console.log(eea.text.slice(0, 1500));
const eeaDyna = await get('EEA Noise_Dyna_LAEA layers', 'https://noise.discomap.eea.europa.eu/arcgis/rest/services/Noise/Noise_Dyna_LAEA/MapServer?f=json');
const ej = json(eeaDyna.text);
if (ej?.layers) console.log(ej.layers.map((l) => `${l.id}:${l.name}`).join(' | ').slice(0, 2500));
const cml = await get('Lisbon open data: mapa-do-ruido', 'https://dadosabertos.cm-lisboa.pt/api/3/action/package_show?id=mapa-do-ruido');
const cj = json(cml.text);
if (cj?.result) console.log(cj.result.resources.map((r) => `${r.name} | ${r.format} | ${r.url}`).join('\n'));
else console.log(cml.text.slice(0, 500));

// 4. Overpass around Benfica
const q = `[out:json][timeout:30];(nwr(around:1000,38.7505,-9.2008)[railway=station];nwr(around:1000,38.7505,-9.2008)[station=subway];nwr(around:800,38.7505,-9.2008)[shop=supermarket];nwr(around:800,38.7505,-9.2008)[amenity=pharmacy];nwr(around:800,38.7505,-9.2008)[leisure=park];nwr(around:800,38.7505,-9.2008)[leisure=playground];);out center tags 40;`;
const o = await get('Overpass Benfica', 'https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
const oj = json(o.text);
if (oj?.elements) console.log(oj.elements.map((e) => `${e.type}/${e.id} ${Object.entries(e.tags ?? {}).filter(([k]) => /^(name|railway|station|shop|amenity|leisure)$/.test(k)).map(([k, v]) => k + '=' + v).join(',')} @${e.lat ?? e.center?.lat},${e.lon ?? e.center?.lon}`).join('\n'));
else console.log(o.text.slice(0, 500));
