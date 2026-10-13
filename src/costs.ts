// What buying a flat costs on top of its price (mainland Portugal, 2026), plus the monthly mortgage payment.
// IMT: AT Ofício-Circulado 40129/2026, table I (habitação própria e permanente). Selo: 0.8% of the price
// (TGIS verba 1.1) and 0.6% of a loan of 5+ years (verba 17.1.3). Registry: Casa Pronta purchase + mortgage.
// IMT Jovem (DL 48-A/2024; buyers up to 35, first own permanent home): no IMT and no purchase stamp duty up to
// 330 539 €, both only on the part above it up to 660 982 €, none of it above. On by default (both of us qualify);
// IMT_JOVEM=0 turns it off. An estimate: non-resident rates and bank fees are not included.

/** [upper limit, marginal rate, parcela a abater]; above the last limit flat rates apply. */
const IMT_HPP: [number, number, number][] = [
  [106_346, 0, 0], [145_470, 0.02, 2_126.92], [198_347, 0.05, 6_491.02], [330_539, 0.07, 10_457.96], [660_982, 0.08, 13_763.35],
];

export function imtHpp(price: number): number {
  for (const [limit, rate, minus] of IMT_HPP) if (price <= limit) return Math.max(0, price * rate - minus);
  return price * (price <= 1_150_853 ? 0.06 : 0.075);
}

const JOVEM_FREE = 330_539;
const JOVEM_MAX = 660_982;

/** IMT and purchase stamp duty with IMT Jovem: the part above 330 539 € at 8% and 0.8%; full rates above 660 982 €. */
export function jovemTaxes(price: number): { imt: number; selo: number } {
  if (price > JOVEM_MAX) return { imt: imtHpp(price), selo: price * 0.008 };
  const above = Math.max(0, price - JOVEM_FREE);
  return { imt: above * 0.08, selo: above * 0.008 };
}

export const MORTGAGE = {
  jovem: process.env.IMT_JOVEM !== '0',
  share: Number(process.env.MORTGAGE_SHARE ?? 0.8), // part of the price borrowed
  rate: Number(process.env.MORTGAGE_RATE ?? 0.032), // yearly, Euribor + spread
  years: Number(process.env.MORTGAGE_YEARS ?? 30),
  registry: 700, // Casa Pronta, purchase with a mortgage
};

export interface Costs { imt: number; selo: number; seloLoan: number; registry: number; total: number; loan: number; monthly: number }

export function purchaseCosts(price: number, m = MORTGAGE): Costs {
  const loan = price * m.share;
  const { imt, selo } = m.jovem ? jovemTaxes(price) : { imt: imtHpp(price), selo: price * 0.008 };
  const seloLoan = loan * 0.006;
  const r = m.rate / 12;
  const n = m.years * 12;
  const monthly = r ? (loan * r) / (1 - (1 + r) ** -n) : loan / n;
  return { imt, selo, seloLoan, registry: m.registry, total: imt + selo + seloLoan + m.registry, loan, monthly };
}

/** Monthly condominium fee when the ad states it ("condomínio: 45 €", "despesas de condomínio 60€/mês"). */
export function condoFee(text: string | null | undefined): number | null {
  const t = (text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const m = t.match(/condominio[^0-9€]{0,40}(\d{1,3}(?:[.,]\d{1,2})?)\s?(?:€|eur)/) ?? t.match(/(\d{1,3}(?:[.,]\d{1,2})?)\s?(?:€|eur)[^.]{0,20}condominio/);
  const v = m ? Number(m[1].replace(',', '.')) : NaN;
  return v >= 5 && v <= 500 ? Math.round(v) : null;
}

const k = (n: number) => (n / 1000).toFixed(1).replace('.', ',');
const eur = (n: number) => `${Math.round(n).toLocaleString('ru-RU').replace(/\s/g, ' ')} €`;

/** "💶 при покупке ≈ 32,6 тыс. € (IMT 20,4 · гербовый 3,2 + 1,9 · регистрация 0,7) · ипотека 80% на 30 лет под 3,2%: ≈ 1 367 €/мес · кондоминиум 45 €/мес" */
export function costsLine(price: number | null, description?: string | null, m = MORTGAGE): string | null {
  if (!price) return null;
  const c = purchaseCosts(price, m);
  const condo = condoFee(description);
  return `💶 при покупке ≈ ${k(c.total)} тыс. € (IMT${m.jovem ? ' Jovem' : ''} ${k(c.imt)} · гербовый ${k(c.selo)} + ${k(c.seloLoan)} · регистрация ${k(c.registry)})`
    + ` · ипотека ${Math.round(m.share * 100)}% на ${m.years} лет под ${String(Math.round(m.rate * 1000) / 10).replace('.', ',')}%: ≈ ${eur(c.monthly)}/мес`
    + (condo ? ` · кондоминиум ${condo} €/мес` : '');
}
