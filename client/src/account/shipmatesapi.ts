// SPDX-License-Identifier: AGPL-3.0-only

// The account's shipmates, as the server answers them: who they are and
// whether they are in the game, the offers waiting for the player's
// answer, the people the player sailed with lately, and the account's own
// "Appear offline". Offering, accepting, declining, ending, blocking and
// reporting go by HTTP; the messages themselves, and asking to come
// aboard, go on the game connection. Nothing here is ever an age.

import type { ReportReasonTold } from '../net/messages';
import type { Fetch } from './me';
import { call, reasonOf } from './passkeys';

/** Where a shipmate is: in the game, at sea, or nothing shown (not in the game, or appearing offline). */
export type Presence = '' | 'game' | 'sea';

/** A shipmate: their account ID, name and look; where they are; whether they skipper a boat at sea now. */
export interface Shipmate {
  id: string;
  name: string;
  look: number;
  presence: Presence;
  skipper: boolean;
}

/** An offer made to the player, waiting for their answer. */
export interface ShipmateOffer {
  id: string;
  name: string;
  look: number;
}

/**
 * Someone the player was aboard with in the last day: whether they are a
 * shipmate, whether the player's own offer to them waits, and whether
 * the player may offer now.
 */
export interface RecentCrew {
  id: string;
  name: string;
  look: number;
  shipmate: boolean;
  offered: boolean;
  can: boolean;
}

/** GET /api/shipmates. */
export interface ShipmatesList {
  /** The account itself appears offline. */
  offline: boolean;
  /** Messages between shipmates are on: off, threads rest and have no field. */
  messages: boolean;
  shipmates: Shipmate[];
  offers: ShipmateOffer[];
  /** The newest first. */
  recent: RecentCrew[];
}

/** Whom an offer or an ending is for: an account on the list, or someone aboard the player's boat now by seat. */
export type ShipmateTo = { id: string } | { seat: number };

/**
 * What came of an offer: offered, waiting for their answer; made, they had
 * offered too; not yet sailed together long enough; the player's list
 * full; too many of the player's own offers waiting; already shipmates.
 * Anything else is the server's reason ('offline', 'unavailable').
 */
export type OfferResult = 'offered' | 'made' | 'not-yet' | 'full' | 'offers' | 'already';

/** What came of accepting: made; the offer lapsed (gone); the list full. Anything else is the server's reason. */
export type AcceptResult = 'made' | 'gone' | 'full';

/** The server's side; tests and the sandbox's scenes stand in for it. */
export interface ShipmatesServer {
  /** The list, or null when it could not be read. */
  list(): Promise<ShipmatesList | null>;
  offer(to: ShipmateTo): Promise<OfferResult | string>;
  accept(id: string): Promise<AcceptResult | string>;
  decline(id: string): Promise<boolean>;
  end(to: ShipmateTo): Promise<boolean>;
  block(id: string): Promise<boolean>;
  report(id: string, reason: ReportReasonTold, note: string): Promise<boolean>;
  /** Appear offline, or no longer. */
  offline(on: boolean): Promise<boolean>;
}

const OFFERED: readonly string[] = ['offered', 'made', 'not-yet', 'full', 'offers', 'already'];

function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function lookOf(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : -1;
}

function presenceOf(v: unknown): Presence {
  return v === 'game' || v === 'sea' ? v : '';
}

/** The records of an array that are objects with an ID. */
function records(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? v.filter(
        (r): r is Record<string, unknown> =>
          r !== null && typeof r === 'object' && text((r as Record<string, unknown>).id) !== '',
      )
    : [];
}

/** The list as the page reads it from the server's JSON; null for anything that is not one. */
export function listOf(b: unknown): ShipmatesList | null {
  if (b === null || typeof b !== 'object' || Array.isArray(b)) {
    return null;
  }
  const o = b as Record<string, unknown>;
  return {
    offline: o.offline === true,
    messages: o.messages !== false,
    shipmates: records(o.shipmates).map((r) => ({
      id: text(r.id),
      name: text(r.name),
      look: lookOf(r.look),
      presence: presenceOf(r.presence),
      skipper: r.skipper === true,
    })),
    offers: records(o.offers).map((r) => ({
      id: text(r.id),
      name: text(r.name),
      look: lookOf(r.look),
    })),
    recent: records(o.recent).map((r) => ({
      id: text(r.id),
      name: text(r.name),
      look: lookOf(r.look),
      shipmate: r.shipmate === true,
      offered: r.offered === true,
      can: r.can === true,
    })),
  };
}

/** The shipmates' routes, as the server answers them. */
export function shipmatesServer(f: Fetch = (input, init) => fetch(input, init)): ShipmatesServer {
  return {
    async list() {
      try {
        const res = await f('/api/shipmates', { cache: 'no-store', credentials: 'same-origin' });
        return res.status === 200 ? listOf(await res.json()) : null;
      } catch {
        return null;
      }
    },
    async offer(to) {
      const a = await call(f, '/api/shipmates/offer', to);
      const r = text(a.body?.result);
      return a.status === 200 && OFFERED.includes(r) ? r : reasonOf(a);
    },
    async accept(id) {
      const a = await call(f, '/api/shipmates/accept', { id });
      if (a.status === 200) {
        return 'made';
      }
      return reasonOf(a);
    },
    async decline(id) {
      return (await call(f, '/api/shipmates/decline', { id })).status === 204;
    },
    async end(to) {
      return (await call(f, '/api/shipmates/end', to)).status === 204;
    },
    async block(id) {
      return (await call(f, '/api/shipmates/block', { id })).status === 204;
    },
    async report(id, reason, note) {
      return (await call(f, '/api/shipmates/report', { id, reason, note })).status === 204;
    },
    async offline(on) {
      return (await call(f, '/api/me/offline', { on })).status === 204;
    },
  };
}
