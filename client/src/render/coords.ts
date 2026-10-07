// SPDX-License-Identifier: AGPL-3.0-only

// World and scene coordinates, and the floating origin.
//
// The world, as the physics package has it: x east, y north, metres from the
// disk's centre, held in float64 on the CPU. The scene, as three.js has it:
// right-handed with y up, so x east, y up and z south; north is -z. A heading
// (clockwise from north, in radians) is a rotation of -heading about y.
//
// The GPU works in float32, which near the rim (8,334 m out) resolves only
// about a millimetre. So the scene is drawn relative to a floating origin
// near the boat: everything is placed each frame at (world - origin) in
// float64, and only then handed to three.js. The origin is always a tile
// centre, so tile offsets from it are exact and the tiles never jump when it
// moves.

import { type Hex, hexAt, hexCentre, type Point } from '../ocean/hex';

/** Radius of the disk, in metres: 4.5 nautical miles. */
export const DISK_RADIUS = 8334;

/** The origin moves when the boat is further than this from it, in metres. */
export const ORIGIN_SHIFT = 500;

export interface ScenePoint {
  x: number;
  y: number;
  z: number;
}

/** World (east, north, height) to scene (x, y, z), both in metres. */
export function worldToScene(east: number, north: number, up: number, out: ScenePoint): ScenePoint {
  out.x = east;
  out.y = up;
  out.z = -north;
  return out;
}

/** Scene (x, y, z) to world (east, north); the height is the scene's y. */
export function sceneToWorld(x: number, z: number, out: Point): Point {
  out.x = x;
  out.y = -z;
  return out;
}

/** The scene's rotation about y for a heading, clockwise from north, in radians. */
export function headingToRotationY(heading: number): number {
  return -heading;
}

/** The heading, clockwise from north, of a scene rotation about y. */
export function rotationYToHeading(rotationY: number): number {
  return -rotationY;
}

/**
 * The floating origin: a tile centre near the boat, in world metres. It
 * also tracks the tile under the boat, the centre of the tile field.
 */
export class FloatingOrigin {
  /** World position of the origin: always a tile centre. */
  readonly world: Point = { x: 0, y: 0 };
  /** The tile the origin is on. */
  readonly hex: Hex = { q: 0, r: 0 };
  /** The tile under the boat: the tile field is centred on it. */
  readonly centre: Hex = { q: 0, r: 0 };
  /** Increases whenever the origin moves, so dependants can catch up. */
  epoch = 0;

  readonly #hex: Hex = { q: 0, r: 0 };

  /**
   * Follows the boat at world (x, y). Moves the origin to the tile centre
   * under the boat when the boat is more than ORIGIN_SHIFT away, and returns
   * whether it moved.
   */
  follow(x: number, y: number): boolean {
    hexAt(x, y, this.#hex);
    this.centre.q = this.#hex.q;
    this.centre.r = this.#hex.r;
    const dx = x - this.world.x;
    const dy = y - this.world.y;
    if (dx * dx + dy * dy <= ORIGIN_SHIFT * ORIGIN_SHIFT && this.epoch > 0) {
      return false;
    }
    this.moveTo(this.#hex);
    return true;
  }

  /** Puts the origin on the centre of tile h. */
  moveTo(h: Hex): void {
    this.hex.q = h.q;
    this.hex.r = h.r;
    hexCentre(h.q, h.r, this.world);
    this.epoch++;
  }

  /** Writes the scene position of the world point (east, north, up) into out. */
  toScene(east: number, north: number, up: number, out: ScenePoint): ScenePoint {
    return worldToScene(east - this.world.x, north - this.world.y, up, out);
  }
}
