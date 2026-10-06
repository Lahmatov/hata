export type Condition = 'new' | 'renovated' | 'good' | 'needs_renovation' | 'unknown';

/** What an adapter extracts from a source. Unknown values stay null, never guessed. */
export interface RawListing {
  source: string;
  sourceId: string;
  url: string;
  title: string;
  price: number | null;
  area_m2: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  garage: boolean | null;
  floor: string | null;
  elevator: boolean | null;
  condition: Condition | null;
  neighborhood: string | null;
  municipality: string | null;
  address: string | null;
  lat: number | null;
  lon: number | null;
  description?: string | null;
}

export interface Listing extends RawListing {
  id: string; // `${source}:${sourceId}`
  price_per_m2: number | null;
  first_seen: string;
  last_seen: string;
  prev_price: number | null;
  group_id: string; // cross-portal duplicate cluster
  commute_min: number | null;
  commute_approx: boolean; // true when location is only neighbourhood-level
}

export interface FetchResult {
  status: number;
  url: string;
  body: string;
  fromCache: boolean;
}

export interface Http {
  get(url: string, opts?: { json?: boolean; headers?: Record<string, string> }): Promise<FetchResult>;
}

export interface Adapter {
  id: string;
  name: string;
  /** Search-result URLs to fetch for the configured areas. */
  searchUrls(): string[];
  /** Pure parser: HTML/JSON of one search page -> listings. Tested against saved fixtures. */
  parse(body: string, pageUrl: string): RawListing[];
  /** Optional pagination: next page URL or null. Pages are capped by maxPages. */
  nextPageUrl?(body: string, pageUrl: string, pageNo: number): string | null;
  maxPages?: number;
  /** Optional: fetch extra detail (e.g. garage/bathrooms) for listings missing fields. */
  enrich?(l: RawListing, http: Http): Promise<RawListing>;
}

export type Verdict = 'match' | 'negotiate' | 'manual' | 'reject';

export interface Classified {
  listing: Listing;
  verdict: Verdict;
  reasons: string[]; // why manual/reject, e.g. "garage unknown"
}

export class BlockedError extends Error {
  constructor(public readonly source: string, public readonly detail: string) {
    super(`${source} blocked: ${detail}`);
  }
}
