// SPDX-License-Identifier: AGPL-3.0-only

// The page's reports to the server (POST /api/client-report): the errors it
// meets, and how long its start took. The route needs a session, so they
// wait here until there is one: a returning player's as soon as their
// sailor is known, a new player's once their sailor is made. A page that
// never has one, the sandbox's or a visitor's who leaves, sends nothing.
//
// No player's words leave the page: a message is cut before the first
// thing quoted in it, an address in it becomes its file's name, and a
// stack is its asset names and line numbers only. Five errors a page at
// most, the same one once.

import { BUILD } from './build';

/** The start's stages, ms from the navigation's start; one not passed through is left out. */
export interface Stages {
  /** The page's HTML arrived. */
  shell?: number;
  /** The cover painted, the page's first paint. */
  cover?: number;
  /** The start screen, or the player's own sailor, could be tapped. */
  start?: number;
  /** Set sail tapped. */
  tap?: number;
  /** The world revealed. */
  reveal?: number;
}

/** A start's report: its stages, the bytes fetched to the reveal, the visit, the tier. */
export interface Startup {
  stages: Stages;
  bytes: number;
  visit: Visit;
  tier: number;
}

/** The page's files not in this browser before; in it, from its cache; or served by the service worker. */
export type Visit = 'first' | 'return' | 'worker';

/** The most errors a page reports. */
export const ERRORS = 5;
/** The most reports held waiting for a session. */
export const HELD = 8;
/** The longest message and stack sent: characters, and bytes. */
const MESSAGE = 300;
const STACK = 2048;

/** What reports go through: sending one, tests stand in for it. */
export type Send = (body: string) => void;

/** Posts a report, and forgets it: one lost is no matter. */
export function post(body: string): void {
  void fetch('/api/client-report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {});
}

export class Reports {
  readonly #send: Send;
  readonly #held: string[] = [];
  readonly #seen = new Set<string>();
  #open = false;
  #errors = 0;

  constructor(send: Send = post) {
    this.#send = send;
  }

  /** An error met: its message and stack, sent cleaned, at most ERRORS a page and each once. */
  error(message: string, stack: string): void {
    const m = cleanMessage(message);
    const s = cleanStack(stack);
    const key = `${m}\n${s}`;
    if (m === '' || this.#errors >= ERRORS || this.#seen.has(key)) {
      return;
    }
    this.#seen.add(key);
    this.#errors++;
    this.#report({ build: BUILD, kind: 'error', message: m, ...(s === '' ? {} : { stack: s }) });
  }

  /** The start, once revealed. */
  startup(s: Startup): void {
    const stages: Record<string, number> = {};
    for (const [k, v] of Object.entries(s.stages)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        stages[k] = Math.round(v);
      }
    }
    this.#report({
      build: BUILD,
      kind: 'startup',
      stages,
      bytes: Math.max(0, Math.round(s.bytes)),
      visit: s.visit,
      tier: s.tier,
    });
  }

  /** There is a session: what waited goes, and what comes after at once. */
  open(): void {
    if (this.#open) {
      return;
    }
    this.#open = true;
    for (const body of this.#held.splice(0)) {
      this.#send(body);
    }
  }

  /** How many wait for a session. */
  get held(): number {
    return this.#held.length;
  }

  #report(r: object): void {
    const body = JSON.stringify(r);
    if (this.#open) {
      this.#send(body);
    } else if (this.#held.length < HELD) {
      this.#held.push(body);
    }
  }
}

/** Quotes of every kind: what follows one may be a player's words. */
const QUOTES = /["'`“”‘’«»]/;
/** An address: what it names is kept, its file's name. */
const ADDRESS = /\b(?:https?|wss?|blob):\/*[^\s"'`]*/g;

/**
 * An error's message as it is sent: each address its file's name, cut
 * before anything quoted, to 300 characters.
 */
export function cleanMessage(message: string): string {
  let m = message.replace(ADDRESS, (a) => fileOf(a));
  const q = m.search(QUOTES);
  if (q >= 0) {
    m = m.slice(0, q);
  }
  m = m.replace(/\s+/g, ' ').trim();
  return [...m].slice(0, MESSAGE).join('');
}

/** An address's file: its last part, without its query or fragment. */
function fileOf(address: string): string {
  const path = address.split(/[?#]/)[0] ?? '';
  return (
    path
      .split('/')
      .filter((p) => p !== '')
      .pop() ?? ''
  );
}

/** A frame of a stack: a file of the page's, any query after it, its line and column. */
const FRAME = /([A-Za-z0-9._-]+\.(?:js|mjs|ts|tsx|wasm))(?:\?[^:\s)]*)?:(\d+)(?::(\d+))?/g;

/** A stack as it is sent: each frame's asset name and line, one a line, to 2 KB. */
export function cleanStack(stack: string): string {
  const out: string[] = [];
  let size = 0;
  for (const m of stack.matchAll(FRAME)) {
    const line = m[3] === undefined ? `${m[1]}:${m[2]}` : `${m[1]}:${m[2]}:${m[3]}`;
    if (size + line.length + 1 > STACK) {
      break;
    }
    out.push(line);
    size += line.length + 1;
  }
  return out.join('\n');
}

/** Reports the page's errors, thrown and unhandled, from now on. */
export function reportErrors(reports: Reports, target: Window = window): void {
  target.addEventListener('error', (e: ErrorEvent) => {
    const err: unknown = e.error;
    reports.error(
      err instanceof Error ? err.message : e.message,
      err instanceof Error ? (err.stack ?? '') : `${e.filename}:${e.lineno}:${e.colno}`,
    );
  });
  target.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const r: unknown = e.reason;
    reports.error(
      r instanceof Error ? r.message : String(r),
      r instanceof Error ? (r.stack ?? '') : '',
    );
  });
}

/** The navigation's timing, as far as it is read here. */
export interface Navigation {
  responseEnd: number;
  workerStart: number;
  transferSize: number;
  deliveryType?: string;
}

/**
 * The visit, from the navigation and the page's entry script: served by
 * the service worker; or the entry from this browser's cache (nothing of
 * it over the wire); or a first.
 */
export function visitOf(
  nav: Navigation | null,
  entry: { transferSize: number; decodedBodySize: number } | null,
): Visit {
  if (nav !== null && nav.workerStart > 0) {
    return 'worker';
  }
  if (entry !== null && entry.transferSize === 0 && entry.decodedBodySize > 0) {
    return 'return';
  }
  return nav?.deliveryType === 'cache' ? 'return' : 'first';
}

/** The page's own start, from the browser's timeline: the shell's arrival, the first paint, the visit. */
export function pageStart(entryUrl: string): { shell: number; cover: number; visit: Visit } {
  const perf = globalThis.performance;
  const nav = (perf?.getEntriesByType?.('navigation')[0] ?? null) as Navigation | null;
  const paint = perf?.getEntriesByName?.('first-contentful-paint')[0] ?? null;
  const entry = (perf?.getEntriesByName?.(entryUrl)[0] ?? null) as {
    transferSize: number;
    decodedBodySize: number;
  } | null;
  return {
    shell: nav?.responseEnd ?? 0,
    cover: paint?.startTime ?? 0,
    visit: visitOf(nav, entry),
  };
}
