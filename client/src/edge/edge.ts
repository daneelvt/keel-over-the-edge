// SPDX-License-Identifier: AGPL-3.0-only

// The edge of the world as the scene draws it: the mist band (mist.ts), the
// sea at the lip (lip.ts), the falls (falls.ts) and the drain's foam lines
// (lines.ts), set up from the catalog and kept in step with the floating
// origin, the camera, the hour and world time each frame.

import type { Scene, Vector3, Vector4 } from 'three';
import type { BandUniforms } from '../ocean/wave';
import type { FloatingOrigin } from '../render/coords';
import { look } from '../render/sky';
import { Falls, type FallsLook } from './falls';
import { type Drain, LINES_PERIOD, linesLook } from './lines';
import { edgeLook, KOSCHMIEDER, type MistParams } from './mist';

/** One nautical mile, m; one knot, m/s. */
const NM = 1852;
const KNOT = NM / 3600;

/** The catalog's numbers the edge is drawn by. */
export interface EdgeCatalog {
  /** The lip, m from the centre, and where the mist band begins, nautical miles. */
  radius: number;
  mist: number;
  /** world.edge: the mist's range at the lip and scale height, and the look. */
  edge: {
    mist: { range: number; height: number };
    look: FallsLook & { lip: { tip: number; sag: number }; lines: { apart: number; from: number } };
  };
  /** weather.current's drain: its points, nautical miles, and its speeds there, knots. */
  drainAt: number[];
  drain: number[];
}

export class EdgeScene {
  readonly falls: Falls;
  readonly mist: MistParams;
  readonly drain: Drain;
  /** The lip and where the band begins, m from the centre. */
  readonly lip: number;
  readonly band: number;
  /** The lines' start speed, m/s. */
  readonly linesFrom: number;
  readonly #range: number;

  constructor(scene: Scene, band: BandUniforms, c: EdgeCatalog) {
    this.lip = c.radius;
    this.band = c.mist * NM;
    this.#range = c.edge.mist.range;
    edgeLook.lip.value = this.lip;
    edgeLook.band.value = this.band;
    edgeLook.height.value = c.edge.mist.height;
    edgeLook.tip.value = c.edge.look.lip.tip;
    edgeLook.sag.value = c.edge.look.lip.sag;
    this.mist = {
      band: this.band,
      lip: this.lip,
      sigma: this.#sigma(6000),
      height: c.edge.mist.height,
    };
    const at = c.drainAt.map((x) => x * NM) as [number, number, number];
    const speed = c.drain.map((x) => x * KNOT) as [number, number, number];
    this.drain = { at, speed };
    this.linesFrom = c.edge.look.lines.from * KNOT;
    (linesLook.at.value as Vector3).set(at[0], at[1], at[2]);
    (linesLook.speed.value as Vector4).set(speed[0], speed[1], speed[2], this.linesFrom);
    linesLook.apart.value = c.edge.look.lines.apart;
    this.falls = new Falls(band, this.lip, speed[2], c.edge.look);
    scene.add(this.falls.curtain, this.falls.slabs);
  }

  /** The mist's own extinction at the lip, over air of the clear visual range given. */
  #sigma(clear: number): number {
    return Math.max(KOSCHMIEDER / this.#range - KOSCHMIEDER / clear, 0);
  }

  /** Whether the mist, the lip and the falls are drawn (?edge=off turns them off). */
  get on(): boolean {
    return edgeLook.on.value > 0.5;
  }

  set on(on: boolean) {
    edgeLook.on.value = on ? 1 : 0;
  }

  /**
   * Brings the edge to the frame: the floating origin, the camera at
   * (east, north) in the world, world time in seconds, and the hour's
   * clear air.
   */
  frame(origin: FloatingOrigin, east: number, north: number, time: number): void {
    edgeLook.origin.value.set(origin.world.x, origin.world.y);
    const sigma = this.#sigma(look.visualRange.value as number);
    edgeLook.sigma.value = sigma;
    this.mist.sigma = sigma;
    linesLook.time.value = time - LINES_PERIOD * Math.floor(time / LINES_PERIOD);
    this.falls.frame(time, east, north, this.lip - Math.hypot(east, north));
  }
}
