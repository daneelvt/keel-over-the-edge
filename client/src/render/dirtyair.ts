// SPDX-License-Identifier: AGPL-3.0-only

// Dirty air on the water, drawn with the wind overlay: a faint wedge
// downwind of each boat near, along the wake its sail leaves as the physics
// module lays it (along its apparent wind, turned toward its windward side,
// as long as its rig is tall), out to where the wind it takes falls under a
// share. Racers learn where dirty air lies; on real water it cannot be
// seen. The wedge's outline is the shadow's own formula, in the source's
// rig heights; each frame only places it.

import { BufferAttribute, BufferGeometry, DoubleSide, Group, Mesh } from 'three';
import type { DrawnBoat } from '../game/fleet';
import { RECORDS } from '../predict/layout.gen';
import type { Physics } from '../predict/physics';
import { basicMaterial } from './materials';
import type { Seen } from './rightofway';

const K = RECORDS.wake;
const W = RECORDS.wind;

/** The shadow's numbers, as the catalog gives them. */
export interface ShadowNumbers {
  deficit: number;
  near: number;
  width: number;
  reach: number;
  taper: number;
}

/** Stations along the wedge. */
const STATIONS = 32;

/**
 * The wedge's half-width at each station along the wake, in rig heights,
 * out to where the loss of wind falls under least: the shadow's loss,
 * A s̄^(−2/3) e^(−c² s̄^(−2/3) / w²), faded in over its first stretch and
 * out toward its reach, solved for c.
 */
export function wedgeOutline(n: ShadowNumbers, least: number): { s: number[]; c: number[] } {
  const smooth = (t: number): number => {
    const x = Math.min(1, Math.max(0, t));
    return x * x * (3 - 2 * x);
  };
  const s: number[] = [];
  const c: number[] = [];
  for (let i = 0; i <= STATIONS; i++) {
    const at = (n.reach * i) / STATIONS;
    const g = Math.max(at, n.near) ** (-2 / 3);
    const peak =
      n.deficit * g * smooth(at / n.near) * (1 - smooth((at - n.taper) / (n.reach - n.taper)));
    s.push(at);
    c.push(peak > least ? n.width * Math.sqrt(Math.log(peak / least) / g) : 0);
  }
  return { s, c };
}

/** The wedge as a flat mesh in its own frame: x across, −z along the wake, in rig heights. */
function wedgeGeometry(o: { s: number[]; c: number[] }): BufferGeometry {
  const pos = new Float32Array(o.s.length * 2 * 3);
  for (let i = 0; i < o.s.length; i++) {
    const s = o.s[i] ?? 0;
    const c = o.c[i] ?? 0;
    pos.set([-c, 0, -s, c, 0, -s], i * 6);
  }
  const index: number[] = [];
  for (let i = 0; i + 1 < o.s.length; i++) {
    const a = 2 * i;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setIndex(index);
  return g;
}

/** The most wedges drawn at once. */
const WEDGES = 12;
/** How high over the sea a wedge lies, m. */
const LIFT = 0.12;

export class DirtyAir {
  readonly group = new Group();
  on = false;
  /** How many wedges are drawn (the tests). */
  drawn = 0;
  /** The first drawn wedges' axes as last placed, east and north of each, and its boat's view slot, −1 the player's (the tests). */
  readonly axes = Array.from({ length: WEDGES }, () => ({ east: 0, north: 0, source: 0 }));

  readonly #range: number;
  readonly #meshes: Mesh[];

  constructor(n: ShadowNumbers, least: number, range: number) {
    this.#range = range;
    this.group.name = 'dirty air';
    const geometry = wedgeGeometry(wedgeOutline(n, least));
    const m = basicMaterial({
      color: 0x0b2638,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      side: DoubleSide,
    });
    m.name = 'dirty air';
    this.#meshes = Array.from({ length: WEDGES }, () => {
      const mesh = new Mesh(geometry, m);
      mesh.visible = false;
      mesh.renderOrder = 1;
      this.group.add(mesh);
      return mesh;
    });
  }

  set(on: boolean): void {
    this.on = on;
    if (!on) {
      for (const m of this.#meshes) {
        m.visible = false;
      }
      this.drawn = 0;
    }
  }

  /**
   * Places a wedge behind the player's boat own and each drawn boat within
   * range of it, in the wind at tick (the module's draw time); originX and
   * originY are the world's point at the scene's origin.
   */
  update(
    physics: Physics | null,
    tick: number,
    own: Seen,
    drawn: readonly DrawnBoat[],
    count: number,
    originX: number,
    originY: number,
  ): void {
    if (!this.on) {
      return;
    }
    let n = 0;
    if (physics !== null) {
      physics.windDrawAt(tick);
      n = this.#place(physics, n, -1, own, originX, originY);
      for (let i = 0; i < count && n < WEDGES; i++) {
        const b = drawn[i] as DrawnBoat;
        if (b.opacity < 0.5 || Math.hypot(b.east - own.east, b.north - own.north) > this.#range) {
          continue;
        }
        this.#boat.east = b.east;
        this.#boat.north = b.north;
        this.#boat.heading = b.heading;
        this.#boat.heel = b.heel;
        this.#boat.boom = b.boom;
        this.#boat.vEast = b.speed * Math.sin(b.heading);
        this.#boat.vNorth = b.speed * Math.cos(b.heading);
        n = this.#place(physics, n, b.slot, this.#boat, originX, originY);
      }
    }
    for (let k = n; k < WEDGES; k++) {
      (this.#meshes[k] as Mesh).visible = false;
    }
    this.drawn = n;
  }

  readonly #boat: Seen = {
    east: 0,
    north: 0,
    heading: 0,
    heel: 0,
    boom: 0,
    mode: 0,
    vEast: 0,
    vNorth: 0,
  };

  #place(
    physics: Physics,
    n: number,
    source: number,
    b: Seen,
    originX: number,
    originY: number,
  ): number {
    const wind = physics.windPoint(b.east, b.north);
    const speed = wind[W.speed] ?? 0;
    const from = wind[W.from] ?? 0;
    const w = physics.wakeOf(
      b.east,
      b.north,
      b.heading,
      b.heel,
      b.boom,
      b.vEast,
      b.vNorth,
      speed,
      from,
    );
    const h = w[K.height] ?? 0;
    if (!(h > 0)) {
      return n;
    }
    const east = w[K.east] ?? 0;
    const north = w[K.north] ?? 0;
    const m = this.#meshes[n] as Mesh;
    m.visible = true;
    m.position.set((w[K.x] ?? 0) - originX, LIFT, -((w[K.y] ?? 0) - originY));
    // The wedge's −z along the wake's axis: a heading turns −z clockwise from north.
    m.rotation.set(0, -Math.atan2(east, north), 0);
    m.scale.set(h, 1, h);
    const a = this.axes[n] as { east: number; north: number; source: number };
    a.east = east;
    a.north = north;
    a.source = source;
    return n + 1;
  }
}
