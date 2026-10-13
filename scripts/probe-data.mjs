// One-off check from a GitHub runner: open-data sources for enriching favourites (round 2). Prints excerpts only.
const UA = 'hata-apartment-monitor/1.0 (personal, non-commercial; github.com/Lahmatov/hata)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(label, url, timeout = 60000) {
  console.log(`\n=== ${label}\n${url.slice(0, 400)}`);
  try {
    const t0 = Date.now();
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeout) });
    const text = await res.text();
    console.log(`HTTP ${res.status} ${res.headers.get('content-type')} ${text.length} bytes in ${Date.now() - t0} ms`);
    await sleep(1500);
    return text;
  } catch (e) { console.log(`ERROR ${e.message}`); return ''; }
}
const json = (t) => { try { return JSON.parse(t); } catch { return null; } };

// 1. INE: freguesia codes from the metadata (dimension 2)
const meta = json(await get('INE meta', 'https://www.ine.pt/ine/json_indicador/pindicaMeta.jsp?varcd=0012234&lang=PT'));
const cats = meta?.[0]?.Dimensoes?.Categoria_Dim ?? [];
const dim2 = cats.flatMap((c) => Object.entries(c)).filter(([k]) => k.startsWith('Dim_Num2')).flatMap(([, v]) => v);
console.log('dim2 entries:', dim2.length, 'sample:', JSON.stringify(dim2[0]));
const ours = dim2.filter((x) => /^1A01(106|115|110|111|116)/.test(x.cat_id));
console.log(ours.map((x) => `${x.cat_id}=${x.categ_dsg}`).join(' | '));
const dim3 = cats.flatMap((c) => Object.entries(c)).filter(([k]) => k.startsWith('Dim_Num3')).flatMap(([, v]) => v);
console.log('dim3:', dim3.map((x) => `${x.cat_id}=${x.categ_dsg}`).join(' | '));
const fr = ours.filter((x) => x.cat_id.length > 7).map((x) => x.cat_id);
for (let i = 0; i < fr.length; i += 30) {
  const d = json(await get(`INE freguesias ${i}`, `https://www.ine.pt/ine/json_indicador/pindica.jsp?op=2&varcd=0012234&lang=PT&Dim2=${fr.slice(i, i + 30).join(',')}&Dim3=H1`));
  const rows = Object.values(d?.[0]?.Dados ?? {})[0] ?? [];
  console.log(rows.map((r) => `${r.geocod} ${r.geodsg}: ${r.valor ?? r.Sinal_Conv ?? '-'}`).join('\n'));
}

// 2. APA flood: query (not identify) on the flood-area and ARPSI layers, small envelope, WGS84
for (const [name, lat, lon] of [['Odivelas centro', 38.7929, -9.1838], ['Póvoa Sto Adrião (Trancão)', 38.7998, -9.1655], ['Benfica', 38.7505, -9.2008]]) {
  for (const [svc, layer] of [['Diretiva200760CE_2c', 0], ['Risco_Inundacao_Potencialmente_Significativas', 0]]) {
    const t = await get(`APA ${svc}/${layer} at ${name}`, `https://sniambgeoogc.apambiente.pt/getogc/rest/services/SNIAmb/${svc}/MapServer/${layer}/query?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=false&f=json`);
    console.log(t.slice(0, 700));
  }
}

// 3. EEA airport noise: all services, then airport-related layer lists and a point query near Benfica
const svcs = json(await get('EEA Noise services', 'https://noise.discomap.eea.europa.eu/arcgis/rest/services/Noise?f=json'))?.services ?? [];
console.log(svcs.map((s) => `${s.name}:${s.type}`).join(' | '));
for (const s of svcs.filter((s) => /airport|air|Contour|Dyna/i.test(s.name)).slice(0, 8)) {
  const j = json(await get(`EEA ${s.name} layers`, `https://noise.discomap.eea.europa.eu/arcgis/rest/services/${s.name}/${s.type}?f=json`));
  console.log((j?.layers ?? []).map((l) => `${l.id}:${l.name}`).join(' | ').slice(0, 1200) || JSON.stringify(j).slice(0, 400));
}
