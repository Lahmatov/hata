import { adapters } from './adapters/index.ts';
import { config, inTargetArea } from './config.ts';
import { Store } from './db.ts';
import { groupDuplicates } from './dedupe.ts';
import { classify, worthEnriching } from './filter.ts';
import { driveMinutes, listingPoint, schoolPoint } from './geo.ts';
import { PoliteHttp } from './http.ts';
import { log } from './log.ts';
import { summarize } from './summarize.ts';
import { buildMessages, type DigestItem, sendTelegram } from './telegram.ts';
import { BlockedError, type Listing, type RawListing } from './types.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

const DRY = flag('dry-run');
const SEED = flag('seed'); // mark everything as already notified, send nothing (first run without a flood)
const ONLY = opt('only')?.split(',');
const LISBON_HOURS = opt('lisbon-hours')?.split(',').map(Number); // cron runs in UTC: proceed only in these Lisbon hours

const lisbonNow = () => new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Lisbon' }); // "2026-10-07 07:45:00"

async function collect(store: Store, now: string) {
  const failed: string[] = [];
  const seen: { listing: Listing; isNew: boolean; priceDrop: boolean }[] = [];
  const active = adapters.filter((a) => (!ONLY || ONLY.includes(a.id)) && (a.enabled?.() ?? true));

  // Sources run in parallel; requests within one source are sequential and rate-limited.
  await Promise.all(active.map(async (adapter) => {
    const http = new PoliteHttp(adapter.id, { useCache: !flag('no-cache') });
    let count = 0;
    try {
      if (adapter.fetchAll) {
        const got = await adapter.fetchAll({ kvGet: (k) => store.kvGet(k), kvSet: (k, v) => store.kvSet(k, v) });
        for (const raw of got.filter((r) => worthEnriching(r) && inTargetArea(r.municipality, r.neighborhood, r.address))) {
          seen.push(store.upsert(raw, now));
          count++;
        }
      }
      const queue = adapter.fetchAll ? [] : adapter.searchUrls().map((url) => ({ url, pageNo: 1 }));
      while (queue.length) {
        const { url, pageNo } = queue.shift()!;
        const page = await http.get(url);
        if (page.status >= 400) throw new Error(`HTTP ${page.status} on ${url}`);
        const next = adapter.nextPageUrl?.(page.body, url, pageNo);
        if (next && pageNo < (adapter.maxPages ?? 3)) queue.push({ url: next, pageNo: pageNo + 1 });
        const parsed = adapter.parse(page.body, url).filter((r) => inTargetArea(r.municipality, r.neighborhood, r.address));
        for (let raw of parsed) {
          if (!worthEnriching(raw)) continue;
          const id = `${raw.source}:${raw.sourceId}`;
          const needsDetail = adapter.enrich && !store.detailDone(id, raw.price);
          let detailed = false;
          if (needsDetail) {
            try {
              raw = await adapter.enrich!(raw, http);
              detailed = true;
            } catch (e) {
              if (e instanceof BlockedError) throw e;
              log.warn(`${adapter.id}: enrich failed ${raw.url}: ${(e as Error).message}`);
            }
          }
          seen.push(store.upsert(raw, now));
          if (detailed) store.markDetail(id, raw.price);
          count++;
        }
      }
      log.info(`${adapter.id}: ${count} candidate listings`);
    } catch (e) {
      const reason = e instanceof BlockedError ? `blocked: ${e.detail}` : (e as Error).message;
      log.error(`${adapter.id}: ${reason}`);
      failed.push(`${adapter.name} (${reason.slice(0, 60)})`);
    }
  }));
  return { seen, failed };
}

async function main() {
  const [today, hour] = [lisbonNow().slice(0, 10), Number(lisbonNow().slice(11, 13))];
  if (LISBON_HOURS && !LISBON_HOURS.includes(hour) && !flag('force')) {
    log.info(`Lisbon hour is ${hour}, not in ${LISBON_HOURS}; exiting`);
    return;
  }
  const store = new Store();
  if (!DRY && !SEED && !flag('force') && store.sentToday(today)) {
    log.info(`digest for ${today} already sent; use --force to resend`);
    return;
  }
  const now = new Date().toISOString();
  log.info(`run start ${now} dry=${DRY} seed=${SEED}`);

  const school = await schoolPoint(store); // before collecting: the idealista API searches around it
  const { seen, failed } = await collect(store, now);

  // Cross-portal duplicates over everything seen in the last 60 days.
  const recent = store.all().filter((l) => Date.now() - Date.parse(l.last_seen) < 60 * 86400_000);
  for (const [id, gid] of groupDuplicates(recent)) store.setGroup(id, gid);

  // Commute for listings that still lack it.
  if (school) log.info(`school at ${school.lat.toFixed(5)},${school.lon.toFixed(5)} (https://www.openstreetmap.org/?mlat=${school.lat}&mlon=${school.lon}#map=17/${school.lat}/${school.lon})`);
  if (!school) log.warn('school location unknown: set SCHOOL_LAT/SCHOOL_LON');
  for (const s of seen) {
    const l = store.get(s.listing.id)!;
    if (school && l.commute_min === null && classify(l).verdict !== 'reject') {
      const { p, approx } = await listingPoint(store, l);
      if (p) store.setCommute(l.id, await driveMinutes(store, p, school), approx);
    }
  }

  // Build digest: one item per duplicate group.
  const byGroup = new Map<string, DigestItem>();
  for (const s of seen) {
    const l = store.get(s.listing.id)!;
    const c = classify(l);
    if (c.verdict === 'reject') continue;
    const members = recent.filter((r) => store.get(r.id)!.group_id === l.group_id).map((r) => store.get(r.id)!);
    const groupNotified = members.some((m) => store.notifiedPrice(m.id) !== null);
    const lastTold = Math.min(...members.map((m) => store.notifiedPrice(m.id) ?? Infinity));
    let group: DigestItem['group'] | null = null;
    if (!groupNotified) group = c.verdict === 'manual' ? 'manual' : 'new';
    else if (l.price !== null && l.price < lastTold && c.verdict !== 'manual') group = 'drop';
    if (!group) continue;
    const prev = byGroup.get(l.group_id);
    if (prev && (prev.leader.price ?? Infinity) <= (l.price ?? Infinity)) continue; // keep cheapest offer as leader
    byGroup.set(l.group_id, { group, leader: l, members, negotiate: c.verdict === 'negotiate', summary: '', reasons: c.reasons });
  }
  const sorted = [...byGroup.values()].sort(
    (a, b) => (a.leader.commute_min ?? 99) - (b.leader.commute_min ?? 99) || (a.leader.price ?? 0) - (b.leader.price ?? 0),
  );
  // "Check manually" is capped (closest first); the rest stay un-notified and can surface on later days.
  const manual = sorted.filter((i) => i.group === 'manual');
  const items = [...sorted.filter((i) => i.group !== 'manual'), ...manual.slice(0, config.telegram.maxManualItems)];
  const hiddenManual = Math.max(0, manual.length - config.telegram.maxManualItems);
  log.info(`digest: ${items.length} items (${items.filter((i) => i.group === 'new').length} new, ${items.filter((i) => i.group === 'drop').length} drops, ${items.filter((i) => i.group === 'manual').length} manual); failed: ${failed.length}`);

  if (SEED) {
    for (const it of items) for (const m of it.members) store.markNotified(m.id, m.price);
    log.info('seed mode: marked as notified, nothing sent');
    return;
  }

  const summaries = await summarize(store, items.map((i) => i.leader));
  for (const it of items) it.summary = summaries.get(it.leader.id) ?? '';
  const messages = buildMessages(items, failed, today.split('-').reverse().join('.'), hiddenManual);

  if (DRY) {
    for (const m of messages) console.log('\n' + '─'.repeat(60) + '\n' + m.replace(/<a href="([^"]+)">([^<]+)<\/a>/g, '$2: $1').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
    console.log('\n' + '─'.repeat(60) + `\n[dry-run] ${messages.length} message(s), nothing sent, nothing marked as notified`);
    return;
  }
  for (const m of messages) await sendTelegram(m);
  for (const it of items) for (const m of it.members) store.markNotified(m.id, m.price);
  store.recordRun(today, items.length, failed);
  log.info(`sent ${messages.length} message(s)`);
}

if (flag('test-telegram')) {
  sendTelegram('✅ Хата: тестовое сообщение. Бот настроен, ежедневный дайджест придёт в 08:00 (Лиссабон).')
    .then(() => log.info('test message sent'))
    .catch((e) => { log.error(e.message); process.exit(1); });
} else {
  main().catch((e) => { log.error(`fatal: ${e.stack ?? e}`); process.exit(1); });
}
