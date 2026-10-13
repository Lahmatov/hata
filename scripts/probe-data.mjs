// One-off check from a GitHub runner (round 3): APA flood layers and EEA aircraft-noise mosaics by point.
const UA = 'hata-apartment-monitor/1.0 (personal, non-commercial; github.com/Lahmatov/hata)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(label, url) {
  console.log(`\n=== ${label}\n${url.slice(0, 400)}`);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
    const text = await res.text();
    console.log(`HTTP ${res.status} ${text.length} bytes`);
    await sleep(1200);
    return text;
  } catch (e) { console.log(`ERROR ${e.message}`); return ''; }
}
const json = (t) => { try { return JSON.parse(t); } catch { return null; } };
const POINTS = [['Campo Grande (under the approach)', 38.7585, -9.1570], ['Benfica', 38.7505, -9.2008], ['Carnide', 38.7600, -9.1880],
  ['Alfragide (school)', 38.7358, -9.2261], ['Odivelas', 38.7929, -9.1838], ['Póvoa Sto Adrião', 38.7998, -9.1655], ['Mem Martins', 38.7980, -9.3320]];

// APA flood: layer details, then a point query on each feature layer
const svc = 'https://sniambgeoogc.apambiente.pt/getogc/rest/services/SNIAmb/Diretiva200760CE_2c/MapServer';
const layers = json(await get('APA flood layers (full)', `${svc}/layers?f=json`))?.layers ?? [];
for (const l of layers) console.log(`${l.id}: ${l.name} | ${l.type} | geom=${l.geometryType} | sub=${JSON.stringify(l.subLayers?.map((s) => s.id))} | fields=${(l.fields ?? []).map((f) => f.name).join(',').slice(0, 200)}`);
for (const l of layers.filter((x) => x.type === 'Feature Layer').slice(0, 6)) {
  for (const [name, lat, lon] of POINTS.slice(4, 6)) {
    const t = await get(`APA flood ${l.id} ${l.name} at ${name}`, `${svc}/${l.id}/query?geometry=${encodeURIComponent(JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }))}&geometryType=esriGeometryPoint&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=false&f=json`);
    console.log(t.slice(0, 500));
  }
}
const arpsi = 'https://sniambgeoogc.apambiente.pt/getogc/rest/services/SNIAmb/Risco_Inundacao_Potencialmente_Significativas/MapServer/0/query';
const near = await get('APA ARPSI within 3 km of Odivelas', `${arpsi}?geometry=-9.1838,38.7929&geometryType=esriGeometryPoint&inSR=4326&distance=3000&units=esriSRUnit_Meter&spatialRel=esriSpatialRelIntersects&outFields=name,local&returnGeometry=false&f=json`);
console.log(near.slice(0, 800));

// EEA aircraft noise mosaics: service info (pixel type, value meaning), then identify per point
for (const s of ['mosaic_air_day', 'mosaic_air_night']) {
  const info = json(await get(`EEA ${s} info`, `https://noise.discomap.eea.europa.eu/arcgis/rest/services/Noise/${s}/ImageServer?f=json`));
  if (info) console.log(JSON.stringify({ name: info.name, description: (info.description ?? '').slice(0, 600), pixelType: info.pixelType, bandCount: info.bandCount, minValues: info.minValues, maxValues: info.maxValues, hasRasterAttributeTable: info.hasRasterAttributeTable, copyright: info.copyrightText }));
  for (const [name, lat, lon] of POINTS) {
    const t = await get(`EEA ${s} at ${name}`, `https://noise.discomap.eea.europa.eu/arcgis/rest/services/Noise/${s}/ImageServer/identify?geometry=${encodeURIComponent(JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }))}&geometryType=esriGeometryPoint&returnGeometry=false&returnCatalogItems=false&f=json`);
    const j = json(t);
    console.log(j ? JSON.stringify({ value: j.value, properties: j.properties }).slice(0, 300) : t.slice(0, 300));
  }
  const rat = await get(`EEA ${s} raster attribute table`, `https://noise.discomap.eea.europa.eu/arcgis/rest/services/Noise/${s}/ImageServer/rasterAttributeTable?f=json`);
  console.log(rat.slice(0, 1000));
}
