// SPDX-License-Identifier: AGPL-3.0-only

// The account's fleet, shared by its sailors: the player and their machine
// sailors. Each boat is of a kind in the catalog, with its sail number,
// its name (none until given), its hull's paint and its sails' cloth; and
// who has it: the sailor who sails it, or sailed it last and will again.
// A boat at sea with another of the account's sailors is taken; any other
// is free, and the player may choose it for their next voyage, or in a
// port take it in place of the one they sail. Its look is changed ashore,
// or in a port.
//
// GET /api/fleet reads the fleet; POST /api/boat chooses a boat, and POST
// /api/boat/look changes one's look. Each answers with the fleet as it
// is then, or refuses with a code, which is said in words here.

import { BOAT_NAME_LEAST, BOAT_NAME_MOST, boatNamed } from '../catalog/boatlooks';
import type { Boat, Catalog } from '../catalog/types.gen';
import type { Fetch } from './me';
import { call, type Outcome, reasonOf } from './passkeys';
import { displayForm, nameLength, REASONS, reasonText } from './reasons';

/** The parts of the catalog the fleet's screens read: the kinds of boat and their looks. */
export type BoatCatalog = Pick<Catalog, 'boats' | 'boatLooks'>;

/** A boat of the fleet, as the server lists it. */
export interface FleetBoat {
  id: string;
  /** Its kind, by the catalog's id. */
  kind: string;
  number: number;
  /** Its name; "" for none. */
  name: string;
  /** Its hull's paint and its sails' cloth, by the catalog's ids. */
  paint: string;
  cloth: string;
  /** The sailor who has it: sails it, or sailed it last and will again; "" for none. */
  sailor: string;
  /** That sailor is a machine sailor. */
  machine: boolean;
  /** That sailor is in the water in it. */
  atSea: boolean;
  /** It is the asking player's. */
  yours: boolean;
}

/** GET /api/fleet: the boat the player sails, or will take on Set sail, and every boat. */
export interface Fleet {
  boat: string;
  boats: FleetBoat[];
}

/** A boat's look as the chooser holds it: the number and name as typed. */
export interface BoatDraft {
  paint: string;
  cloth: string;
  number: string;
  name: string;
}

/** The kind of a boat, from the catalog; undefined for one it does not have. */
export function kindOf(cat: BoatCatalog, kind: string): Boat | undefined {
  return cat.boats.find((b) => b.id === kind);
}

/** A boat as it is named: "Keelboat «Saltpeter» 311". */
export function boatTitle(
  cat: BoatCatalog,
  b: Pick<FleetBoat, 'kind' | 'name' | 'number'>,
): string {
  return boatNamed(kindOf(cat, b.kind)?.name ?? b.kind, b.name, b.number);
}

/** How many a kind takes: "up to 5 aboard", or "one aboard". */
export function aboardWords(kind: Pick<Boat, 'capacity'> | undefined): string {
  const n = kind?.capacity ?? 1;
  return n <= 1 ? 'one aboard' : `up to ${n} aboard`;
}

/** A kind's name within a sentence: "a keelboat", "an …". */
export function aKind(kind: Pick<Boat, 'name'> | undefined): string {
  const name = (kind?.name ?? 'boat').toLowerCase();
  return `${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}`;
}

/** Whether a boat is at sea with another of the account's sailors, and cannot be chosen. */
export function taken(b: FleetBoat): boolean {
  return b.atSea && !b.yours;
}

/** The boat the player sails, or will take on Set sail; null for none. */
export function yoursOf(f: Fleet | null): FleetBoat | null {
  return f?.boats.find((b) => b.id === f.boat) ?? null;
}

/** The boat a sailor has, by the sailor's name; null for none. */
export function boatOf(f: Fleet | null, sailor: string): FleetBoat | null {
  return f?.boats.find((b) => b.sailor === sailor) ?? null;
}

/**
 * Where a boat is, among the fleet's to choose from: "yours", "at sea ·
 * Iron Mary" for one taken, "free", or "free · last sailed by Iron Mary".
 */
export function standingWords(f: Fleet, b: FleetBoat): string {
  if (b.id === f.boat) {
    return b.atSea ? 'yours · at sea' : 'yours';
  }
  if (taken(b)) {
    return `at sea · ${b.sailor}`;
  }
  return b.sailor === '' ? 'free' : `free · last sailed by ${b.sailor}`;
}

/**
 * A boat in the account page's list: "Keelboat «Saltpeter» 311 · at sea,
 * Iron Mary", "… · yours" for the one the player will take, or "… · free".
 */
export function fleetRowWords(cat: BoatCatalog, f: Fleet, b: FleetBoat): string {
  const where =
    b.atSea && b.sailor !== '' ? `at sea, ${b.sailor}` : b.id === f.boat ? 'yours' : 'free';
  return `${boatTitle(cat, b)} · ${where}`;
}

/** The fleet's boats in the catalog's order of kinds, then by sail number. */
export function inOrder(cat: BoatCatalog, boats: readonly FleetBoat[]): FleetBoat[] {
  const at = (k: string) => {
    const i = cat.boats.findIndex((b) => b.id === k);
    return i < 0 ? cat.boats.length : i;
  };
  return [...boats].sort((a, b) => at(a.kind) - at(b.kind) || a.number - b.number);
}

/** A boat's look as the chooser begins it: the boat's own. */
export function draftOf(b: FleetBoat): BoatDraft {
  return { paint: b.paint, cloth: b.cloth, number: String(b.number), name: b.name };
}

/** Why a sail number typed cannot be sent: "number-range", or null for one that can. */
export function numberProblem(typed: string, most: number): 'number-range' | null {
  const t = typed.trim();
  if (!/^\d{1,5}$/.test(t)) {
    return 'number-range';
  }
  const n = Number(t);
  return n >= 1 && n <= most ? null : 'number-range';
}

/** Why a name typed cannot be sent, by its length: short or long; null for one that can, or none. */
export function boatNameProblem(typed: string): 'short' | 'long' | null {
  const n = nameLength(typed);
  if (n === 0) {
    return null;
  }
  return n < BOAT_NAME_LEAST ? 'short' : n > BOAT_NAME_MOST ? 'long' : null;
}

/**
 * The fleet's words, where a code means something of its own there: the
 * name is a boat's, and refusals are of the boat or the place.
 */
export function boatReasons(most: number): Readonly<Record<string, string>> {
  return {
    short: `That name is too short: use at least ${BOAT_NAME_LEAST} letters, or none.`,
    long: `That name is too long: use at most ${BOAT_NAME_MOST} letters.`,
    characters: REASONS.characters ?? '',
    scripts: REASONS.scripts ?? '',
    words: 'That name is not allowed. Try another.',
    'number-range': `A sail number is a whole number from 1 to ${most}.`,
    boat: 'That boat is not one of your fleet’s now. Reload and try again.',
    taken: 'That boat is at sea with another of your sailors.',
    port: 'Only in port: in Port Royal’s harbour or a port town’s, not at a fishing village.',
    look: 'That paint or cloth is not one of ours. Choose another.',
    busy: 'The harbour is busy just now. Try again in a moment.',
  };
}

/**
 * The words for a code the fleet's routes refuse with. kind is the boat's,
 * for the codes that name it: its sail number another's, or no room here.
 */
export function boatReasonText(
  cat: BoatCatalog,
  code: string,
  kind?: Pick<Boat, 'name'>,
  number?: string,
): string {
  if (code === 'number') {
    const t = number?.trim() ?? '';
    const which = t === '' ? 'That sail number' : `Sail number ${t}`;
    return `${which} is another ${(kind?.name ?? 'boat').toLowerCase()}’s: choose another.`;
  }
  if (code === 'room') {
    return `No room here for ${aKind(kind)}: try the open water of the harbour.`;
  }
  return boatReasons(cat.boatLooks.numbers)[code] ?? reasonText(code);
}

const browserFetch: Fetch = (input, init) => fetch(input, init);

/** Whether a body is the fleet. */
function isFleet(v: unknown): v is Fleet {
  const f = v as Fleet | null;
  return (
    typeof f === 'object' && f !== null && typeof f.boat === 'string' && Array.isArray(f.boats)
  );
}

/** GET /api/fleet. */
export async function readFleet(f: Fetch = browserFetch): Promise<Outcome<Fleet>> {
  try {
    const res = await f('/api/fleet', { cache: 'no-store', credentials: 'same-origin' });
    if (res.status === 503) {
      return { ok: false, reason: 'busy' };
    }
    const body = (await res.json()) as unknown;
    if (res.status !== 200 || !isFleet(body)) {
      const error = (body as { error?: unknown } | null)?.error;
      return { ok: false, reason: typeof error === 'string' ? error : 'unavailable' };
    }
    return { ok: true, value: body };
  } catch {
    return { ok: false, reason: 'offline' };
  }
}

/** POSTs to one of the fleet's routes: the fleet, or the code it was refused with. */
async function post(f: Fetch, path: string, body: unknown): Promise<Outcome<Fleet>> {
  const a = await call(f, path, body);
  if (a.status === 200 && isFleet(a.body)) {
    return { ok: true, value: a.body };
  }
  return { ok: false, reason: a.status === 503 ? 'busy' : reasonOf(a) };
}

/** POST /api/boat: the boat chosen, for the next voyage, or in a port in place of the one sailed. */
export function chooseBoat(boat: string, f: Fetch = browserFetch): Promise<Outcome<Fleet>> {
  return post(f, '/api/boat', { boat });
}

/** What POST /api/boat/look is sent: the boat, and each part of its look that changes. */
export interface LookChange {
  boat: string;
  paint?: string;
  cloth?: string;
  number?: number;
  name?: string;
}

/** POST /api/boat/look. */
export function changeBoatLook(
  change: LookChange,
  f: Fetch = browserFetch,
): Promise<Outcome<Fleet>> {
  return post(f, '/api/boat/look', change);
}

/** What changes from a boat's look to the draft's, as POST /api/boat/look is sent it. */
export function changeOf(b: FleetBoat, d: BoatDraft): LookChange {
  const c: LookChange = { boat: b.id };
  if (d.paint !== b.paint) {
    c.paint = d.paint;
  }
  if (d.cloth !== b.cloth) {
    c.cloth = d.cloth;
  }
  const n = Number(d.number.trim());
  if (n !== b.number) {
    c.number = n;
  }
  const name = displayForm(d.name);
  if (name !== b.name) {
    c.name = name;
  }
  return c;
}
