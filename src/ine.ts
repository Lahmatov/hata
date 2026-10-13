import { config, norm } from './config.ts';
import type { Store } from './db.ts';
import { log } from './log.ts';
import type { Listing } from './types.ts';

// What flats actually sell for: INE median value per m² of dwelling sales over the last 12 months (indicator
// 0012234, quarterly, municipalities and — in Greater Lisbon — parishes; CC-BY, "INE, Estatísticas de preços da
// habitação ao nível local"). Asking prices sit above it; the gap is an argument when negotiating.

const API = 'https://www.ine.pt/ine/json_indicador';
const MUNICIPALITIES: Record<string, string> = { lisboa: '1A01106', amadora: '1A01115', oeiras: '1A01110', sintra: '1A01111', odivelas: '1A01116' };

export interface InePrices { period: string; muni: Record<string, number>; parish: Record<string, Record<string, number>> }

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'User-Agent': config.userAgent }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

type Row = { geocod: string; geodsg: string; valor?: string };
type Data = { UltimoPref?: string; Dados?: Record<string, Row[]> }[];

/** Weekly refresh of the municipal and parish medians (two small requests plus the metadata). */
export async function refreshIne(store: Store): Promise<InePrices | undefined> {
  const cached = store.kvGet<InePrices>('ine:prices', 24 * 7);
  if (cached) return cached;
  try {
    const meta = await getJson<{ Dimensoes?: { Categoria_Dim?: Record<string, { cat_id: string }[]>[] } }[]>(`${API}/pindicaMeta.jsp?varcd=0012234&lang=PT`);
    const codes = (meta[0]?.Dimensoes?.Categoria_Dim ?? []).flatMap((c) => Object.entries(c))
      .filter(([k]) => k.startsWith('Dim_Num2')).flatMap(([, v]) => v.map((x) => x.cat_id))
      .filter((id) => Object.values(MUNICIPALITIES).some((m) => id.startsWith(m)));
    const out: InePrices = { period: '', muni: {}, parish: {} };
    for (let i = 0; i < codes.length; i += 40) {
      const d = await getJson<Data>(`${API}/pindica.jsp?op=2&varcd=0012234&lang=PT&Dim2=${codes.slice(i, i + 40).join(',')}&Dim3=H1`);
      out.period = d[0]?.UltimoPref ?? out.period;
      for (const r of Object.values(d[0]?.Dados ?? {})[0] ?? []) {
        const v = Number(r.valor);
        if (!Number.isFinite(v) || v <= 0) continue;
        if (r.geocod.length === 7) out.muni[r.geocod] = v;
        else (out.parish[r.geocod.slice(0, 7)] ??= {})[norm(r.geodsg)] = v;
      }
    }
    if (!Object.keys(out.muni).length) throw new Error('no values in the response');
    store.kvSet('ine:prices', out);
    log.info(`INE: sale medians for ${out.period}: ${Object.keys(out.muni).length} municipalities, ${Object.values(out.parish).reduce((s, p) => s + Object.keys(p).length, 0)} parishes`);
    return out;
  } catch (e) {
    log.warn(`INE: ${(e as Error).message}`);
    return store.kvGet<InePrices>('ine:prices');
  }
}

/** The median for the flat's parish when INE publishes it, else its municipality. */
export function ineMedian(prices: InePrices | undefined, l: Pick<Listing, 'municipality' | 'neighborhood'>): { v: number; where: string } | null {
  if (!prices) return null;
  const muni = Object.entries(MUNICIPALITIES).find(([name]) => norm(l.municipality) === name || norm(l.neighborhood) === name)?.[1];
  if (!muni) return null;
  const parishes = prices.parish[muni] ?? {};
  const n = norm(l.neighborhood);
  // Exact name first: "Benfica" must not match "São Domingos de Benfica"; then "Carnaxide e Queijas" inside
  // "União das freguesias de Carnaxide e Queijas".
  const entries = Object.entries(parishes);
  const parish = n ? entries.find(([name]) => name === n)
    ?? entries.find(([name]) => name.startsWith('uniao das freguesias') && (name.endsWith(n) || name.includes(` ${n} `))) : undefined;
  if (parish) return { v: parish[1], where: l.neighborhood! };
  return prices.muni[muni] ? { v: prices.muni[muni], where: l.municipality ?? l.neighborhood ?? '' } : null;
}

/** "📊 сделки в Benfica: 4 812 €/м² (INE, 12 мес.) — эта на 8% дороже" */
export function ineLine(prices: InePrices | undefined, l: Listing): string | null {
  const med = ineMedian(prices, l);
  if (!med || !l.price_per_m2) return null;
  const diff = Math.round((l.price_per_m2 / med.v - 1) * 100);
  const cmp = diff === 0 ? 'как в сделках' : diff > 0 ? `на ${diff}% дороже` : `на ${-diff}% дешевле`;
  return `📊 сделки в ${med.where}: ${Math.round(med.v).toLocaleString('ru-RU').replace(/\s/g, ' ')} €/м² (INE, 12 мес.), эта ${cmp}`;
}
