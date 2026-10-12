import { appendFileSync, mkdirSync } from 'node:fs';
import { config } from './config.ts';

type Level = 'debug' | 'info' | 'warn' | 'error';
const verbose = process.argv.includes('--verbose');
let file: string | null = null;

function write(level: Level, msg: string, extra?: unknown) {
  if (level === 'debug' && !verbose) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${extra === undefined ? '' : ' ' + JSON.stringify(extra)}`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
  try {
    if (!file) {
      mkdirSync(config.logDir, { recursive: true });
      file = `${config.logDir}/run-${new Date().toISOString().slice(0, 10)}.log`;
    }
    appendFileSync(file, line + '\n');
  } catch {
    /* logging must never break a run */
  }
}

export const log = {
  debug: (m: string, e?: unknown) => write('debug', m, e),
  info: (m: string, e?: unknown) => write('info', m, e),
  warn: (m: string, e?: unknown) => write('warn', m, e),
  error: (m: string, e?: unknown) => write('error', m, e),
};
