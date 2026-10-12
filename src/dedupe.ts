import { norm } from './config.ts';
import type { Listing } from './types.ts';

/** Same property listed on several portals: same address (or neighbourhood + coords), area ±3%, price ±3%. */
export function sameProperty(a: Listing, b: Listing): boolean {
  if (a.id === b.id) return true;
  if (a.price === null || b.price === null || a.area_m2 === null || b.area_m2 === null) return false;
  const within = (x: number, y: number, pct: number) => Math.abs(x - y) <= pct * Math.max(x, y);
  if (!within(a.price, b.price, 0.03) || !within(a.area_m2, b.area_m2, 0.03)) return false;
  if (a.bedrooms !== null && b.bedrooms !== null && a.bedrooms !== b.bedrooms) return false;

  const addrA = norm(a.address);
  const addrB = norm(b.address);
  if (addrA && addrB) return addrA === addrB || addrA.includes(addrB) || addrB.includes(addrA);
  if (a.lat !== null && b.lat !== null && a.lon !== null && b.lon !== null) {
    return Math.hypot((a.lat - b.lat) * 111, (a.lon - b.lon) * 85) < 0.15; // ~150 m
  }
  // Aggregators (Trovit) give only the municipality: identical price + area within 1% in the same municipality.
  if ((!addrA || !addrB) && norm(a.municipality) && norm(a.municipality) === norm(b.municipality)
    && a.price === b.price && within(a.area_m2, b.area_m2, 0.01)) return true;
  // Without address/coords: same parish + near-identical numbers is a strong enough hint.
  const nA = norm(a.neighborhood);
  const nB = norm(b.neighborhood);
  return !!nA && nA === nB && within(a.price, b.price, 0.005) && within(a.area_m2, b.area_m2, 0.01);
}

/** Union-find over all listings; group id = earliest first_seen member. */
export function groupDuplicates(listings: Listing[]): Map<string, string> {
  const parent = new Map(listings.map((l) => [l.id, l.id]));
  const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
  for (let i = 0; i < listings.length; i++) {
    for (let j = i + 1; j < listings.length; j++) {
      const [a, b] = [listings[i], listings[j]];
      // Same portal: only exact re-posts (same price, area and parish/address) count as duplicates.
      const ok = a.source !== b.source
        ? sameProperty(a, b)
        : a.price === b.price && a.area_m2 === b.area_m2 && a.price !== null && a.area_m2 !== null
          && norm(a.address ?? a.neighborhood) === norm(b.address ?? b.neighborhood) && !!norm(a.address ?? a.neighborhood);
      if (ok) {
        parent.set(find(listings[i].id), find(listings[j].id));
      }
    }
  }
  const byRoot = new Map<string, Listing[]>();
  for (const l of listings) byRoot.set(find(l.id), [...(byRoot.get(find(l.id)) ?? []), l]);
  const out = new Map<string, string>();
  for (const members of byRoot.values()) {
    const leader = [...members].sort((a, b) => a.first_seen.localeCompare(b.first_seen) || a.id.localeCompare(b.id))[0];
    for (const m of members) out.set(m.id, leader.id);
  }
  return out;
}
