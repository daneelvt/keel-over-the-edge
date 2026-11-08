// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox's encounters with the sea's life, by hand: ?life=<kind id>
// puts one group of that kind by the boat as the page loads, so a picture
// of it can be taken however still the boat lies. A free group's middle
// comes to a point 200 m ahead of the boat 40 s after the load: one that
// passes crosses there, square to the boat's heading; one that soars or
// works has come in by then and stays over it for the most its kind
// stays. A kind that follows boats or rides their bows is with the own
// boat (with: 1), in by 40 s and staying its kind's most. A kind that
// brings others brings each of them; a ground of flying fish is kept
// apart, on the boat, and flushes fish ahead of it as it sails. The tests
// raise one again at now with keel.raiseLife, its middle there at once.

import type { Life } from '../catalog/types.gen';
import type { LifeFrame } from '../life/draw';
import { arrive, hash32, lingers, type Pose } from '../life/flock';
import { flush, flushSlot, inGround, patchOf } from '../life/flush';
import type { LifeStore } from '../life/store';
import type { LifeSeen } from '../net/messages';

/** Ticks a second of world time. */
const STEPS = 30;
/** How far ahead of the boat a free group's middle comes, m, and how long after the load, s. */
export const AHEAD = 200;
export const DELAY = 40;

/** The kind ?life names, by its index in the catalog's life; −1 for none. */
export function lifeKindFromQuery(query: URLSearchParams, life: Life): number {
  const id = query.get('life');
  return id === null ? -1 : life.kinds.findIndex((k) => k.id === id);
}

/** The boat a scene's group is placed by: m east and north, and its heading, radians clockwise from north. */
export interface SceneBoat {
  east: number;
  north: number;
  heading: number;
}

/**
 * A group of kind by the boat at tick now, its middle at the point east
 * and north of the boat (200 m ahead by default) delay s after now; the
 * n-th raised, which makes its id and seed its own.
 */
export function lifeScene(
  life: Life,
  kind: number,
  now: number,
  boat: SceneBoat,
  n: number,
  delay = DELAY,
  offset?: { east: number; north: number },
): LifeSeen | null {
  const k = life.kinds[kind];
  if (k === undefined) {
    return null;
  }
  const speed = ((k.speed[0] ?? 10) + (k.speed[1] ?? 10)) / 2;
  const a = arrive(k, speed);
  const stay = k.stay[1] ?? 0;
  const lo = k.group[0] ?? 1;
  const hi = k.group[1] ?? lo;
  const at = now + delay * STEPS;
  const bound = k.binds === 'follow' || k.binds === 'ride';
  const east = boat.east + (offset?.east ?? Math.sin(boat.heading) * AHEAD);
  const north = boat.north + (offset?.north ?? Math.cos(boat.heading) * AHEAD);
  // Each is at its point a, its coming in, after it begins: one that
  // passes crosses square to the boat's heading and goes on as far; one
  // that follows or rides comes up from astern along it, and one that
  // stays comes in so, and each stays its kind's most before going on;
  // one that drifts begins there and drifts its stay.
  const drifts = k.path === 'drift';
  const stays = bound || lingers(k);
  const start = drifts ? Math.floor(at) : Math.floor(at - a * STEPS);
  const span = drifts ? stay : stays ? 2 * a + stay : 2 * a;
  return {
    id: `sandbox-${n}`,
    rev: 0,
    kind,
    start,
    end: start + Math.ceil(span * STEPS),
    east,
    north,
    heading: stays || drifts ? boat.heading : boat.heading + Math.PI / 2,
    speed,
    count: Math.max(lo, Math.ceil((lo + hi) / 2)),
    seed: hash32((kind + 1) * 7919 + n),
    with: bound ? 1 : 0,
    over: '',
  };
}

/**
 * The groups that come with a scene's group, on its patch, from its start
 * to its end: every one its kind brings, each of the middle of its count.
 */
export function broughtWith(life: Life, e: LifeSeen): LifeSeen[] {
  const k = life.kinds[e.kind];
  const out: LifeSeen[] = [];
  (k?.brings ?? []).forEach((b, j) => {
    const kind = life.kinds.findIndex((o) => o.id === b.kind);
    const o = life.kinds[kind];
    if (o === undefined) {
      return;
    }
    out.push({
      ...e,
      id: `${e.id}-${j + 1}`,
      kind,
      heading: e.heading + (j + 1) * 1.3,
      speed: ((o.speed[0] ?? 10) + (o.speed[1] ?? 10)) / 2,
      count: Math.ceil(((b.count[0] ?? 1) + (b.count[1] ?? 1)) / 2),
      seed: hash32((e.seed ^ hash32(j + 1)) >>> 0),
      with: 0,
      over: e.id,
    });
  });
  return out;
}

/**
 * A scene's grounds of flying fish, which the server would keep: each
 * flushes fish ahead of the page's own boat as it sails through, by the
 * server's own draw (flush.ts), as if the boat's id were the scene's.
 */
export class SceneFlushes {
  readonly #grounds: LifeSeen[] = [];
  readonly #life: Life;
  #slot = Number.NaN;

  constructor(life: Life) {
    this.#life = life;
  }

  /** Keeps a ground, its middle on the boat. */
  add(ground: LifeSeen, boat: SceneBoat): void {
    this.#grounds.push({ ...ground, east: boat.east, north: boat.north, with: 0 });
  }

  /** Whether it keeps any ground. */
  get size(): number {
    return this.#grounds.length;
  }

  /**
   * At each flushes' slot, the fish the boat at bow, sailing at speed m/s,
   * flushes from each ground it is in at tick now: into the store.
   */
  step(store: LifeStore, bow: Pose, speed: number, now: number): void {
    const slot = flushSlot(this.#life, now);
    if (slot === this.#slot) {
      return;
    }
    this.#slot = slot;
    if (speed < this.#life.bind.speed) {
      return;
    }
    const out: LifeSeen[] = [];
    this.#grounds.forEach((g, n) => {
      const k = this.#life.kinds[g.kind];
      if (
        k === undefined ||
        now < g.start ||
        now >= g.end ||
        !inGround(g, patchOf(k, g.seed), bow.east, bow.north)
      ) {
        return;
      }
      const f = flush(this.#life, k, g, SCENE_BOAT, slot, bow, now);
      if (f !== null) {
        out.push({ ...f, id: `${g.id}-flush-${n}-${slot}` });
      }
    });
    if (out.length > 0) {
      store.set(out, []);
    }
  }
}

/** The boat's id a scene's flushes are drawn by. */
const SCENE_BOAT = 1;

/** What a scene's groups are put into: the page's life, and its hook for each frame's life. */
export interface SceneWorld {
  life: LifeStore;
  pose: SceneBoat;
  onLife: ((f: LifeFrame) => void) | null;
}

/**
 * Puts a scene's group in the world: with the groups it brings, or, a
 * ground of flying fish, kept apart to flush fish ahead of the own boat
 * each frame.
 */
export function raiseScene(world: SceneWorld, e: LifeSeen, life: Life): void {
  const k = life.kinds[e.kind];
  if (k?.binds === 'flush') {
    let flushes = scenes.get(world);
    if (flushes === undefined) {
      const made = new SceneFlushes(life);
      flushes = made;
      scenes.set(world, made);
      const before = world.onLife;
      world.onLife = (f) => {
        before?.(f);
        const own = f.own;
        if (own !== null) {
          const bow = f.bowOf(f.ownKind);
          made.step(
            world.life,
            {
              east: own.east + Math.sin(own.heading) * bow,
              north: own.north + Math.cos(own.heading) * bow,
              heading: own.heading,
            },
            own.speed ?? 0,
            f.ticks,
          );
        }
      };
    }
    flushes.add(e, world.pose);
    return;
  }
  world.life.set([e, ...broughtWith(life, e)], []);
}

const scenes = new WeakMap<SceneWorld, SceneFlushes>();
