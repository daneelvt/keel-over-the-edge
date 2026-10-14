// SPDX-License-Identifier: AGPL-3.0-only

// The beginners' right-of-way overlay. A few times a second it looks at
// the boats within reach whose closest approach, by their present motions,
// comes within a couple of hull lengths soon, takes the nearest few, and
// asks the physics module's Articles, the same code that judges a bump on
// the server, which of the two must keep clear: over a boat the player
// must keep clear of, a ring with a bar ("Keep clear"); over one that must
// keep clear of the player, a diamond ("Right of way"); each labelled
// with the Article that says so. Its own tack goes beside the readout.
// Shapes and words, never colour alone. Other boats' tacks are followed
// from their drawn poses in the wind at them, as the server follows them
// from their states; the overlay is an instrument, and its marks are unlit.

import {
  BoxGeometry,
  type Camera,
  Group,
  Mesh,
  OctahedronGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import type { Boat as BoatKind, EncountersOverlay } from '../catalog';
import type { DrawnBoat } from '../game/fleet';
import { VIEW_SLOTS } from '../net/view';
import { RECORDS, SIZES } from '../predict/layout.gen';
import type { Physics } from '../predict/physics';
import { articleName, tackText } from '../ui/verdict';
import { basicMaterial } from './materials';

const E = RECORDS.encounter;
const V = RECORDS.verdict;
const C = RECORDS.course;
const W = RECORDS.wind;

/** A boat as the overlay sees it: where, heading, heeled, its boom, its sailor's mode, how it moves. */
export interface Seen {
  east: number;
  north: number;
  heading: number;
  heel: number;
  boom: number;
  mode: number;
  /** m/s east and north. */
  vEast: number;
  vNorth: number;
}

/** A boat that will come close: its index among those offered, and how close, m. */
export interface Approach {
  index: number;
  distance: number;
}

/**
 * The boats of others, up to marks of them, within range of own whose
 * closest approach within ahead seconds, by their present motions, comes
 * within close metres; the closest first.
 */
export function approaching(
  own: Seen,
  others: readonly Seen[],
  count: number,
  range: number,
  ahead: number,
  close: number,
  marks: number,
  out: Approach[],
): Approach[] {
  out.length = 0;
  for (let i = 0; i < count; i++) {
    const o = others[i] as Seen;
    const rx = o.east - own.east;
    const ry = o.north - own.north;
    if (rx * rx + ry * ry > range * range) {
      continue;
    }
    const vx = o.vEast - own.vEast;
    const vy = o.vNorth - own.vNorth;
    const v2 = vx * vx + vy * vy;
    const t = v2 > 0 ? Math.min(ahead, Math.max(0, -(rx * vx + ry * vy) / v2)) : 0;
    const d = Math.hypot(rx + vx * t, ry + vy * t);
    if (d < close) {
      out.push({ index: i, distance: d });
    }
  }
  out.sort((a, b) => a.distance - b.distance || a.index - b.index);
  if (out.length > marks) {
    out.length = marks;
  }
  return out;
}

/** A mark's verdict: the player keeps clear, or the other must. */
export type MarkKind = 'keep-clear' | 'right-of-way';

/** A mark over a boat: the drawn boat, its kind, and the Article. */
export interface MarkShown {
  slot: number;
  kind: MarkKind;
  article: string;
  label: string;
}

/** How high over a boat its mark floats, m. */
const MARK_HEIGHT = 7.6;

class Mark {
  readonly group = new Group();
  readonly ring: Group;
  readonly diamond: Mesh;
  readonly label: HTMLSpanElement | null;

  constructor(doc: Document | null) {
    const clear = basicMaterial({ color: 0xe9837a });
    clear.name = 'keep clear mark';
    const right = basicMaterial({ color: 0x8fd3f0 });
    right.name = 'right of way mark';
    this.ring = new Group();
    this.ring.add(new Mesh(new TorusGeometry(0.55, 0.09, 8, 28), clear));
    // The bar across the ring: no entry.
    this.ring.add(new Mesh(new BoxGeometry(0.85, 0.18, 0.06), clear));
    this.diamond = new Mesh(new OctahedronGeometry(0.6), right);
    this.diamond.scale.set(0.8, 1, 0.25);
    this.group.add(this.ring, this.diamond);
    this.group.visible = false;
    this.label = doc?.createElement('span') ?? null;
    if (this.label !== null) {
      this.label.className = 'overlay-label right-of-way-label';
      this.label.hidden = true;
    }
  }
}

export class RightOfWay {
  /** In the scene: the marks, placed each frame. */
  readonly group = new Group();
  on = false;
  /** The player's own tack, as the readout shows it ('' with the overlay off). */
  tack = '';
  /** The marks shown, for the tests. */
  readonly shown: MarkShown[] = [];

  readonly #cfg: EncountersOverlay;
  readonly #close: number;
  readonly #marks: Mark[];
  readonly #own = new Float64Array(SIZES.course);
  /** Each view slot's boat's course, and whether it was drawn at the last judgement. */
  readonly #courses = Array.from({ length: VIEW_SLOTS }, () => new Float64Array(SIZES.course));
  readonly #live = new Uint8Array(VIEW_SLOTS);
  readonly #was = new Uint8Array(VIEW_SLOTS);
  readonly #seen: Seen[] = [];
  readonly #approach: Approach[] = [];
  #next = 0;
  readonly #v = new Vector3();

  constructor(
    kind: BoatKind,
    cfg: EncountersOverlay,
    doc: Document | null = globalThis.document ?? null,
  ) {
    this.#cfg = cfg;
    this.#close = cfg.close * kind.lengthOverall;
    this.group.name = 'right of way';
    this.#marks = Array.from({ length: cfg.marks }, () => new Mark(doc));
    for (const m of this.#marks) {
      this.group.add(m.group);
    }
  }

  /** Puts the labels in a layer over the scene; null takes them out. */
  attachLabels(layer: HTMLElement | null): void {
    for (const m of this.#marks) {
      if (m.label === null) {
        continue;
      }
      if (layer === null) {
        m.label.remove();
      } else if (m.label.parentElement !== layer) {
        layer.append(m.label);
      }
    }
  }

  set(on: boolean): void {
    this.on = on;
    if (!on) {
      this.tack = '';
      this.shown.length = 0;
      for (const m of this.#marks) {
        m.group.visible = false;
        if (m.label !== null) {
          m.label.hidden = true;
        }
      }
    }
  }

  /**
   * Judges, at most rate times a second (now in ms), the player's boat own
   * against the drawn boats, in the wind at tick (the physics module's
   * draw time), and places the marks; then keeps them over their boats.
   * originX and originY are the world's point at the scene's origin.
   */
  update(
    physics: Physics | null,
    now: number,
    tick: number,
    own: Seen,
    drawn: readonly DrawnBoat[],
    count: number,
    originX: number,
    originY: number,
    camera: Camera,
  ): void {
    if (!this.on) {
      return;
    }
    if (physics !== null && now >= this.#next) {
      this.#next = now + 1000 / this.#cfg.rate;
      this.#judge(physics, tick, own, drawn, count);
    }
    for (let k = 0; k < this.#marks.length; k++) {
      const m = this.#marks[k] as Mark;
      const s = this.shown[k];
      let b: DrawnBoat | undefined;
      for (let i = 0; s !== undefined && i < count; i++) {
        if ((drawn[i] as DrawnBoat).slot === s.slot) {
          b = drawn[i];
          break;
        }
      }
      if (s === undefined || b === undefined) {
        m.group.visible = false;
        if (m.label !== null) {
          m.label.hidden = true;
        }
        continue;
      }
      m.group.visible = true;
      m.ring.visible = s.kind === 'keep-clear';
      m.diamond.visible = s.kind === 'right-of-way';
      m.group.position.set(b.east - originX, MARK_HEIGHT, -(b.north - originY));
      m.group.quaternion.copy(camera.quaternion);
      if (m.label !== null) {
        m.label.textContent = s.label;
        m.label.hidden = false;
      }
    }
  }

  /** Puts each shown mark's label under it, on a page of this size. */
  placeLabels(camera: Camera, width: number, height: number): void {
    for (const m of this.#marks) {
      if (m.label === null || m.label.hidden) {
        continue;
      }
      const v = this.#v.set(0, -0.9, 0);
      m.group.localToWorld(v);
      v.project(camera);
      const off = v.z > 1 || v.z < -1;
      m.label.style.display = off ? 'none' : '';
      m.label.style.transform = `translate(${((v.x + 1) / 2) * width}px, ${((1 - v.y) / 2) * height}px)`;
    }
  }

  #judge(
    physics: Physics,
    tick: number,
    own: Seen,
    drawn: readonly DrawnBoat[],
    count: number,
  ): void {
    physics.windDrawAt(tick);
    const ownFrom = physics.windPoint(own.east, own.north)[W.from] ?? 0;
    physics.courseOf(this.#own, own.heading, own.boom, ownFrom);
    this.tack = tackText(this.#own[C.tack] ?? 1, (this.#own[C.tacking] ?? 0) !== 0);

    // Every drawn boat's course is followed, so that one that tacked before
    // it came close is known to be tacking.
    const seen = this.#seen;
    while (seen.length < count) {
      seen.push(newSeen());
    }
    const live = this.#live;
    const was = this.#was;
    was.set(live);
    live.fill(0);
    for (let i = 0; i < count; i++) {
      const b = drawn[i] as DrawnBoat;
      const s = seen[i] as Seen;
      s.east = b.east;
      s.north = b.north;
      s.heading = b.heading;
      s.heel = b.heel;
      s.boom = b.boom;
      s.mode = b.mode;
      s.vEast = b.speed * Math.sin(b.heading);
      s.vNorth = b.speed * Math.cos(b.heading);
      if (b.slot < 0) {
        // Fading out of the view: its slot may be another's soon.
        s.vEast = s.vNorth = 0;
        continue;
      }
      live[b.slot] = 1;
      const c = this.#courses[b.slot] as Float64Array;
      if (was[b.slot] === 0) {
        // New to the view: its course starts afresh.
        c.fill(0);
      }
      const from = physics.windPoint(b.east, b.north)[W.from] ?? 0;
      physics.courseOf(c, b.heading, b.boom, from);
    }

    const cfg = this.#cfg;
    const near = approaching(
      own,
      seen,
      count,
      cfg.range,
      cfg.ahead,
      this.#close,
      cfg.marks,
      this.#approach,
    );
    this.shown.length = 0;
    const e = physics.records.encounter;
    for (const a of near) {
      const b = drawn[a.index] as DrawnBoat;
      if (b.slot < 0) {
        continue;
      }
      const c = this.#courses[b.slot] as Float64Array;
      put(e, 0, own, this.#own, ownFrom);
      put(e, 1, seen[a.index] as Seen, c, physics.windPoint(b.east, b.north)[W.from] ?? 0);
      // What the pair remembers is the server's: as far as the overlay
      // knows, right of way has not changed hands lately.
      e[E.since] = 1e9;
      e[E.by] = 0;
      const v = physics.articlesJudge();
      const keeper = v[V.keeper] ?? 0;
      if (keeper === 0) {
        continue;
      }
      const article = articleName(v[V.article] ?? 0);
      const kind: MarkKind = keeper === 1 ? 'keep-clear' : 'right-of-way';
      this.shown.push({
        slot: b.slot,
        kind,
        article,
        label: `${kind === 'keep-clear' ? 'Keep clear' : 'Right of way'} · Article ${article}`,
      });
    }
  }
}

function newSeen(): Seen {
  return { east: 0, north: 0, heading: 0, heel: 0, boom: 0, mode: 0, vEast: 0, vNorth: 0 };
}

/** Writes boat i of the encounter record. */
function put(e: Float64Array, i: number, s: Seen, c: Float64Array, windFrom: number): void {
  e[E.x + i] = s.east;
  e[E.y + i] = s.north;
  e[E.heading + i] = s.heading;
  e[E.heel + i] = s.heel;
  e[E.boom + i] = s.boom;
  e[E.sailorMode + i] = s.mode;
  e[E.windFrom + i] = windFrom;
  e[E.tack + i] = c[C.tack] ?? 0;
  e[E.tacking + i] = c[C.tacking] ?? 0;
  e[E.settled + i] = c[C.settled] ?? 0;
  e[E.course + i] = c[C.course] ?? 0;
}
