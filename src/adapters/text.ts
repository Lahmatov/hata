import type { Condition } from '../types.ts';

/** Facts stated explicitly in Portuguese listing text. Returns null when the text says nothing. */
export function factsFromText(text: string | null | undefined) {
  const t = (text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const num = (re: RegExp) => {
    const m = t.match(re);
    if (!m) return null;
    const words: Record<string, number> = { uma: 1, um: 1, duas: 2, dois: 2, tres: 3, quatro: 4 };
    return words[m[1]] ?? (Number(m[1]) || null);
  };

  const bathrooms = num(/\b(\d|duas|dois|tres|quatro)\s+(?:casas?\s+de\s+banho|wc'?s?|i\.?s\.?|banheiros?)\b/);
  const suites = num(/\b(\d|duas|dois|tres|uma)\s+suites?\b/);

  let garage: boolean | null = null;
  if (/\bsem\s+(?:garagem|estacionamento|parqueamento|lugar de garagem)/.test(t)) garage = false;
  else if (/\b(?:garagem|lugar(?:es)? de (?:garagem|estacionamento|parqueamento)|parqueamento|box\b|estacionamento (?:privativo|proprio|na cave|incluido))/.test(t)) garage = true;

  let elevator: boolean | null = null;
  if (/\bsem\s+elevador/.test(t)) elevator = false;
  else if (/\b(?:com\s+)?elevadore?s?\b/.test(t)) elevator = true;

  let condition: Condition | null = null;
  if (/\b(?:para\s+recuperar|necessita\s+de\s+obras|precisa\s+de\s+obras|para\s+remodelar|a\s+necessitar\s+de\s+obras)/.test(t)) condition = 'needs_renovation';
  else if (/\b(?:novo|nova)\s+(?:a\s+estrear|construcao)|\ba\s+estrear\b|empreendimento novo/.test(t)) condition = 'new';
  else if (/\b(?:totalmente\s+)?(?:remodelado|renovado|reabilitado)/.test(t)) condition = 'renovated';

  // Suites have their own bathroom: "3 suites" implies ≥3 bathrooms when no explicit count.
  return { bathrooms: bathrooms ?? (suites && suites >= 2 ? suites : null), garage, elevator, condition };
}

/** "T3", "T3+1" -> 3 */
export function bedroomsFromT(s: string | null | undefined): number | null {
  const m = (s ?? '').match(/\bT\s?(\d)\b/i);
  return m ? Number(m[1]) : null;
}

export const stripHtml = (s: string) => s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').trim();

export function nextData<T = any>(html: string): T {
  const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('__NEXT_DATA__ not found (page layout changed?)');
  return JSON.parse(m[1]) as T;
}

export interface Features {
  balcony: boolean; terrace: boolean; pool: boolean; ac: boolean; storage: boolean; fireplace: boolean;
  closedCondo: boolean; kitchen: boolean; suites: number | null; energy: string | null; year: number | null;
}

/** Extras mentioned in Portuguese listing text (absent = not mentioned, not "no"). */
export function featuresFromText(text: string | null | undefined): Features {
  const t = (text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const suites = t.match(/\b(\d|uma|duas|dois|tres)\s+suites?\b/)?.[1];
  const energy = t.match(/(?:certificad[oa]\s+energetic[oa]|classe\s+energetica|eficiencia\s+energetica)\s*(?:[:\-]|de|classe)?\s*\b([a-f][+-]?)(?![a-z])/)?.[1];
  const year = Number(t.match(/\b(?:construid[oa]\s+em|construcao\s+(?:de|em)|ano\s+(?:de\s+)?construcao:?)\s*((?:19|20)\d\d)\b/)?.[1]);
  return {
    balcony: /\bvarandas?\b|\bmarquise\b/.test(t),
    terrace: /\bterracos?\b/.test(t),
    pool: /\bpiscinas?\b/.test(t),
    ac: /\bar\s+condicionado\b|\bclimatizac|\bac\s+(?:em|nos?)\b/.test(t),
    storage: /\barrecadac|\bdespensa\b/.test(t),
    fireplace: /\blareira\b|recuperador\s+de\s+calor/.test(t),
    closedCondo: /\bcondominio\s+fechado\b/.test(t),
    kitchen: /\bcozinha\s+(?:totalmente\s+|completamente\s+)?equipada\b/.test(t),
    suites: suites ? ({ uma: 1, dois: 2, duas: 2, tres: 3 } as Record<string, number>)[suites] ?? Number(suites) : null,
    energy: energy ? energy.toUpperCase() : null,
    year: year >= 1900 && year <= new Date().getFullYear() + 3 ? year : null,
  };
}

const FEATURE_RU: [keyof Features, string][] = [
  ['balcony', 'балкон'], ['terrace', 'терраса'], ['pool', 'бассейн'], ['ac', 'кондиционер'], ['storage', 'кладовка'],
  ['fireplace', 'камин'], ['closedCondo', 'закрытый комплекс'], ['kitchen', 'кухня с техникой'],
];

/** "балкон, кондиционер, 1 спальня с санузлом" */
export function featuresList(f: Features): string[] {
  const out = FEATURE_RU.filter(([k]) => f[k] === true).map(([, ru]) => ru);
  if (f.suites) out.push(f.suites === 1 ? 'спальня с санузлом' : `${f.suites} спальни с санузлом`);
  return out;
}
