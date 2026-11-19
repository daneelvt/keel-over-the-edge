// SPDX-License-Identifier: AGPL-3.0-only

// A boat of two hulls heels about its lee hull. The physics heels every boat
// about its centre of gravity on the centreline, as one body with one heel;
// a catamaran so heeled would draw her lee hull pushed down into the water
// and lift her windward one only as far. So everything that draws a boat's
// pose (her model, the sea kept out of her hulls, her wakes, foam and spray,
// her crew and the camera) takes her heave from here: lifted by half the
// spacing of her hulls times the sine of her heel, which keeps her lee hull
// where it floats and lifts her windward one clear. A monohull's heave is
// as the physics has it.

/** How far a boat whose hulls are spacing apart, metres, is lifted at heel, radians: 0 for one hull. */
export function hullLift(spacing: number, heel: number): number {
  return spacing > 0 ? (spacing / 2) * Math.abs(Math.sin(heel)) : 0;
}

/** A hull of a boat: its centreline's place east and north, and how far it is lifted from where it floats, metres. */
export interface HullAt {
  east: number;
  north: number;
  lift: number;
}

/**
 * Each hull of a boat whose hulls are spacing apart, metres, at east and
 * north heading clockwise from north, heeled heel radians: one, where the
 * boat is, for a monohull; for a boat of two hulls, each hull's centreline
 * half the spacing to either side, the lee one where it floats and the
 * windward one lifted by the spacing times the sine of the heel. Its wake,
 * foam and spray are each hull's, and a hull lifted clear makes none.
 */
export function eachHull(
  spacing: number,
  east: number,
  north: number,
  heading: number,
  heel: number,
  out: HullAt[],
): number {
  if (!(spacing > 0)) {
    const h = out[0] as HullAt;
    h.east = east;
    h.north = north;
    h.lift = 0;
    return 1;
  }
  // Starboard is east of north turned a quarter clockwise; heeled to
  // starboard (heel above 0), the port hull is to windward.
  const ce = Math.cos(heading);
  const sn = Math.sin(heading);
  const windward = heel > 0 ? -1 : 1;
  for (let k = 0; k < 2; k++) {
    const side = k === 0 ? 1 : -1;
    const h = out[k] as HullAt;
    h.east = east + side * (spacing / 2) * ce;
    h.north = north - side * (spacing / 2) * sn;
    h.lift = side === windward ? spacing * Math.abs(Math.sin(heel)) : 0;
  }
  return 2;
}

/** Room for a boat's hulls, made once. */
export function hullRoom(): HullAt[] {
  return [
    { east: 0, north: 0, lift: 0 },
    { east: 0, north: 0, lift: 0 },
  ];
}
