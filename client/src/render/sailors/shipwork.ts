// SPDX-License-Identifier: AGPL-3.0-only

// A ship's work, as her company does it by rule (shiprules.ts): where her
// yards are as the braces turn them and the reef lowers them, where her
// people haul on the braces, and where her topmen lie out on the yards.
// Nothing here is drawn; the same rules place the ship in view's people and
// any other ship's.
//
// - Her yards: each turns with its mast's yards' node about the mast (the
//   fore yards by the fore braces, the main's and the mizzen's by the after
//   ones), and a topsail's yard comes down to its lower reef band as the
//   topsails are reefed, as her model is drawn (squarerig.ts).
// - The braces: when a group of yards swings, its lee braces are hauled:
//   the braces whose yardarms the swing brings aft. Those hauling tally on
//   along each brace's fall, the main brace's first, from its lead out,
//   each facing the lead.
// - Aloft: when her topgallants are taken in or set, her topmen lie out on
//   the topgallant yards of the fore and main; when her topsails are reefed
//   or shaken out, on the three topsail yards. Four to a yard (two on the
//   mizzen topsail's), the first two to the yardarms.
//
// Everything is in the ship model's frame (x to starboard, y up, z aft).

import { Matrix4, Vector3 } from 'three';
import type { BoatStation } from '../../catalog';
import type { Company, ShipYard } from './ship';

const DEG = Math.PI / 180;

/**
 * A group of yards swings when its turn changes faster than this, rad/s,
 * for SWING_START seconds and SWING_MOVE radians one way; it has stopped
 * once slower for SWING_STOP. Yards slatting about where they are braced
 * are no swing.
 */
export const SWING = 0.5 * DEG;
export const SWING_START = 0.4;
export const SWING_MOVE = 5 * DEG;
export const SWING_STOP = 1;
/** Seconds the hands stand at the fall once a swing is done (coiling it down), before they walk back. */
export const COIL_TIME = 4;
/** How far a hauler stands back from their hands on the fall, m: where they walk to. */
export const HANDS_BACK = 0.45;
/** The reef is in once it has not changed for this long, s. */
export const REEF_STILL = 2;
/** Seconds a topman takes over each metre of height going aloft or coming down the shrouds (a cut). */
export const CLIMB_PER_METRE = 0.76;
/** How many lie out on a yard: four, two on the mizzen's. */
export const TOPMEN = 4;
export const MIZZEN_TOPMEN = 2;
/** Along a yard's footrope from its middle to its arm, the shares of it the topmen lie out at: the yardarm first, then nearer the slings. */
export const ON_YARD = [0.8, 0.2] as const;
/** A yard's footrope runs from this far out from its middle to this far in from its arm, m (her model's). */
export const FOOTROPE_FROM = 0.6;
export const FOOTROPE_INSET = 0.2;
/** A brace is made fast this far in from its yard's arm, m. */
export const BRACE_IN = 0.15;

const Y = new Vector3(0, 1, 0);
const m4 = new Matrix4();

/** How far a yard's sail has been taken in at a reef level (0 … 2): its yard lowered by its drop times this. */
export function yardTaken(y: ShipYard, reef: number): number {
  return y.reef > 0 && y.drop > 0 ? Math.min(Math.max(reef - (y.reef - 1), 0), 1) : 0;
}

/**
 * A yard's frame in her model's (its middle, x along it to starboard, y up,
 * z aft at rest), into out: its mast's yards' node turned by turn (the
 * physics' yards as yardsTurn has them), the yard lowered as reef has it.
 */
export function yardFrame(y: ShipYard, turn: number, reef: number, out: Matrix4): Matrix4 {
  out.makeTranslation(y.origin.x, y.origin.y, y.origin.z);
  out.multiply(m4.makeRotationAxis(Y, turn));
  return out.multiply(m4.makeTranslation(y.at.x, y.at.y - y.drop * yardTaken(y, reef), y.at.z));
}

/** The turn of a yard's group: the fore yards' or the after ones'. */
export function turnOf(y: ShipYard, turns: { fore: number; after: number }): number {
  return y.group === 'fore' ? turns.fore : turns.after;
}

/** A yard's arm on a side (+1 starboard), where its brace is made fast, in its own frame. */
export function armOf(y: ShipYard, side: number, out: Vector3): Vector3 {
  return out.set(side * (y.half - BRACE_IN), 0, 0);
}

/** Where along a yard's footrope a share of it is, out from its middle, m. */
export function alongYard(y: ShipYard, share: number): number {
  return FOOTROPE_FROM + (y.half - FOOTROPE_INSET - FOOTROPE_FROM) * share;
}

/** A place hauling on a brace: which brace and how far along its fall, the side, the hands, the facing and where the feet are. */
export interface HaulPlace {
  brace: number;
  k: number;
  side: number;
  /** The hands on the fall, in her frame. */
  hands: Vector3;
  /** The way the hauler faces, toward the lead: a yaw (atan2 of the way's x and z). */
  yaw: number;
  /** Where the hauler stands, on her deck. */
  feet: Vector3;
}

/**
 * The places hauling on a group's braces on a side, in the order they fill:
 * the braces in her model's order (the main brace and the fore brace
 * first), each from its lead out.
 */
export function haulPlaces(c: Company, group: 'fore' | 'after', side: number): HaulPlace[] {
  const out: HaulPlace[] = [];
  c.braces.forEach((b, i) => {
    if (b.group !== group) {
      return;
    }
    b.hands.forEach((h, k) => {
      const hands = new Vector3(side * h.x, h.y, h.z);
      // Facing the way toward the lead along the fall: from the next place out to this one.
      const toward = k > 0 ? (b.hands[k - 1] as Vector3) : null;
      const next = b.hands[k + 1] ?? null;
      let dx: number;
      let dz: number;
      if (toward !== null) {
        dx = toward.x - h.x;
        dz = toward.z - h.z;
      } else if (next !== null) {
        dx = h.x - next.x;
        dz = h.z - next.z;
      } else {
        dx = b.lead.x - h.x;
        dz = b.lead.z - h.z;
      }
      const l = Math.hypot(dx, dz) || 1;
      dx = (side * dx) / l;
      dz /= l;
      out.push({
        brace: i,
        k,
        side,
        hands,
        yaw: Math.atan2(dx, dz),
        feet: new Vector3(hands.x - dx * HANDS_BACK, hands.y - b.over, hands.z - dz * HANDS_BACK),
      });
    });
  });
  return out;
}

/** The side whose braces a swing hauls: the side whose yardarms it brings aft (+1 starboard), by the way the turn goes. */
export function hauledSide(rate: number): number {
  return rate < 0 ? 1 : -1;
}

/** A place on a yard for a topman: which yard, how far out along it (+ starboard), and their order. */
export interface YardPlace {
  yard: number;
  x: number;
}

/** The places topmen lie out at on a yard, in the order they go: the yardarms first, starboard then port, then nearer the slings. */
export function yardPlaces(c: Company, yard: number): YardPlace[] {
  const y = c.yards[yard];
  if (y === undefined) {
    return [];
  }
  const n = y.mast === 'mizzen' ? MIZZEN_TOPMEN : TOPMEN;
  const out: YardPlace[] = [];
  for (const share of ON_YARD) {
    for (const side of [1, -1]) {
      out.push({ yard, x: side * alongYard(y, share) });
    }
  }
  return out.slice(0, n);
}

/** The yards reefed in a band: 1 the topgallants (the first reef), 2 the topsails (the second). */
export function reefedYards(c: Company, band: number): number[] {
  const out: number[] = [];
  // The main's first, then the fore's, then the mizzen's.
  for (const mast of ['main', 'fore', 'mizzen'] as const) {
    c.yards.forEach((y, i) => {
      if (y.mast === mast && y.reef === band) {
        out.push(i);
      }
    });
  }
  return out;
}

/**
 * The stations whose people stay when the hands go to the braces or aloft:
 * the master's, the first to windward beside the wheel; the lookouts', the
 * one aloft and the two furthest forward.
 */
export function keepers(stations: readonly BoatStation[]): Set<number> {
  const keep = new Set<number>([0]);
  const master = stations.findIndex((s, i) => i > 0 && s.windward === true);
  if (master > 0) {
    keep.add(master);
  }
  stations.forEach((s, i) => {
    if (s.pose === 'aloft') {
      keep.add(i);
    }
  });
  const forward = stations
    .map((s, i) => ({ i, z: s.at[2] as number }))
    .filter(({ i }) => i > 0 && stations[i]?.pose !== 'aloft')
    .sort((a, b) => a.z - b.z)
    .slice(0, 2);
  for (const f of forward) {
    keep.add(f.i);
  }
  return keep;
}
