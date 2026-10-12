import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { adapters } from './adapters/index.ts';
import { EMAIL_MAX_AGE_DAYS } from './adapters/email.ts';
import { config, inTargetArea, locationUnknown } from './config.ts';
import { Store } from './db.ts';
import { groupDuplicates } from './dedupe.ts';
import { classify, worthEnriching } from './filter.ts';
import { driveMinutes, listingPoint, schoolPoint } from './geo.ts';
import { PoliteHttp } from './http.ts';
import { log } from './log.ts';
import { summarize } from './summarize.ts';
import { buildPosts, clearChats, type DigestItem, esc, sendPost, sendTelegram } from './telegram.ts';
import { favouritesText, processUpdates } from './bot.ts';
import { pushCatalogue, workerEnabled } from './worker-sync.ts';
import { dealNote, historyNote, routeUrl } from './extras.ts';
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
    let details = 0;
    // Search pages carry ~3 photos, the listing page all of them: listings read before photos were stored
    // are re-read, a limited number per run (--photo-backfill=N for a one-off catch-up run).
    let photoBackfill = Number(opt('photo-backfill') ?? process.env.PHOTO_BACKFILL ?? 150);
    try {
      if (adapter.fetchAll) {
        const got = await adapter.fetchAll({ kvGet: (k) => store.kvGet(k), kvSet: (k, v) => store.kvSet(k, v) });
        for (const raw of got.filter((r) => worthEnriching(r) && (inTargetArea(r.municipality, r.neighborhood, r.address) || locationUnknown(r.municipality, r.neighborhood, r.address)))) {
          seen.push(store.upsert(raw, now));
          count++;
        }
      }
      const queue = adapter.fetchAll ? [] : adapter.searchUrls().map((url) => ({ url, pageNo: 1 }));
      while (queue.length) {
        const { url, pageNo } = queue.shift()!;
        const page = await http.get(url);
        if (page.status >= 400) {
          log.warn(`${adapter.id}: HTTP ${page.status} on ${url}, skipping this search`);
          continue;
        }
        const next = adapter.nextPageUrl?.(page.body, url, pageNo);
        if (next && pageNo < (adapter.maxPages ?? 3)) queue.push({ url: next, pageNo: pageNo + 1 });
        const all = adapter.parse(page.body, url);
        if (pageNo === 1 && !all.length) log.warn(`${adapter.id}: 0 listings parsed on ${url} (empty search or page layout changed)`);
        const parsed = all.filter((r) => (inTargetArea(r.municipality, r.neighborhood, r.address) || locationUnknown(r.municipality, r.neighborhood, r.address)));
        for (let raw of parsed) {
          if (!worthEnriching(raw)) continue;
          const id = `${raw.source}:${raw.sourceId}`;
          const needsDetail = adapter.enrich && (!store.detailDone(id, raw.price) || (!store.photosDone(id) && photoBackfill-- > 0));
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
          if (detailed) {
            store.markDetail(id, raw.price);
            if (++details % 20 === 0) log.info(`${adapter.id}: ${details} listing pages read so far…`);
          }
          count++;
        }
      }
      log.info(`${adapter.id}: ${count} candidate listings (${details} listing pages read)`);
    } catch (e) {
      const reason = e instanceof BlockedError ? `blocked: ${e.detail}` : (e as Error).message;
      log.error(`${adapter.id}: ${reason}`);
      failed.push(`${adapter.name} (${reason.slice(0, 60)})`);
    }
  }));
  return { seen, failed };
}

/** Only one run at a time (launchd + a manual run would double the requests to every site). */
function acquireLock(): boolean {
  const file = `${config.dataDir}/run.lock`;
  try {
    mkdirSync(config.dataDir, { recursive: true });
    const pid = Number(readFileSync(file, 'utf8'));
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 0); return false; } catch { /* stale lock */ }
    }
  } catch { /* no lock */ }
  writeFileSync(file, String(process.pid));
  process.on('exit', () => { try { unlinkSync(file); } catch { /* ignore */ } });
  return true;
}

async function main() {
  const [today, hour] = [lisbonNow().slice(0, 10), Number(lisbonNow().slice(11, 13))];
  if (LISBON_HOURS && !LISBON_HOURS.includes(hour) && !flag('force')) {
    log.info(`Lisbon hour is ${hour}, not in ${LISBON_HOURS}; exiting`);
    return;
  }
  if (!acquireLock()) {
    log.warn('another run is in progress (data/run.lock); exiting');
    return;
  }
  const store = new Store();
  // Three runs a day (07:45, 13:45, 19:45). The morning one always reports (also "nothing new" and failed
  // sources); the others only write when there is something new.
  const slot = hour < 11 ? 'morning' : hour < 17 ? 'day' : 'evening';
  const runKey = `${today}-${slot}`;
  if (!DRY && !SEED && !flag('force') && store.sentToday(runKey)) {
    log.info(`${slot} digest for ${today} already sent; use --force to resend`);
    return;
  }
  const now = new Date().toISOString();
  log.info(`run start ${now} dry=${DRY} seed=${SEED}`);
  log.info('first run reads every listing page (6-10 s each), so it can take 20-40 min; later runs take a few minutes');

  if (!DRY) await processUpdates(store).catch((e) => log.warn(`telegram updates: ${e.message}`));
  const hidden = store.reactions('hide');
  const school = await schoolPoint(store); // before collecting: the idealista API searches around it
  const { seen, failed } = await collect(store, now);
  // E-mail listings are read once; keep the unsent ones in play for two weeks.
  const inRun = new Set(seen.map((s) => s.listing.id));
  for (const l of store.unsentFromEmail(EMAIL_MAX_AGE_DAYS)) if (!inRun.has(l.id)) seen.push({ listing: l, isNew: false, priceDrop: false });

  // Cross-portal duplicates over everything seen in the last 60 days.
  const recent = store.all().filter((l) => Date.now() - Date.parse(l.last_seen) < 60 * 86400_000);
  for (const [id, gid] of groupDuplicates(recent)) store.setGroup(id, gid);

  // Commute for listings that still lack it.
  const schoolKey = school ? `${school.lat},${school.lon}` : '';
  if (school && store.kvGet<string>('school:point') !== schoolKey) {
    log.info('school location changed: recomputing commute times');
    store.resetCommutes();
    store.kvSet('school:point', schoolKey);
  }
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
    if (c.verdict === 'reject' || hidden.has(l.group_id)) continue;
    // Links shown: same property on other portals, still seen within the last week (no dead links).
    const members = recent.map((r) => store.get(r.id)!)
      .filter((m) => m.group_id === l.group_id && Date.now() - Date.parse(m.last_seen) < 7 * 86400_000);
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
  // "Check manually" can be capped (closest first); the rest stay un-notified and surface on later runs.
  const manual = sorted.filter((i) => i.group === 'manual');
  const items = [...sorted.filter((i) => i.group !== 'manual'), ...manual.slice(0, config.telegram.maxManualItems)];
  const hiddenManual = Math.max(0, manual.length - config.telegram.maxManualItems);
  log.info(`digest: ${items.length} items (${items.filter((i) => i.group === 'new').length} new, ${items.filter((i) => i.group === 'drop').length} drops, ${items.filter((i) => i.group === 'manual').length} manual); failed: ${failed.length}`);

  if (SEED) {
    for (const it of items) for (const m of it.members) store.markNotified(m.id, m.price);
    log.info('seed mode: marked as notified, nothing sent');
    return;
  }

  // 🔥 deal vs. comparable flats, 💶 price history, 🗺 route to school.
  // Comparable flats: T3 of the minimum size seen in the last 60 days (any of our sources).
  // One qualifying listing per duplicate group (the group's first listing may lack bedrooms or area).
  const poolByGroup = new Map<string, Listing>();
  for (const l of recent.map((r) => store.get(r.id)!)) {
    if ((l.bedrooms ?? 0) < config.criteria.minBedrooms || (l.area_m2 ?? 0) < config.criteria.minAreaM2) continue;
    if (!poolByGroup.has(l.group_id)) poolByGroup.set(l.group_id, l);
  }
  const pool = [...poolByGroup.values()];
  for (const it of items) {
    it.deal = dealNote(it.leader, pool);
    it.history = historyNote(store.priceHistory(it.leader.id));
    it.route = routeUrl(it.leader, school);
  }

  const summaries = await summarize(store, items.map((i) => i.leader));
  for (const it of items) it.summary = summaries.get(it.leader.id) ?? '';
  // Sunday morning: list of flats marked 👍 that are still on sale.
  if (slot === 'morning' && new Date(`${today}T12:00:00Z`).getUTCDay() === 0 && !DRY) {
    for (const [title, kind] of [['Суперлайки', 'super'], ['Избранное за неделю', 'like']] as const) {
      const text = favouritesText(store, title, kind);
      if (text) await sendTelegram(text);
    }
  }
  if (!items.length && slot !== 'morning' && !DRY && !flag('force')) {
    store.recordRun(runKey, 0, failed);
    log.info(`nothing new for the ${slot} digest; not sending`);
    if (workerEnabled()) await pushCatalogue(store).catch((e) => log.warn(e.message));
    return;
  }
  const label = { morning: 'утро', day: 'день', evening: 'вечер' }[slot];
  const posts = buildPosts(items, failed, `${today.split('-').reverse().join('.')} · ${label}`, hiddenManual);

  if (DRY) {
    for (const p of posts) console.log('\n' + '─'.repeat(60) + (p.photo ? `\n[фото] ${p.photo}` : '') + '\n' + p.text.replace(/<a href="([^"]+)">([^<]+)<\/a>/g, '$2: $1').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
    console.log('\n' + '─'.repeat(60) + `\n[dry-run] ${posts.length} post(s), nothing sent, nothing marked as notified`);
    return;
  }
  // Mark each flat as notified right after its post, so a crash mid-way doesn't resend the earlier ones.
  for (const p of posts) {
    const sent = await sendPost(p);
    if (p.item) store.saveMessages(p.item.leader.group_id, sent);
    if (p.item) for (const m of p.item.members) store.markNotified(m.id, m.price);
  }
  for (const it of items) for (const m of it.members) store.markNotified(m.id, m.price);
  store.recordRun(runKey, items.length, failed);
  log.info(`sent ${posts.length} message(s)`);
  if (workerEnabled()) await pushCatalogue(store).catch((e) => log.warn(e.message));
}

if (flag('telegram-chat-id')) {
  // Prints chat ids of people who wrote to the bot (send /start to the bot first).
  fetch(`https://api.telegram.org/bot${config.telegram.token}/getUpdates`)
    .then((r) => r.json() as Promise<{ ok: boolean; description?: string; result?: { message?: { chat: { id: number; first_name?: string; username?: string } } }[] }>)
    .then((j) => {
      if (!j.ok) throw new Error(j.description);
      const chats = new Map((j.result ?? []).filter((u) => u.message).map((u) => [u.message!.chat.id, u.message!.chat]));
      if (!chats.size) console.log('No messages yet: open your bot in Telegram, press Start / send "hi", then run this again.');
      for (const c of chats.values()) console.log(`${c.id}   (${c.first_name ?? ''} @${c.username ?? ''})`);
      if (chats.size) console.log(`\nFor .env (everyone above): TELEGRAM_CHAT_ID=${[...chats.keys()].join(',')}`);
    })
    .catch((e) => { log.error(e.message); process.exit(1); });
} else if (flag('process-updates')) {
  // Light job (every 15 min on GitHub): apply 👍/👎 presses only, no scraping.
  processUpdates(new Store()).catch((e) => { log.error(e.message); process.exit(1); });
} else if (flag('clear-chat')) {
  // Deletes the bot's chat history for all recipients and marks every flat as not sent, so the next
  // digest (--force) starts from a clean chat with the full current list.
  if (!config.telegram.token || !config.telegram.chatIds.length) {
    log.error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set: nothing cleared, nothing reset');
    process.exit(1);
  }
  clearChats()
    .then((cleared) => {
      // Reset only if some chat really was cleared, otherwise the next digest would duplicate the posts.
      if (!cleared) throw new Error('no chat could be cleared; flats are not reset');
      new Store().resetNotified();
      log.info(`${cleared} chat(s) cleared; all flats will be sent again by the next digest`);
    })
    .catch((e) => { log.error(e.message); process.exit(1); });
} else if (flag('test-telegram')) {
  sendTelegram('✅ Хата: тестовое сообщение. Бот настроен, дайджест приходит утром, днём и вечером приходят только новые.')
    .then(() => log.info('test message sent'))
    .catch((e) => { log.error(e.message); process.exit(1); });
} else {
  main().catch((e) => { log.error(`fatal: ${e.stack ?? e}`); process.exit(1); });
}
