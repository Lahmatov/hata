import { config, inTargetArea, locationUnknown } from './config.ts';
import type { Classified, Listing } from './types.ts';

/**
 * Hard criteria. Unknown values never reject; they route to "manual".
 * - match:      everything known and within budget
 * - negotiate:  price in (maxPrice, maxPriceNegotiable]
 * - manual:     within budget but bathrooms/garage/bedrooms/price unknown
 * - reject:     known to violate a criterion
 */
export function classify(l: Listing): Classified {
  const c = config.criteria;
  const reject: string[] = [];
  const unknown: string[] = [];

  if (locationUnknown(l.municipality, l.neighborhood, l.address)) unknown.push('район');
  else if (!inTargetArea(l.municipality, l.neighborhood, l.address, l.title)) reject.push('outside target area');

  if (l.bedrooms === null) unknown.push('число спален');
  else if (l.bedrooms !== c.bedrooms) reject.push(`T${l.bedrooms}`);

  if (l.area_m2 === null) unknown.push('площадь');
  else if (l.area_m2 < c.minAreaM2) reject.push(`${l.area_m2} m2`);

  if (l.bathrooms === null) unknown.push('санузлы');
  else if (l.bathrooms < c.minBathrooms) reject.push(`${l.bathrooms} bathroom(s)`);

  if (c.requireGarage) {
    if (l.garage === null) unknown.push('гараж');
    else if (!l.garage) reject.push('no garage');
  }

  let negotiate = false;
  if (l.price === null) unknown.push('цена');
  else if (l.price > c.maxPriceNegotiable) reject.push(`price ${l.price}`);
  else if (l.price > c.maxPrice) negotiate = true;

  if (l.commute_min !== null && l.commute_min > c.hardCommuteMin) reject.push(`commute ${Math.round(l.commute_min)} min`);

  if (reject.length) return { listing: l, verdict: 'reject', reasons: reject };
  if (unknown.length) return { listing: l, verdict: 'manual', reasons: unknown };
  return { listing: l, verdict: negotiate ? 'negotiate' : 'match', reasons: negotiate ? ['нужен торг'] : [] };
}

/** Cheap pre-filter before spending requests on detail pages. */
export function worthEnriching(l: { price: number | null; bedrooms: number | null; area_m2: number | null }) {
  const c = config.criteria;
  return (l.price === null || l.price <= c.maxPriceNegotiable) && (l.bedrooms === null || l.bedrooms === c.bedrooms)
    && (l.area_m2 === null || l.area_m2 >= c.minAreaM2);
}
