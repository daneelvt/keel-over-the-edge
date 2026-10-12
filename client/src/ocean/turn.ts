// SPDX-License-Identifier: AGPL-3.0-only

// A pattern laid over the world and turned to the wind: the low tier's loop
// of the detail band, the streaks of foam. A point's place in the pattern is
// its world position, taken down the wind and across it. When the wind
// turns, the pattern must turn, and if it turned about the world's centre
// the water a boat sits in would sweep sideways under it, by more the
// further out it sails. So the pattern turns about a pivot, and each time
// the wind turns the pivot is first moved to the boat: the water there stays
// where it is, and the rest turns about it.
//
// The shader is given the floating origin's place in the pattern, taken in
// float64 here and wrapped, and adds the offset from the origin itself.

/** x modulo 1, in [0, 1). */
export function fract1(x: number): number {
  return x - Math.floor(x);
}

export class Turned {
  /** The direction the pattern is turned to: the way the waves travel, east and north. */
  east = 1;
  north = 0;
  /** The floating origin's place in the pattern, each coordinate in [0, 1). */
  u = 0;
  v = 0;

  readonly #along: number;
  readonly #across: number;
  /** The pivot in the world, and its place in the pattern. */
  #pivotEast = 0;
  #pivotNorth = 0;
  #pivotU = 0;
  #pivotV = 0;
  #placed = false;

  /** The pattern's coordinates advance by `along` a metre down the wind and `across` a metre across it. */
  constructor(along: number, across: number) {
    this.#along = along;
    this.#across = across;
  }

  /** A world offset, in the pattern's coordinates as it is turned now. */
  #place(east: number, north: number): [number, number] {
    return [
      (east * this.east + north * this.north) * this.#along,
      (-east * this.north + north * this.east) * this.#across,
    ];
  }

  /**
   * Turns the pattern to (toward east, toward north), about the boat if
   * that is a new direction, and places the floating origin in it.
   */
  update(
    towardEast: number,
    towardNorth: number,
    originEast: number,
    originNorth: number,
    boatEast: number,
    boatNorth: number,
  ): void {
    if (!this.#placed) {
      // The first direction is the one the pattern is laid in, about the world's centre.
      this.#placed = true;
      this.east = towardEast;
      this.north = towardNorth;
    } else if (towardEast !== this.east || towardNorth !== this.north) {
      const [du, dv] = this.#place(boatEast - this.#pivotEast, boatNorth - this.#pivotNorth);
      this.#pivotU = fract1(this.#pivotU + du);
      this.#pivotV = fract1(this.#pivotV + dv);
      this.#pivotEast = boatEast;
      this.#pivotNorth = boatNorth;
      this.east = towardEast;
      this.north = towardNorth;
    }
    const [du, dv] = this.#place(originEast - this.#pivotEast, originNorth - this.#pivotNorth);
    this.u = fract1(this.#pivotU + du);
    this.v = fract1(this.#pivotV + dv);
  }

  /** Where a world point is in the pattern, wrapped: what the shader computes, in float64. */
  at(east: number, north: number, originEast: number, originNorth: number): [number, number] {
    const [du, dv] = this.#place(east - originEast, north - originNorth);
    return [fract1(this.u + du), fract1(this.v + dv)];
  }
}
