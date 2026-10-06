import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { config } from './config.ts';
import { log } from './log.ts';
import { BlockedError, type FetchResult, type Http } from './types.ts';

const CHALLENGE = /cf-chl|challenge-platform|just a moment\.\.\.|datadome|px-captcha|_incapsula_resource|perimeterx|cf-turnstile|g-recaptcha|hcaptcha/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal robots.txt matcher: our UA group if present, else "*"; longest match wins. */
export function robotsAllows(robots: string, path: string, uaToken = 'hatamonitor'): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; pattern: string }[] }[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const m = raw.replace(/#.*/, '').trim().match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
      cur!.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === 'allow' || key === 'disallow') && val) cur.rules.push({ allow: key === 'allow', pattern: val });
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && uaToken.includes(a)));
  const rules = (mine.length ? mine : groups.filter((g) => g.agents.includes('*'))).flatMap((g) => g.rules);
  let best: { allow: boolean; pattern: string } | null = null;
  for (const r of rules) {
    const re = new RegExp('^' + r.pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(path) && (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow))) best = r;
  }
  return best ? best.allow : true;
}

/** Looks like a bot wall? Only inspects the start of the page, where interstitials put their markers. */
export function looksBlocked(status: number, body: string): string | null {
  if (status === 401 || status === 403 || status === 429) return `HTTP ${status}`;
  const head = body.slice(0, 20000);
  const m = head.match(CHALLENGE);
  // A real results page is large; challenge interstitials are small.
  if (m && body.length < 60000) return `challenge marker "${m[0]}"`;
  return null;
}

/**
 * Polite HTTP client: identifiable UA, robots.txt, 6-10 s per host, on-disk cache,
 * retries with backoff only for network errors / 5xx. Never retries a block.
 */
export class PoliteHttp implements Http {
  private nextSlot = new Map<string, number>();
  private robots = new Map<string, Promise<string>>();
  private cacheDir: string;

  constructor(private source: string, private opts: { useCache?: boolean } = {}) {
    this.cacheDir = `${config.dataDir}/cache/${source}`;
    mkdirSync(this.cacheDir, { recursive: true });
  }

  private async waitTurn(host: string) {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot.get(host) ?? 0);
    const { min, max } = config.rateLimitMs;
    this.nextSlot.set(host, slot + min + Math.random() * (max - min));
    if (slot > now) await sleep(slot - now);
  }

  private async raw(url: string, headers: Record<string, string>) {
    const host = new URL(url).host;
    await this.waitTurn(host);
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
      headers: { 'User-Agent': config.userAgent, 'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8', ...headers },
    });
    return { status: res.status, url: res.url, body: await res.text() };
  }

  private async robotsFor(u: URL) {
    const key = u.origin;
    if (!this.robots.has(key)) {
      this.robots.set(
        key,
        this.raw(`${u.origin}/robots.txt`, { Accept: 'text/plain' })
          .then((r) => (r.status === 200 && !/<html/i.test(r.body) ? r.body : ''))
          .catch(() => ''),
      );
    }
    return this.robots.get(key)!;
  }

  async get(url: string, opts: { json?: boolean; headers?: Record<string, string> } = {}): Promise<FetchResult> {
    const u = new URL(url);
    const cacheFile = `${this.cacheDir}/${createHash('sha1').update(url).digest('hex')}.txt`;
    if (this.opts.useCache !== false) {
      try {
        if (Date.now() - statSync(cacheFile).mtimeMs < config.cacheTtlHours * 3600_000) {
          return { status: 200, url, body: readFileSync(cacheFile, 'utf8'), fromCache: true };
        }
      } catch {
        /* cache miss */
      }
    }
    if (!robotsAllows(await this.robotsFor(u), u.pathname + u.search)) {
      throw new BlockedError(this.source, `robots.txt disallows ${u.pathname}`);
    }
    const headers = { Accept: opts.json ? 'application/json' : 'text/html,application/xhtml+xml,*/*', ...opts.headers };
    let lastErr: unknown;
    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      try {
        const r = await this.raw(url, headers);
        const blocked = looksBlocked(r.status, r.body);
        if (blocked) throw new BlockedError(this.source, blocked);
        if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
        if (r.status >= 400) return { ...r, fromCache: false };
        writeFileSync(cacheFile, r.body);
        return { ...r, fromCache: false };
      } catch (e) {
        if (e instanceof BlockedError) throw e;
        lastErr = e;
        const backoff = 2000 * 2 ** attempt;
        log.warn(`${this.source}: ${url} failed (${String((e as Error).message)}), retry in ${backoff / 1000}s`);
        await sleep(backoff);
      }
    }
    throw lastErr;
  }
}
