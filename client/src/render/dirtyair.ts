// SPDX-License-Identifier: AGPL-3.0-only

// Dirty air on the water, drawn with the wind overlay: a wedge of streaks
// downwind of each boat near, along the wake its sail leaves as the physics
// module lays it (along its apparent wind, turned toward its windward side,
// as long as its rig is tall), out to where the wind it takes falls under a
// share. Racers learn where dirty air lies; on real water it cannot be
// seen. The wedge's outline is the shadow's own formula, in the source's
// rig heights; each frame only places it.
//
// It is drawn as the wind's arrows are, pale and unlit, in broken, wavering
// streaks along the wake, and the player's own carries a label: a dark,
// even patch on the water was taken for the boat's shadow under the moon.

import {
  BufferAttribute,
  BufferGeometry,
  type Camera,
  DoubleSide,
  Group,
  Mesh,
  Vector3,
} from 'three';
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

/** The outline's half-width at s rig heights along the wake, between its stations. */
function halfWidth(o: { s: number[]; c: number[] }, s: number): number {
  const last = o.s.length - 1;
  const at = Math.min(Math.max((s / (o.s[last] ?? 1)) * last, 0), last);
  const i = Math.min(Math.floor(at), last - 1);
  const t = at - i;
  return (o.c[i] ?? 0) * (1 - t) + (o.c[i + 1] ?? 0) * t;
}

/**
 * The streaks: how many lie side by side across the wedge, each one's
 * width, how long a streak and the gap after it are, how far a streak
 * wavers to either side and over what length, all in rig heights, and the
 * steps a streak is drawn in.
 */
export const STREAKS = {
  across: 7,
  width: 0.022,
  dash: 0.62,
  gap: 0.3,
  waver: 0.035,
  wave: 0.9,
  steps: 8,
};

/**
 * The wedge as streaks, flat in its own frame: x across, −z along the
 * wake, in rig heights. Each lies at its own share of the outline's width,
 * so together they keep its shape; neighbours start at different places
 * and waver apart, as disturbed air does; each tapers to a point at both
 * ends.
 */
export function streaksGeometry(o: { s: number[]; c: number[] }): BufferGeometry {
  const k = STREAKS;
  const reach = o.s[o.s.length - 1] ?? 0;
  const pos: number[] = [];
  const index: number[] = [];
  for (let line = 0; line < k.across; line++) {
    const share = k.across === 1 ? 0 : (2 * line) / (k.across - 1) - 1;
    // Neighbours a golden share of a period apart, along and in their wavering.
    const phase = (line * 0.618) % 1;
    const x = (s: number): number =>
      share * halfWidth(o, s) + k.waver * Math.sin(2 * Math.PI * (s / k.wave + phase));
    const period = k.dash + k.gap;
    for (let from = -phase * period; from < reach; from += period) {
      const a = Math.max(from, 0);
      const b = Math.min(from + k.dash, reach);
      // Only where the wedge is wide enough to be one: not at its tip or its tail.
      if (b - a < 0.5 * k.dash || halfWidth(o, 0.5 * (a + b)) <= 0) {
        continue;
      }
      const first = pos.length / 3;
      for (let i = 0; i <= k.steps; i++) {
        const t = i / k.steps;
        const s = a + (b - a) * t;
        const half = 0.5 * k.width * Math.sin(Math.PI * t);
        pos.push(x(s) - half, 0, -s, x(s) + half, 0, -s);
      }
      for (let i = 0; i < k.steps; i++) {
        const v = first + 2 * i;
        index.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(index);
  return g;
}

/** The label's place along the player's own wedge, in rig heights. */
const LABEL_AT = 0.9;

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
    const geometry = streaksGeometry(wedgeOutline(n, least));
    const m = basicMaterial({
      // The true wind's arrow's white: the wind's, not a shadow's.
      color: 0xf2f4f5,
      transparent: true,
      opacity: 0.4,
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
      this.#own = null;
      if (this.#label !== null) {
        this.#label.hidden = true;
      }
    }
  }

  /** The player's own wedge as last placed, or null while it has none. */
  #own: Mesh | null = null;
  #label: HTMLElement | null = null;
  readonly #v = new Vector3();

  /** Puts the label in a layer of the page over the scene; null takes it out. */
  attachLabels(layer: HTMLElement | null): void {
    if (this.#label === null) {
      const el = document.createElement('span');
      el.className = 'overlay-label dirty-air-label';
      el.textContent = 'Disturbed wind';
      el.hidden = true;
      this.#label = el;
    }
    if (layer === null) {
      this.#label.remove();
    } else if (this.#label.parentElement !== layer) {
      layer.append(this.#label);
    }
  }

  /** Puts the label over the player's own wedge, a little way down it, on a page of this size. */
  placeLabels(camera: Camera, width: number, height: number): void {
    const el = this.#label;
    if (el === null) {
      return;
    }
    const m = this.group.visible ? this.#own : null;
    el.hidden = m === null;
    if (m === null) {
      return;
    }
    m.updateMatrixWorld();
    const v = m.localToWorld(this.#v.set(0, 0, -LABEL_AT)).project(camera);
    const off = v.z > 1 || v.z < -1;
    el.style.display = off ? 'none' : '';
    el.style.transform = `translate(${((v.x + 1) / 2) * width}px, ${((1 - v.y) / 2) * height}px)`;
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
    this.#own = null;
    if (physics !== null) {
      physics.windDrawAt(tick);
      n = this.#place(physics, n, -1, own, originX, originY);
      this.#own = n > 0 ? (this.#meshes[0] as Mesh) : null;
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
        this.#boat.kind = b.kind;
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
      b.kind ?? 0,
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
