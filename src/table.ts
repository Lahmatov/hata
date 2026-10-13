import { featuresFromText, featuresList } from './adapters/text.ts';
import { condoFee, purchaseCosts } from './costs.ts';
import { routeUrl } from './extras.ts';
import type { Point } from './geo.ts';
import type { Score } from './score.ts';
import { ruleBasedProsCons } from './summarize.ts';
import type { Classified, Listing } from './types.ts';
import type { TableCell } from '../worker/xlsx.ts';

// The favourites spreadsheet (/export in the bot): one row per flat in the order of worker/table.ts, built here
// from the full database and pushed to the worker, which keeps the rows of the flats you liked and adds who liked them.

const yn = (b: boolean | null) => (b === null ? '?' : b ? 'да' : 'нет');
const CONDITION_RU: Record<string, string> = { new: 'новостройка', renovated: 'после ремонта', good: 'хорошее', needs_renovation: 'нужен ремонт' };
const SOURCE_RU: Record<string, string> = { imovirtual: 'Imovirtual', idealista: 'Idealista', casasapo: 'Casa Sapo', custojusto: 'CustoJusto', trovit: 'Trovit', email: 'письмо' };
const days = (iso: string, now: number) => Math.max(0, Math.floor((now - Date.parse(iso)) / 86400_000));


export function tableRow(l: Listing, c: Classified, s: Score, ctx: { members: Listing[]; prices: number[]; school: Point | null; now?: number; ine?: { v: number } | null; near?: string | null; flood?: string }): TableCell[] {
  const now = ctx.now ?? Date.now();
  const f = featuresFromText(l.description);
  const local = s.local;
  const cost = l.price ? purchaseCosts(l.price) : null;
  const since = l.listed_since && !Number.isNaN(Date.parse(l.listed_since)) ? l.listed_since : l.first_seen;
  const others = ctx.members.filter((m) => m.id !== l.id).map((m) => `${SOURCE_RU[m.source] ?? m.source}: ${m.url}`);
  const verdict = c.verdict === 'match' ? 'да' : c.verdict === 'negotiate' ? 'дороже бюджета, нужен торг' : `проверить: ${c.reasons.join(', ')}`;
  const route = routeUrl(l, ctx.school);
  return [
    s.total, s.text,
    l.neighborhood ?? '', l.municipality ?? '', l.address ?? '',
    l.price, ctx.prices.length >= 2 ? ctx.prices.map((p) => `${Math.round(p / 1000)}`).join(' → ') + ' тыс.' : '',
    cost ? Math.round(cost.total) : null, cost ? Math.round(cost.monthly) : null, condoFee(l.description),
    l.price_per_m2 ? Math.round(l.price_per_m2) : null,
    local && l.price_per_m2 ? Math.round((l.price_per_m2 / local.m - 1) * 1000) / 1000 : null,
    ctx.ine ? Math.round(ctx.ine.v) : null, ctx.ine && l.price_per_m2 ? Math.round((l.price_per_m2 / ctx.ine.v - 1) * 1000) / 1000 : null,
    l.area_m2, l.bedrooms,
    l.bathrooms, yn(l.garage), l.floor ?? '?', yn(l.elevator), CONDITION_RU[l.condition ?? ''] ?? '?',
    f.year, f.energy ?? '', featuresList(f).join(', '),
    l.commute_min === null ? null : Math.round(l.commute_min), ctx.near ?? '', ctx.flood ?? '', l.commute_approx ? 'нет, район' : 'да', days(since, now),
    verdict, ruleBasedProsCons(l),
    { u: l.url, t: SOURCE_RU[l.source] ?? 'открыть' }, route ? { u: route, t: 'маршрут' } : '', others.join('\n'),
    '', '', '', '',
  ];
}
