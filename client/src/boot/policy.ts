// SPDX-License-Identifier: AGPL-3.0-only

// The page's Trusted Types policies, made before anything else on every
// page with a script: each page's entry imports this module first. keel's
// policy for the pages (internal/api/policy.go) lets no plain string reach
// a sink that loads script or writes HTML: a script's address must come
// from one of two policies made here.
//
// - keel: the page's own addresses for script, through scriptURL(): the
//   built page's files under /assets/, the service worker (/sw.js), and
//   the human check's script at Cloudflare under /turnstile/, or a
//   stand-in for it on this origin under /turnstile/ (tools/e2e's).
// - default: what libraries pass as plain strings, which the browser
//   hands to it: a worker of the page's own (Vite's workers are this
//   origin's addresses; three.js starts its texture transcoder from a blob:
//   of this origin's), and the human check's script reloading itself. Any
//   other address, and every string of HTML or script, is refused.
//
// A browser without Trusted Types gets plain strings, as before. A page
// served with the policy as a report only (KEEL_PAGE_POLICY=report) makes
// the same policies; the browser then only tells what it would refuse.
//
// What the policy refuses, or would refuse, the page hears as a
// securitypolicyviolation event: each is told to the server as a page's
// report of kind policy, its directive, what was refused (an address's
// origin and path, never its query), and the asset and line that asked,
// never the sample the browser quotes.

/** The human check's origin: Cloudflare Turnstile's script and frame. */
export const CHECK_ORIGIN = 'https://challenges.cloudflare.com';
/** The human check's path, at Cloudflare and for its stand-in on this origin. */
export const CHECK_PATH = '/turnstile/';

/** A script's address as a policy made it: the browser's TrustedScriptURL. */
export interface TrustedScriptURL {
  toString(): string;
}

/** The parts of a policy made here. */
export interface Policy {
  readonly name: string;
  createScriptURL(input: string): TrustedScriptURL;
}

/** What a policy is made of: functions answering each kind of string, null for refused. */
interface PolicyOptions {
  createScriptURL?: (input: string) => string | null;
  createHTML?: (input: string) => string | null;
  createScript?: (input: string) => string | null;
}

/** The browser's trustedTypes, as far as it is used. */
export interface PolicyFactory {
  createPolicy(name: string, options: PolicyOptions): Policy;
}

/** An address read against the page's origin, or null for none. */
function read(address: string, origin: string): URL | null {
  try {
    const u = new URL(address, `${origin}/`);
    return u.username === '' && u.password === '' ? u : null;
  } catch {
    return null;
  }
}

/** Whether an address is the human check's: under /turnstile/ at Cloudflare. */
function isCheck(u: URL): boolean {
  return u.protocol === 'https:' && u.origin === CHECK_ORIGIN && u.pathname.startsWith(CHECK_PATH);
}

/**
 * Whether the keel policy makes a script's address of this one: the page's
 * own files under /assets/, the service worker, the human check's script
 * at Cloudflare, or its stand-in under /turnstile/ on this origin.
 */
export function keelAllows(address: string, origin: string): boolean {
  const u = read(address, origin);
  if (u === null) {
    return false;
  }
  if (u.origin === origin && (u.protocol === 'https:' || u.protocol === 'http:')) {
    return (
      u.pathname.startsWith('/assets/') ||
      u.pathname === '/sw.js' ||
      u.pathname.startsWith(CHECK_PATH)
    );
  }
  return isCheck(u);
}

/**
 * Whether the default policy lets a plain string through as a script's
 * address: an address of this origin, a blob: this origin made, or the
 * human check's script at Cloudflare.
 */
export function defaultAllows(address: string, origin: string): boolean {
  const u = read(address, origin);
  if (u === null) {
    return false;
  }
  if (u.protocol === 'blob:') {
    return u.origin === origin;
  }
  if (u.protocol === 'https:' || u.protocol === 'http:') {
    return u.origin === origin || isCheck(u);
  }
  return false;
}

/** Refused: no HTML or script is ever made from a string. */
const refused = (): null => null;

/** The page's two policies, made with the factory for the page at origin. */
export function makePolicies(
  factory: PolicyFactory,
  origin: string,
): { keel: Policy; default: Policy } {
  const keel = factory.createPolicy('keel', {
    createScriptURL: (input) => {
      if (!keelAllows(input, origin)) {
        throw new TypeError(`Not a script the page loads: ${addressOf(input)}`);
      }
      return input;
    },
  });
  const fallback = factory.createPolicy('default', {
    createScriptURL: (input) => (defaultAllows(input, origin) ? input : null),
    createHTML: refused,
    createScript: refused,
  });
  return { keel, default: fallback };
}

/** The browser's factory, if it has Trusted Types. */
function browserFactory(): PolicyFactory | null {
  const tt = (globalThis as { trustedTypes?: PolicyFactory }).trustedTypes;
  return tt !== undefined && typeof tt.createPolicy === 'function' ? tt : null;
}

let keelPolicy: Policy | null = null;

/** Makes the page's policies, once; a browser without Trusted Types has none. */
function install(): void {
  const factory = browserFactory();
  if (factory === null || typeof location === 'undefined') {
    return;
  }
  try {
    keelPolicy = makePolicies(factory, location.origin).keel;
  } catch (err) {
    // Made already (a second copy of this module), or refused by a policy
    // that names others: scriptURL() then answers plain strings, which the
    // browser refuses where it must.
    console.warn('The page’s script policies were not made:', err);
  }
}

/**
 * A script's address for a sink that loads script (a <script>'s src, the
 * service worker's registration): through the keel policy where the
 * browser has Trusted Types, as given where it has not. Throws for an
 * address the page never loads.
 */
export function scriptURL(address: string): string {
  if (typeof location !== 'undefined' && !keelAllows(address, location.origin)) {
    throw new TypeError(`Not a script the page loads: ${addressOf(address)}`);
  }
  // A TrustedScriptURL goes wherever a string does.
  return (keelPolicy?.createScriptURL(address) ?? address) as string;
}

/** What a policy report says was refused. */
export interface Violation {
  /** The directive that refused, or would have. */
  directive: string;
  /** An address's origin and path, its scheme alone for data: and blob:, or the browser's word (inline, eval, trusted-types-sink). */
  blocked: string;
  /** The asset that asked: its file's name. */
  source: string;
  /** Its line. */
  line: number;
}

/** The parts of a securitypolicyviolation event read. */
export interface ViolationEvent {
  effectiveDirective: string;
  blockedURI: string;
  sourceFile: string;
  lineNumber: number;
}

/** An address as a report tells it: its origin and path, no query or fragment; a scheme alone for others. */
export function addressOf(address: string): string {
  let u: URL;
  try {
    u = new URL(address);
  } catch {
    // A word, as the browser gives one for what has no address.
    return /^[a-z-]{1,40}$/.test(address) ? address : '';
  }
  if (
    u.protocol === 'http:' ||
    u.protocol === 'https:' ||
    u.protocol === 'ws:' ||
    u.protocol === 'wss:'
  ) {
    return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 300);
  }
  return u.protocol.slice(0, -1).slice(0, 40);
}

/** An address's file: its last part, nothing else. */
function fileOf(address: string): string {
  try {
    const parts = new URL(address).pathname.split('/');
    const name = parts[parts.length - 1] ?? '';
    return /^[A-Za-z0-9._-]{1,128}$/.test(name) ? name : '';
  } catch {
    return '';
  }
}

/** A violation as it is reported: no sample, no query, the asset's name alone. */
export function violationOf(e: ViolationEvent): Violation {
  const directive = /^[a-z-]{1,40}$/.test(e.effectiveDirective) ? e.effectiveDirective : 'other';
  return {
    directive,
    blocked: addressOf(e.blockedURI),
    source: fileOf(e.sourceFile),
    line:
      Number.isInteger(e.lineNumber) && e.lineNumber > 0 ? Math.min(e.lineNumber, 10_000_000) : 0,
  };
}

/** Where violations go: the page's reports. */
export type Sink = (v: Violation) => void;

/** The violations met before the page had somewhere to send them. */
const early: Violation[] = [];
/** The most held before then. */
const EARLY = 8;
let sink: Sink | null = null;

/** Listens for what the policy refuses, from the page's first moment. */
function listen(): void {
  if (typeof document === 'undefined') {
    return;
  }
  document.addEventListener('securitypolicyviolation', (e) => {
    const v = violationOf(e);
    if (sink !== null) {
      sink(v);
    } else if (early.length < EARLY) {
      early.push(v);
    }
  });
}

/** Sends the page's violations to sink from now on, those met already first. */
export function reportViolations(to: Sink): void {
  sink = to;
  for (const v of early.splice(0)) {
    to(v);
  }
}

install();
listen();
