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
    // Confirmed by the user (school entrance, Rua das Mil Flores, Alfragide). Override with SCHOOL_LAT / SCHOOL_LON.
    lat: Number(process.env.SCHOOL_LAT || 38.735766) as number | null,
    lon: Number(process.env.SCHOOL_LON || -9.226091) as number | null,
  },

  criteria: {
    bedrooms: 3,
    minBathrooms: 2,
    minAreaM2: 90,
    requireGarage: true,
    maxPrice: 415_000,
    maxPriceNegotiable: 430_000,
    preferredCommuteMin: 20,
    hardCommuteMin: 35, // beyond this a listing is dropped (Sintra / Mem Martins are ~25-35 min)
  },

  // Free-flow OSRM time * factor ~ morning peak. Tune after comparing with Google Maps a few times.
  morningTrafficFactor: Number(process.env.MORNING_TRAFFIC_FACTOR ?? 1.5),

  // Municipalities / parishes / localities we accept (accent- and case-insensitive substring match).
  // "Amadora" and "Oeiras" cover the whole municipalities (incl. Tercena, Barcarena, Queijas, Porto Salvo).
  // Distance is then decided by the commute filter (hardCommuteMin), not by names.
  areas: [
    'Amadora', 'Alfragide', 'Buraca', 'Damaia', 'Reboleira', 'Venteira', 'Brandoa', 'Falagueira', 'Mina de Agua', 'Encosta do Sol', 'Aguas Livres',
    'Oeiras', 'Carnaxide', 'Queijas', 'Linda-a-Velha', 'Miraflores', 'Alges', 'Tercena', 'Barcarena', 'Porto Salvo',
    'Sintra', 'Queluz', 'Belas', 'Massama', 'Monte Abraao', 'Rio de Mouro', 'Mem Martins', 'Algueirao', 'Cacem', 'Agualva',
    'Benfica', 'Carnide', 'Sao Domingos de Benfica',
  ],

  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN ?? '',
    // One or more recipients, comma-separated (each person must press Start in the bot first).
    chatIds: (process.env.TELEGRAM_CHAT_ID ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    maxItemsPerMessage: 15,
    maxManualItems: 15, // "check manually" can be large; show the closest ones only
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

/** No location at all (e.g. some e-mail alerts): treat as unknown, not as outside. */
export const locationUnknown = (...parts: (string | null | undefined)[]) => !norm(parts.join(' '));

export const inTargetArea = (...parts: (string | null | undefined)[]) => {
  const hay = norm(parts.join(' '));
  return config.areas.some((a) => hay.includes(norm(a)));
};
