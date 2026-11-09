// SPDX-License-Identifier: AGPL-3.0-only

// The fleet's sailor's place in the boat: a rigid figure posed seated at the
// helm (the far level), drawn in boats other than the one in view, whose
// sailor is skinned and posed in full (sailors/runtime.ts). Sailing, the
// figure sits on the side deck it last crossed to, where its own file seats
// it, and leans out as it hikes. In the water it floats beside the hull on the
// high side; on the daggerboard it stands on the board, leaning back to lever
// the boat up; climbing back in, it is half over the gunwale. At a wheel it
// is at the helmsman's place, facing forward, whatever the physics says:
// raised to a standing sailor's height, behind the wheel. On a boat with a
// trapeze, further out than the rail it is out on the wire: a figure of its
// own, posed so, placed from the rack's edge on its side. Positions are
// in the boat's heeled frame (the model's: x to starboard, y up, z aft), the
// figure's origin at its hips; the figure faces +x before it is turned.

import { wireDepth } from './sailors/trapeze';

/** The sailor's modes, State.SailorMode (internal/physics/records.go). */
export const SAILING = 0;
export const IN_WATER = 1;
export const ON_BOARD = 2;
export const CLIMBING = 3;

/** Hiking beyond this offset leans the body out, fully LEAN_MOST radians at LEAN_FULL. */
const LEAN_FROM = 0.55;
const LEAN_FULL = 0.95;
const LEAN_MOST = 0.6;

export interface SailorPlace {
  x: number;
  y: number;
  z: number;
  /** The turn about the vertical, radians: 0 faces starboard, π faces port. */
  facing: number;
  /** The tilt about the fore-and-aft axis, radians, applied after the turn (Euler order ZYX). */
  tilt: number;
  /** Out on a trapeze's wire: the side, +1 starboard, −1 port (the figure on the wire, placed from that rack's edge); 0 not. */
  wire?: number;
}

export interface SailorFrame {
  /** Where the figure is seated sailing: out from the centreline, and up, metres. */
  seatOut: number;
  seatY: number;
  /** The seat's station along the boat, metres aft of the centre of gravity. */
  seatZ: number;
  /** The centre of gravity's height above the waterline, the heel's pivot. */
  centreOfGravity: number;
  /** The daggerboard's station, metres aft (negative: forward) of the centre of gravity. */
  boardZ: number;
  /** The board's depth below the waterline where the sailor stands on it. */
  boardDepth: number;
  /** Where the helmsman stands at a wheel (on the deck, the model's frame), on a boat steered by one. */
  wheel?: { y: number; z: number } | null;
  /**
   * On a boat with a trapeze: its starboard rack's edge (the model's
   * frame), where the hiking ends at the rail, and the physics' furthest
   * reach out, metres.
   */
  trapeze?: { x: number; y: number; z: number; rail: number; reach: number } | null;
}

/** Further out than this on a trapeze (wireDepth's), more on the wire than on the rail: its figure is the one out on the wire. */
const ON_THE_WIRE = 0.5;

/** The seated figure at a wheel: its seat this high over the deck (its head a standing sailor's), this far aft of the helmsman's place (its knees short of the wheel). */
const WHEEL_SEAT_UP = 0.75;
const WHEEL_SEAT_AFT = 0.5;

/**
 * Where the figure is for a sailor offset (m, positive to starboard), a
 * mode and the boat's heel (radians, positive starboard down). side is the
 * side the figure sat on last, kept while it crosses the centreline. On a
 * boat with a trapeze, out on the wire if wire allows (the figure on the
 * wire is there to draw).
 */
export function placeSailor(
  offset: number,
  mode: number,
  heel: number,
  frame: SailorFrame,
  side: number,
  out: SailorPlace,
  wire = true,
): SailorPlace {
  out.wire = 0;
  if (frame.wheel) {
    out.x = 0;
    out.y = frame.wheel.y + WHEEL_SEAT_UP;
    out.z = frame.wheel.z + WHEEL_SEAT_AFT;
    // Facing forward (figureNode's facing 0 faces starboard).
    out.facing = Math.PI / 2;
    out.tilt = 0;
    return out;
  }
  // The high side of a heeled boat, where a sailor in the water holds on.
  const high = heel > 0 ? -1 : 1;
  switch (mode) {
    case IN_WATER:
      return level(high * 1.15, -0.62, frame.seatZ + 0.2, high, heel, frame, 0, out);
    case ON_BOARD: {
      // Standing on the board, which lies out over the water on the high side.
      out.x = 0;
      out.y = -frame.boardDepth;
      out.z = frame.boardZ + 0.1;
      out.facing = high < 0 ? 0 : Math.PI;
      out.tilt = heel + high * 0.45;
      return out;
    }
    case CLIMBING:
      out.x = high * 0.7;
      out.y = 0.28;
      out.z = frame.seatZ;
      out.facing = high < 0 ? 0 : Math.PI;
      out.tilt = high * 0.9;
      return out;
    default: {
      const s = Math.abs(offset) > 0.05 ? Math.sign(offset) : side;
      const t = frame.trapeze;
      if (wire && t && wireDepth(Math.abs(offset), t.rail, t.reach) >= ON_THE_WIRE) {
        // Out on the wire: its figure is placed from the rack's edge.
        out.x = s * t.x;
        out.y = t.y;
        out.z = t.z;
        out.facing = 0;
        out.tilt = 0;
        out.wire = s;
        return out;
      }
      const lean =
        LEAN_MOST *
        Math.min(1, Math.max(0, (Math.abs(offset) - LEAN_FROM) / (LEAN_FULL - LEAN_FROM)));
      out.x = s * frame.seatOut;
      out.y = frame.seatY;
      out.z = frame.seatZ;
      // Seated facing inboard, leaning outboard.
      out.facing = s < 0 ? 0 : Math.PI;
      out.tilt = -s * lean;
      return out;
    }
  }
}

/** A place given level in the world (unheeled), turned into the heeled frame. */
function level(
  x: number,
  y: number,
  z: number,
  high: number,
  heel: number,
  frame: SailorFrame,
  lean: number,
  out: SailorPlace,
): SailorPlace {
  // The heeled frame is the level one turned by −heel about the pivot; undo it.
  const c = Math.cos(heel);
  const s = Math.sin(heel);
  const dy = y - frame.centreOfGravity;
  out.x = x * c - dy * s;
  out.y = frame.centreOfGravity + x * s + dy * c;
  out.z = z;
  out.facing = high < 0 ? 0 : Math.PI;
  out.tilt = heel + lean;
  return out;
}
