import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';
import type { Listing, RawListing } from './types.ts';

export interface UpsertResult {
  listing: Listing;
  isNew: boolean;
  priceDrop: boolean;
  priceRise: boolean;
}

const COLS = [
  'source', 'sourceId', 'url', 'title', 'price', 'area_m2', 'bedrooms', 'bathrooms', 'garage', 'floor', 'elevator',
  'condition', 'neighborhood', 'municipality', 'address', 'lat', 'lon', 'description',
] as const;

export class Store {
  db: DatabaseSync;

  constructor(file = `${config.dataDir}/hata.sqlite`) {
    if (file !== ':memory:') mkdirSync(config.dataDir, { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS listings (
        id TEXT PRIMARY KEY, source TEXT, sourceId TEXT, url TEXT, title TEXT,
        price REAL, prev_price REAL, area_m2 REAL, bedrooms INTEGER, bathrooms INTEGER,
        garage INTEGER, floor TEXT, elevator INTEGER, condition TEXT,
        neighborhood TEXT, municipality TEXT, address TEXT, lat REAL, lon REAL,
        group_id TEXT, commute_min REAL, commute_approx INTEGER DEFAULT 0,
        first_seen TEXT, last_seen TEXT, notified_price REAL, description TEXT, detail_price REAL
      );
      CREATE TABLE IF NOT EXISTS price_history (id TEXT, price REAL, seen TEXT);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, updated TEXT);
      CREATE TABLE IF NOT EXISTS runs (day TEXT PRIMARY KEY, sent_at TEXT, items INTEGER, failed TEXT);
    `);
  }

  get(id: string): Listing | undefined {
    const row = this.db.prepare('SELECT * FROM listings WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toListing(row) : undefined;
  }

  all(): Listing[] {
    return (this.db.prepare('SELECT * FROM listings').all() as Record<string, unknown>[]).map(toListing);
  }

  /** Insert or update; detects new listings and price changes against the stored price. */
  upsert(raw: RawListing, now: string): UpsertResult {
    const id = `${raw.source}:${raw.sourceId}`;
    const old = this.get(id);
    // Keep previously known values when a later scrape lacks them (e.g. detail-only fields).
    const merged: RawListing = { ...raw };
    if (old) for (const c of COLS) if (merged[c] === null || merged[c] === undefined) (merged as any)[c] = (old as any)[c];

    const priceChanged = !!old && old.price !== null && merged.price !== null && Math.abs(old.price - merged.price) >= 1;
    const prev = priceChanged ? old!.price : (old?.prev_price ?? null);
    const values = COLS.map((c) => toDb(merged[c]));
    if (old) {
      this.db
        .prepare(`UPDATE listings SET ${COLS.map((c) => `${c} = ?`).join(', ')}, prev_price = ?, last_seen = ? WHERE id = ?`)
        .run(...values, prev, now, id);
    } else {
      this.db
        .prepare(`INSERT INTO listings (id, ${COLS.join(', ')}, prev_price, group_id, first_seen, last_seen) VALUES (?, ${COLS.map(() => '?').join(', ')}, NULL, ?, ?, ?)`)
        .run(id, ...values, id, now, now);
    }
    if (!old || priceChanged) this.db.prepare('INSERT INTO price_history VALUES (?, ?, ?)').run(id, merged.price, now);
    return {
      listing: this.get(id)!,
      isNew: !old,
      priceDrop: priceChanged && merged.price! < old!.price!,
      priceRise: priceChanged && merged.price! > old!.price!,
    };
  }

  setGroup(id: string, groupId: string) {
    this.db.prepare('UPDATE listings SET group_id = ? WHERE id = ?').run(groupId, id);
  }

  setCommute(id: string, minutes: number | null, approx: boolean) {
    this.db.prepare('UPDATE listings SET commute_min = ?, commute_approx = ? WHERE id = ?').run(minutes, approx ? 1 : 0, id);
  }

  /** Detail page already parsed at this price? (avoids re-fetching every day) */
  detailDone(id: string, price: number | null): boolean {
    const r = this.db.prepare('SELECT detail_price FROM listings WHERE id = ?').get(id) as { detail_price: number | null } | undefined;
    return !!r && r.detail_price !== null && r.detail_price === price;
  }

  markDetail(id: string, price: number | null) {
    this.db.prepare('UPDATE listings SET detail_price = ? WHERE id = ?').run(price, id);
  }

  markNotified(id: string, price: number | null) {
    this.db.prepare('UPDATE listings SET notified_price = ? WHERE id = ?').run(price, id);
  }

  notifiedPrice(id: string): number | null {
    const r = this.db.prepare('SELECT notified_price FROM listings WHERE id = ?').get(id) as { notified_price: number | null } | undefined;
    return r?.notified_price ?? null;
  }

  kvGet<T>(k: string, maxAgeHours = Infinity): T | undefined {
    const r = this.db.prepare('SELECT v, updated FROM kv WHERE k = ?').get(k) as { v: string; updated: string } | undefined;
    if (!r || Date.now() - Date.parse(r.updated) > maxAgeHours * 3600_000) return undefined;
    return JSON.parse(r.v) as T;
  }

  kvSet(k: string, v: unknown) {
    this.db.prepare('INSERT OR REPLACE INTO kv VALUES (?, ?, ?)').run(k, JSON.stringify(v), new Date().toISOString());
  }

  recordRun(day: string, items: number, failed: string[]) {
    this.db.prepare('INSERT OR REPLACE INTO runs VALUES (?, ?, ?, ?)').run(day, new Date().toISOString(), items, failed.join(','));
  }

  sentToday(day: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM runs WHERE day = ?').get(day);
  }
}

const toDb = (v: unknown) => (typeof v === 'boolean' ? (v ? 1 : 0) : (v ?? null)) as string | number | null;
const toBool = (v: unknown) => (v === null || v === undefined ? null : v === 1 || v === true);

function toListing(r: Record<string, unknown>): Listing {
  const price = r.price as number | null;
  const area = r.area_m2 as number | null;
  return {
    ...(r as unknown as Listing),
    garage: toBool(r.garage),
    elevator: toBool(r.elevator),
    commute_approx: r.commute_approx === 1,
    price_per_m2: price && area ? Math.round(price / area) : null,
  };
}
