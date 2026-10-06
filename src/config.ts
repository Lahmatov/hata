// Load .env if present (Node >= 21.7). Real environment variables take precedence.
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env */
}


export const config = {
  userAgent: 'HataMonitor/0.1 (+https://github.com/lahmatov/hata; personal apartment search, low rate)',
  rateLimitMs: { min: 6000, max: 10000 }, // per host
  cacheTtlHours: 12,
  maxRetries: 3,

  school: {
    name: 'PaRK International School (Alfragide)',
    address: 'Estrada de Alfragide 94, 2610-015 Amadora, Portugal',
    // Optional manual override if geocoding is off: SCHOOL_LAT / SCHOOL_LON
    lat: process.env.SCHOOL_LAT ? Number(process.env.SCHOOL_LAT) : null,
    lon: process.env.SCHOOL_LON ? Number(process.env.SCHOOL_LON) : null,
  },

  criteria: {
    bedrooms: 3,
    minBathrooms: 2,
    requireGarage: true,
    maxPrice: 415_000,
    maxPriceNegotiable: 430_000,
    preferredCommuteMin: 15,
    hardCommuteMin: 25, // beyond this a listing is dropped
  },

  // Free-flow OSRM time * factor ~ morning peak. Tune after comparing with Google Maps a few times.
  morningTrafficFactor: Number(process.env.MORNING_TRAFFIC_FACTOR ?? 1.5),

  // Municipalities / parishes we search. Matching is accent- and case-insensitive.
  areas: ['Alfragide', 'Amadora', 'Carnaxide', 'Queluz', 'Linda-a-Velha', 'Miraflores', 'Algés', 'Oeiras', 'Rio de Mouro'],

  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN ?? '',
    chatId: process.env.TELEGRAM_CHAT_ID ?? '',
    maxItemsPerMessage: 15,
  },

  anthropic: {
    model: 'claude-sonnet-4-6',
    enabled: Boolean(process.env.ANTHROPIC_API_KEY),
  },

  googleMapsKey: process.env.GOOGLE_MAPS_API_KEY ?? '',
  dataDir: process.env.HATA_DATA_DIR ?? 'data',
  logDir: process.env.HATA_LOG_DIR ?? 'logs',
};

export const norm = (s: string | null | undefined) =>
  (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export const inTargetArea = (...parts: (string | null | undefined)[]) => {
  const hay = norm(parts.join(' '));
  return config.areas.some((a) => hay.includes(norm(a)));
};
