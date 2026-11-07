// SPDX-License-Identifier: AGPL-3.0-only

// The sea's life drawn each frame: each group the page holds, about the
// boat it is with where it is with one, each of its birds within its
// kind's reach of the camera, shrinking to nothing over the last of it so
// none appears or vanishes in sight; and the gulls over the towns near, by
// day. Every bird goes to the scene's one draw of birds.

import type { BirdLook, BuildingKind, Life, LifeKind } from '../catalog/types.gen';
import type { LifeSeen } from '../net/messages';
import { type BirdPlace, type BoatAt, birdAt, birdPhase, drawnCount, newBirdPlace } from './birds';
import { type FlockPlace, flockAt } from './flock';
import {
  type GullBuilding,
  type GullPlace,
  type GullTown,
  gullAt,
  gullCount,
  gullTowns,
} from './gulls';
import type { LifeStore } from './store';

/** Ticks a second of world time. */
const STEPS = 30;
/** A bird shrinks to nothing over this last share of its kind's reach. */
const FADE = 0.15;
/** The towns' gulls are drawn within this of the camera, m. */
const GULL_REACH = 1000;
/** A group is looked at bird by bird where its middle is within its kind's reach and this, m: no bird strays further from it. */
const STRAY = 300;

/** Where a bird is drawn to: the scene's birds, or the tests'. */
export interface BirdSink {
  add(
    look: BirdLook,
    east: number,
    north: number,
    up: number,
    heading: number,
    phase: number,
    size: number,
    pitch: number,
    bank: number,
    held: boolean,
  ): boolean;
}

/** A boat as the life drawn reads it: its view slot, place, heading and speed. */
export interface LifeBoat {
  slot: number;
  east: number;
  north: number;
  heading: number;
  speed: number;
  opacity: number;
}

/** What a frame of the life needs. */
export interface LifeFrame {
  /** World time, ticks. */
  ticks: number;
  cameraEast: number;
  cameraNorth: number;
  cameraUp: number;
  /** The sea's significant height, m. */
  seaHeight: number;
  /** Whether the tier is low: half of each group is drawn. */
  low: boolean;
  /** Whether it is night: the towns' gulls are settled. */
  night: boolean;
  /** The page's own boat, or the boat it watches, as drawn; null for none. */
  own: BoatAt | null;
  /** The other boats drawn, [0, count). */
  fleet: readonly LifeBoat[];
  count: number;
}

/** A bird drawn, as the tests compare them. */
export interface LifeBird {
  id: string;
  k: number;
  east: number;
  north: number;
  up: number;
}

/** What the tests and the panel read. */
export interface LifeStats {
  records: number;
  /** The birds of the sea's life drawn, and the towns' gulls. */
  birds: number;
  gulls: number;
}

/** The towns' buildings, as the gulls' wheels are found from them; and their version. */
export interface GullSource {
  version: number;
  buildings(): Iterable<GullBuilding & { level?: number }>;
}

export class LifeDraw {
  readonly stats: LifeStats = { records: 0, birds: 0, gulls: 0 };
  readonly #life: Life;
  readonly #kinds: readonly BuildingKind[];
  readonly #gullKind: LifeKind | undefined;
  readonly #place = newBirdPlace();
  readonly #mid: FlockPlace = { east: 0, north: 0, up: 0 };
  readonly #gull: GullPlace = { east: 0, north: 0, up: 0, heading: 0 };
  readonly #pose: BoatAt = { east: 0, north: 0, heading: 0, speed: 0 };
  #towns: GullTown[] = [];
  #townsVersion = Number.NaN;

  /** The towns' gulls' wheels, as last found from the towns held. */
  get towns(): readonly GullTown[] {
    return this.#towns;
  }

  constructor(life: Life, buildings: readonly BuildingKind[]) {
    this.#life = life;
    this.#kinds = buildings;
    this.#gullKind = life.kinds.find((k) => k.id === life.towns.kind);
  }

  /** The boat a record's group is with in a frame: none for a free group, null for one whose boat is not drawn. */
  pose(e: LifeSeen, f: LifeFrame): BoatAt | null | undefined {
    if (e.with === 0) {
      return undefined;
    }
    if (e.with === 1) {
      return f.own;
    }
    const slot = e.with - 2;
    for (let i = 0; i < f.count; i++) {
      const b = f.fleet[i];
      if (b !== undefined && b.slot === slot && b.opacity > 0) {
        const p = this.#pose;
        p.east = b.east;
        p.north = b.north;
        p.heading = b.heading;
        p.speed = b.speed;
        return p;
      }
    }
    return null;
  }

  /** Every bird of the life held, and the towns' gulls, drawn for a frame. */
  frame(store: LifeStore, f: LifeFrame, sink: BirdSink, towns: GullSource | null): void {
    store.expire(f.ticks);
    let birds = 0;
    this.each(store, f, f.ticks, (e, k, i, place) => {
      const look = k.look as BirdLook;
      const d = Math.hypot(
        place.east - f.cameraEast,
        place.north - f.cameraNorth,
        place.up - f.cameraUp,
      );
      const size = Math.min((k.reach - d) / (FADE * k.reach), 1);
      if (size <= 0) {
        return;
      }
      if (
        sink.add(
          look,
          place.east,
          place.north,
          place.up,
          place.heading,
          birdPhase(e.seed, i),
          size,
          place.pitch,
          place.bank,
          place.folded,
        )
      ) {
        birds++;
      }
    });
    this.stats.records = store.size;
    this.stats.birds = birds;
    this.stats.gulls = this.#gulls(f, sink, towns);
  }

  /**
   * Calls back with each bird of the life held drawn at tick t within its
   * kind's reach and its group's place out of the water: the frame's and
   * the tests' alike.
   */
  each(
    store: LifeStore,
    f: LifeFrame,
    t: number,
    bird: (e: LifeSeen, k: LifeKind, i: number, place: BirdPlace) => void,
  ): void {
    const place = this.#place;
    for (const e of store.values()) {
      const k = this.#life.kinds[e.kind];
      if (k === undefined || k.look === undefined || t < e.start || t >= e.end) {
        continue;
      }
      const pose = this.pose(e, f);
      if (pose === null) {
        continue;
      }
      const boat = pose ?? null;
      // The whole group far off: none of it is looked at.
      const mid = this.#mid;
      if (
        !flockAt(e, k, t, boat, mid) ||
        Math.hypot(mid.east - f.cameraEast, mid.north - f.cameraNorth) > k.reach + STRAY
      ) {
        continue;
      }
      const n = drawnCount(e, f.low);
      for (let i = 0; i < n; i++) {
        if (!birdAt(e, k, i, t, boat, f.seaHeight, place) || place.under) {
          continue;
        }
        bird(e, k, i, place);
      }
    }
  }

  /** The birds drawn at tick t: each one's group, its number and its place (the tests). */
  birdsAt(store: LifeStore, f: LifeFrame, t: number): LifeBird[] {
    const out: LifeBird[] = [];
    this.each(store, f, t, (e, k, i, p) => {
      const d = Math.hypot(p.east - f.cameraEast, p.north - f.cameraNorth, p.up - f.cameraUp);
      if (d < k.reach) {
        out.push({ id: e.id, k: i, east: p.east, north: p.north, up: p.up });
      }
    });
    return out;
  }

  /** The gulls over each town near, by day: their wheels found again only when the towns held change. */
  #gulls(f: LifeFrame, sink: BirdSink, towns: GullSource | null): number {
    const kind = this.#gullKind;
    if (towns === null || kind === undefined || kind.look === undefined || f.night) {
      return 0;
    }
    if (towns.version !== this.#townsVersion) {
      this.#towns = gullTowns(towns.buildings(), this.#kinds);
      this.#townsVersion = towns.version;
    }
    const r = this.#life.towns;
    const g = this.#gull;
    const time = f.ticks / STEPS;
    let n = 0;
    for (const t of this.#towns) {
      if (Math.hypot(t.east - f.cameraEast, t.north - f.cameraNorth) > GULL_REACH + 100) {
        continue;
      }
      const count = gullCount(t, r);
      const drawn = f.low ? Math.ceil(count / 2) : count;
      for (let k = 0; k < drawn; k++) {
        gullAt(t, r, k, time, g);
        const d = Math.hypot(g.east - f.cameraEast, g.north - f.cameraNorth, g.up - f.cameraUp);
        const size = Math.min((GULL_REACH - d) / (FADE * GULL_REACH), 1);
        if (size <= 0) {
          continue;
        }
        if (
          sink.add(
            kind.look,
            g.east,
            g.north,
            g.up,
            g.heading,
            birdPhase(t.seed, k),
            size,
            0,
            0,
            false,
          )
        ) {
          n++;
        }
      }
    }
    return n;
  }
}
