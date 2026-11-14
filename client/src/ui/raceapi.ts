// SPDX-License-Identifier: AGPL-3.0-only

// Races ashore, as the server tells them: the board of the races ahead
// (the harbour's next, the player's own, and what a race may be made
// with), a race's card by its link's code, and the acts on it. Every
// route is behind the player's session; a refusal comes back with its
// reason, and, where it has one, when it lifts.

import type { Fetch } from '../account/me';

/** Who may enter a race. */
export type Who = 'everyone' | 'humans' | 'machines' | 'newcomers';

/** Where a race stands. */
export type Phase = 'open' | 'closed' | 'starting' | 'racing' | 'finished' | 'cancelled' | 'ended';

/** A course, as a card or the board tells it. */
export interface CourseTold {
  id: string;
  kind: 'buoy' | 'island';
  /** A buoy course's shape. */
  shape?: 'triangle' | 'windward-leeward';
  /** A buoy course's long form. */
  long?: boolean;
  name: string;
  /** An island course's length, m. */
  length?: number;
  /** An island course's way: x, y pairs, m east and north of the world's centre. */
  way?: number[];
  /** An island course's number. */
  number?: number;
  /** The boats it is offered to, by id, with the minutes each is expected to take. */
  boats?: Record<string, number>;
}

/** Whether the player may enter, and why not. */
export interface EnterTold {
  ok: boolean;
  reason?: string;
  /** When the refusal lifts, ms of UTC, where it does. */
  until?: number;
}

/** An entrant on a card: a name, or null where the reader is not told it. */
export interface Entrant {
  number: number;
  name: string | null;
  /** The boat's own name, or null for none. */
  boat?: string | null;
  machine: boolean;
  newcomer: boolean;
  me?: boolean;
}

/** A race's card: GET /api/race/{code}. */
export interface RaceCard {
  code: string;
  link: string;
  name: string;
  kind: 'race' | 'trial';
  phase: Phase;
  harbour: boolean;
  who: Who;
  course: CourseTold;
  boat: { id: string; name: string };
  /** The start, ms of UTC; a trial's opening. */
  startsAt: number;
  minutes: number;
  /** The owner; null for the Harbourmaster's; a null name for one not named to the reader. */
  owner: { name: string | null; machine: boolean } | null;
  most: number;
  entrants: Entrant[];
  mine: { owner: boolean; entered: boolean; withCrew: boolean; number: number; moved: boolean };
  enter: EnterTold;
}

/** A race on the board. */
export interface Summary {
  code: string;
  name: string;
  kind: 'race' | 'trial';
  phase: Phase;
  harbour: boolean;
  who: Who;
  boat: { id: string; name: string };
  startsAt: number;
  entered: number;
  most: number;
  mine: { owner: boolean; entered: boolean };
  enter: EnterTold;
}

/** A boat a race may be made for. */
export interface BoatChoice {
  id: string;
  name: string;
  most: number;
  /** Whether buoy courses are offered to it: false for island courses only. */
  buoys: boolean;
}

/** What a race may be made with, now. */
export interface MakeChoices {
  can: EnterTold;
  earliest: number;
  latest: number;
  who: Who[];
  /** The player's own boat's kind. */
  boat: string;
  boats: BoatChoice[];
  courses: CourseTold[];
}

/** GET /api/races. */
export interface RacesBoard {
  harbour: Summary[];
  greenhorn: number[];
  mine: Summary[];
  make: MakeChoices;
}

/** A refusal: the reason, when it lifts, and for a name refused why. */
export interface Refusal {
  status: number;
  reason: string;
  until?: number;
  name?: string;
}

/** An answer: what was asked for, or why not. */
export type Told<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

/** What a race is made of: POST /api/race's body. */
export interface MakeBody {
  kind: 'race' | 'trial';
  course: string;
  boat: string;
  at: number;
  who: Who;
  name: string;
}

/** The acts on a race, each answering its card. */
export type RaceVerb = 'enter' | 'withdraw' | 'close' | 'cancel' | 'remove' | 'move' | 'again';

const own: Fetch = (input, init) => fetch(input, init);

/** A link's code: ten letters and digits of base32, lower case. */
export const RACE_CODE = /^[a-z2-7]{10}$/;

/** The query of a race's link. */
export const RACE_PARAM = 'r';

/** The race link the page was opened at, by its code; null for none. */
export function raceFromQuery(query: URLSearchParams): string | null {
  const r = query.get(RACE_PARAM) ?? '';
  return RACE_CODE.test(r) ? r : null;
}

/** Reads an answer: the JSON hoped for on ok, or the refusal it carries. */
async function told<T>(res: Response, ok: number[]): Promise<Told<T>> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // No body, or not the server's JSON.
  }
  if (ok.includes(res.status) && body !== null && typeof body === 'object') {
    return { ok: true, value: body as T };
  }
  const b = (body ?? {}) as { error?: unknown; until?: unknown; name?: unknown };
  const refusal: Refusal = {
    status: res.status,
    reason: typeof b.error === 'string' ? b.error : 'unread',
  };
  if (typeof b.until === 'number' && b.until > 0) {
    refusal.until = b.until;
  }
  if (typeof b.name === 'string') {
    refusal.name = b.name;
  }
  return { ok: false, refusal };
}

/** A request, its answer read; a fault of the network is "offline". */
async function ask<T>(
  f: Fetch,
  path: string,
  init: RequestInit,
  ok: number[] = [200],
): Promise<Told<T>> {
  try {
    const res = await f(path, { cache: 'no-store', credentials: 'same-origin', ...init });
    return await told<T>(res, ok);
  } catch {
    return { ok: false, refusal: { status: 0, reason: 'offline' } };
  }
}

/** GET /api/races: the board. */
export function readBoard(f: Fetch = own): Promise<Told<RacesBoard>> {
  return ask<RacesBoard>(f, '/api/races', {});
}

/** GET /api/race/{code}: its card. */
export function readCard(code: string, f: Fetch = own): Promise<Told<RaceCard>> {
  return ask<RaceCard>(f, `/api/race/${encodeURIComponent(code)}`, {});
}

/** POST /api/race/{code}/{verb}, with its body: the card as it now stands. */
export function raceAct(
  code: string,
  verb: RaceVerb,
  body?: unknown,
  f: Fetch = own,
): Promise<Told<RaceCard>> {
  return ask<RaceCard>(
    f,
    `/api/race/${encodeURIComponent(code)}/${verb}`,
    {
      method: 'POST',
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    },
    verb === 'again' ? [201] : [200],
  );
}

/** POST /api/race/{code}/spoon: the wooden spoon given there hung from the sailor's sterns for the world, or taken down. */
export function hangSpoon(
  code: string,
  hang: boolean,
  f: Fetch = own,
): Promise<Told<{ hang: boolean }>> {
  return ask<{ hang: boolean }>(f, `/api/race/${encodeURIComponent(code)}/spoon`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hang }),
  });
}

/** POST /api/race: the race made, its card. */
export function makeRace(body: MakeBody, f: Fetch = own): Promise<Told<RaceCard>> {
  return ask<RaceCard>(
    f,
    '/api/race',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    [201],
  );
}

/** GET /api/race/name: a name suggested for a race; "" when none comes. */
export async function suggestName(
  q: { kind: string; course: string; boat: string; at: number },
  f: Fetch = own,
): Promise<string> {
  const p = new URLSearchParams({
    kind: q.kind,
    course: q.course,
    boat: q.boat,
    at: String(Math.round(q.at)),
  });
  const a = await ask<{ name?: unknown }>(f, `/api/race/name?${p}`, {});
  return a.ok && typeof a.value.name === 'string' ? a.value.name : '';
}

/** The file name a Content-Disposition gives, or the fallback. */
export function fileNameOf(disposition: string | null, fallback: string): string {
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition ?? '');
  if (m === null || m[1] === undefined) {
    return fallback;
  }
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** Saves a blob to the device as a file, as a download. */
export function saveFile(blob: Blob, name: string): void {
  const a = document.createElement('a');
  const href = URL.createObjectURL(blob);
  a.href = href;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/**
 * Add to calendar: the race's calendar file, fetched with the session and
 * saved as a file the phone's calendar opens; never an address to
 * subscribe to. Whether it was saved.
 */
export async function saveCalendar(
  code: string,
  f: Fetch = own,
  save: (blob: Blob, name: string) => void = saveFile,
): Promise<boolean> {
  try {
    const res = await f(`/api/race/${encodeURIComponent(code)}/calendar.ics`, {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (res.status !== 200) {
      return false;
    }
    const blob = await res.blob();
    save(
      new Blob([blob], { type: 'text/calendar' }),
      fileNameOf(res.headers.get('Content-Disposition'), 'race.ics'),
    );
    return true;
  } catch {
    return false;
  }
}

const WATCH_KEY = 'keel.races.watch';

/** The races the player asked to watch when they start, by code, kept on this device. */
export function watchedRaces(storage: Storage | null = safeStorage()): string[] {
  try {
    const v = JSON.parse(storage?.getItem(WATCH_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

/** Remembers a race to watch when it starts: the newest few. */
export function watchRace(code: string, storage: Storage | null = safeStorage()): void {
  const all = [...watchedRaces(storage).filter((c) => c !== code), code].slice(-12);
  try {
    storage?.setItem(WATCH_KEY, JSON.stringify(all));
  } catch {
    // Private browsing, or no room: not kept.
  }
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
