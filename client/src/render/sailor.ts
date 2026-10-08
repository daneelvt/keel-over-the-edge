// SPDX-License-Identifier: AGPL-3.0-only

// The stand-in sailor's place in the boat. Sailing, the figure sits on the
// side deck by the cockpit, moves across with the physics' sailor offset
// and leans out as it hikes. In the water it floats beside the hull on the
// high side; on the daggerboard it stands on the board, leaning back to lever
// the boat up; climbing back in, it is half over the gunwale. Positions are
// in the boat's heeled frame (the model's: x to starboard, y up, z aft), the
// figure's origin at its hips; the figure faces +x before it is turned.

/** The sailor's modes, State.SailorMode (internal/physics/records.go). */
export const SAILING = 0;
export const IN_WATER = 1;
export const ON_BOARD = 2;
export const CLIMBING = 3;

/** Where the hips sit sailing: on the side deck, at most this far out, metres. */
const SEAT_OUT = 0.6;
const SEAT_HEIGHT = 0.36;
/** Hiking beyond this offset leans the body out, fully LEAN_MOST radians at LEAN_FULL. */
const LEAN_FROM = 0.35;
const LEAN_FULL = 0.95;
const LEAN_MOST = 1.05;

export interface SailorPlace {
  x: number;
  y: number;
  z: number;
  /** The turn about the vertical, radians: 0 faces starboard, π faces port. */
  facing: number;
  /** The tilt about the fore-and-aft axis, radians, applied after the turn (Euler order ZYX). */
  tilt: number;
}

export interface SailorFrame {
  /** The seat's station along the boat, metres aft of the centre of gravity. */
  seatZ: number;
  /** The centre of gravity's height above the waterline, the heel's pivot. */
  centreOfGravity: number;
  /** The daggerboard's station, metres aft (negative: forward) of the centre of gravity. */
  boardZ: number;
  /** The board's depth below the waterline where the sailor stands on it. */
  boardDepth: number;
}

/**
 * Where the figure is for a sailor offset (m, positive to starboard), a
 * mode and the boat's heel (radians, positive starboard down). side is the
 * side the figure sat on last, kept while it crosses the centreline.
 */
export function placeSailor(
  offset: number,
  mode: number,
  heel: number,
  frame: SailorFrame,
  side: number,
  out: SailorPlace,
): SailorPlace {
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
      const lean =
        LEAN_MOST *
        Math.min(1, Math.max(0, (Math.abs(offset) - LEAN_FROM) / (LEAN_FULL - LEAN_FROM)));
      out.x = s * Math.min(Math.abs(offset), SEAT_OUT);
      out.y = SEAT_HEIGHT;
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
