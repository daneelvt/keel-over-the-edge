// SPDX-License-Identifier: AGPL-3.0-only

// The sea's life drawn each frame: each group the page holds, about the
// boat it is with where it is with one, each of its birds within its
// kind's reach of the camera, shrinking to nothing over the last of it so
// none appears or vanishes in sight; and the gulls over the towns near, by
// day. Every bird goes to the scene's one draw of birds.

import type { BirdLook, BuildingKind, Life, LifeKind, SwimLook } from '../catalog/types.gen';
import type { LifeSeen } from '../net/messages';
import { type BirdPlace, type BoatAt, birdAt, birdPhase, drawnCount, newBirdPlace } from './birds';
import { type FlockPlace, flockAt } from './flock';
import { patchOf } from './flush';
import {
  type GullBuilding,
  type GullPlace,
  type GullTown,
  gullAt,
  gullCount,
  gullTowns,
} from './gulls';
import type { LifeStore } from './store';
import { type Boil, boilAt, newSwimPlace, type SwimPlace, swimAt, swimCount } from './swim';

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

/** Where an animal in the water is drawn to: the scene's swimmers, or the tests'. */
export interface SwimSink {
  /** Asks for the bodies, the first time any is wanted. */
  load(): void;
  add(
    look: SwimLook,
    east: number,
    north: number,
    up: number,
    surface: number,
    heading: number,
    pitch: number,
    roll: number,
    wave: number,
    beat: number,
    fold: number,
    stroke: number,
    size: number,
  ): boolean;
}

/** The sea's surface's height at points, m: east and north of each in turn in, heights to out. */
export type SurfaceAt = (points: Float64Array, count: number, out: Float64Array) => void;

/** A boat as the life drawn reads it: its view slot, kind, place, heading and speed. */
export interface LifeBoat {
  slot: number;
  kind: number;
  east: number;
  north: number;
  heading: number;
  speed: number;
  opacity: number;
}

/** Something breaking the water this frame: a leap's or a dive's splash, a plunge, a flying fish. */
export interface Splash {
  east: number;
  north: number;
  /** How big, 0 to 1: a flying fish's taxi to a dolphin's fall. */
  size: number;
}

/** A breath heard: where, from an animal at the surface. */
export interface Breath {
  east: number;
  north: number;
}

/** The most splashes, breaths and boils kept a frame. */
export const SPLASHES = 24;
export const BOILS = 4;
/** Splashes and breaths are looked for within this of the camera, m. */
const SPLASH_REACH = 250;
/** How deep an animal is drawn at most, m: deeper, the water hides it. */
const DRAWN_DOWN = 2.4;

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
  /** How far a boat kind's stem is ahead of its middle, m. */
  bowOf: (kind: number) => number;
  /** The kind of the page's own boat, or the one it watches. */
  ownKind: number;
  /** World time since the last frame, s: what broke the water since is looked for. */
  dt: number;
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
  /** The birds of the sea's life drawn, and the towns' gulls; the animals in the water. */
  birds: number;
  gulls: number;
  swimmers: number;
}

/** The towns' buildings, as the gulls' wheels are found from them; and their version. */
export interface GullSource {
  version: number;
  buildings(): Iterable<GullBuilding & { level?: number }>;
}

/** An animal in the water found in a frame, before the sea's height under it is known. */
interface Found {
  e: LifeSeen;
  k: LifeKind;
  place: SwimPlace;
  size: number;
}

export class LifeDraw {
  readonly stats: LifeStats = { records: 0, birds: 0, gulls: 0, swimmers: 0 };
  /** This frame's splashes and breaths, [0, splashCount) and [0, breathCount); and the boils near, [0, boilCount). */
  readonly splashes: Splash[] = Array.from({ length: SPLASHES }, () => ({
    east: 0,
    north: 0,
    size: 0,
  }));
  splashCount = 0;
  readonly breaths: Breath[] = Array.from({ length: SPLASHES }, () => ({ east: 0, north: 0 }));
  breathCount = 0;
  readonly boils: Boil[] = Array.from({ length: BOILS }, () => ({
    east: 0,
    north: 0,
    reach: 0,
    strength: 0,
  }));
  boilCount = 0;
  readonly #swim: SwimPlace = newSwimPlace();
  readonly #was: SwimPlace = newSwimPlace();
  readonly #wasBird = newBirdPlace();
  /** The animals found this frame, before the sea's height under each is known: their records, numbers and places. */
  readonly #found: Found[] = Array.from({ length: 96 }, () => ({
    e: null as unknown as LifeSeen,
    k: null as unknown as LifeKind,
    place: newSwimPlace(),
    size: 1,
  }));
  readonly #points = new Float64Array(2 * 96);
  readonly #heights = new Float64Array(96);
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
      if (f.own !== null) {
        f.own.bow = f.bowOf(f.ownKind);
      }
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
        p.bow = f.bowOf(b.kind);
        return p;
      }
    }
    return null;
  }

  /** Every bird of the life held, and the towns' gulls, drawn for a frame. */
  frame(
    store: LifeStore,
    f: LifeFrame,
    sink: BirdSink,
    towns: GullSource | null,
    swimmers: SwimSink | null = null,
    surface: SurfaceAt | null = null,
  ): void {
    store.expire(f.ticks);
    this.splashCount = 0;
    this.breathCount = 0;
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
    this.#plunges(store, f);
    this.stats.swimmers = swimmers === null ? 0 : this.#water(store, f, swimmers, surface);
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

  /** A splash this frame, if there is room. */
  #splash(east: number, north: number, size: number): void {
    const s = this.splashes[this.splashCount];
    if (s !== undefined) {
      s.east = east;
      s.north = north;
      s.size = size;
      this.splashCount++;
    }
  }

  /** The birds near the camera that went into the water since the last frame: each a splash. */
  #plunges(store: LifeStore, f: LifeFrame): void {
    if (!(f.dt > 0)) {
      return;
    }
    const was = this.#wasBird;
    const before = f.ticks - f.dt * STEPS;
    for (const e of store.values()) {
      const k = this.#life.kinds[e.kind];
      if (
        k === undefined ||
        k.look === undefined ||
        (k.dives ?? 0) <= 0 ||
        f.ticks < e.start ||
        f.ticks >= e.end
      ) {
        continue;
      }
      const pose = this.pose(e, f);
      if (pose === null) {
        continue;
      }
      const boat = pose ?? null;
      const mid = this.#mid;
      if (
        !flockAt(e, k, f.ticks, boat, mid) ||
        Math.hypot(mid.east - f.cameraEast, mid.north - f.cameraNorth) > SPLASH_REACH + STRAY
      ) {
        continue;
      }
      const n = drawnCount(e, f.low);
      const place = this.#place;
      for (let i = 0; i < n; i++) {
        if (
          !birdAt(e, k, i, f.ticks, boat, f.seaHeight, place) ||
          !birdAt(e, k, i, before, boat, f.seaHeight, was)
        ) {
          continue;
        }
        if (place.under !== was.under) {
          this.#splash(place.east, place.north, Math.min((k.look.span ?? 1) / 3, 0.6));
        }
      }
    }
  }

  /**
   * Every animal in the water held, drawn for a frame: within its kind's
   * reach of the camera and no deeper than the water shows, the sea's
   * height under each from surface; the boils of bait near; and what broke
   * the water since the last frame near the camera, and the breaths.
   */
  #water(store: LifeStore, f: LifeFrame, sink: SwimSink, surface: SurfaceAt | null): number {
    let found = 0;
    this.boilCount = 0;
    const place = this.#swim;
    const was = this.#was;
    const before = f.ticks - f.dt * STEPS;
    for (const e of store.values()) {
      const k = this.#life.kinds[e.kind];
      if (k === undefined || f.ticks < e.start || f.ticks >= e.end) {
        continue;
      }
      if (k.form === 'bait') {
        const b = this.boils[this.boilCount];
        if (
          b !== undefined &&
          boilAt(e, k, f.ticks, patchOf(k, e.seed), b) &&
          Math.hypot(b.east - f.cameraEast, b.north - f.cameraNorth) < k.reach
        ) {
          this.boilCount++;
        }
        continue;
      }
      if (k.swim === undefined) {
        continue;
      }
      sink.load();
      const pose = this.pose(e, f);
      if (pose === null) {
        continue;
      }
      const boat = pose ?? null;
      const mid = this.#mid;
      if (
        !flockAt(e, k, f.ticks, boat, mid) ||
        Math.hypot(mid.east - f.cameraEast, mid.north - f.cameraNorth) > k.reach + STRAY
      ) {
        continue;
      }
      const n = swimCount(e, f.low);
      for (let i = 0; i < n && found < this.#found.length; i++) {
        if (!swimAt(e, k, i, f.ticks, boat, place) || !place.shown) {
          continue;
        }
        const d = Math.hypot(place.east - f.cameraEast, place.north - f.cameraNorth);
        if (d > k.reach) {
          continue;
        }
        // Keeping off the hulls it is not riding: deeper where it meets one.
        if (e.with === 0 && this.#underHull(place, f)) {
          place.up -= DRAWN_DOWN + 1;
        }
        if (d < SPLASH_REACH && f.dt > 0 && swimAt(e, k, i, before, boat, was)) {
          if (place.shown && was.shown && place.up > 0 !== was.up > 0) {
            this.#splash(place.east, place.north, Math.min(k.swim.length / 2.5, 1));
          }
          if (place.breath && !was.breath && k.swim.call === 'breath') {
            const b = this.breaths[this.breathCount];
            if (b !== undefined) {
              b.east = place.east;
              b.north = place.north;
              this.breathCount++;
            }
          }
        }
        if (place.up < -DRAWN_DOWN) {
          continue;
        }
        const slot = this.#found[found] as Found;
        slot.e = e;
        slot.k = k;
        Object.assign(slot.place, place);
        slot.size = Math.min((k.reach - d) / (FADE * k.reach), 1);
        this.#points[found * 2] = place.east;
        this.#points[found * 2 + 1] = place.north;
        found++;
      }
    }
    const heights = this.#heights;
    if (surface !== null && found > 0) {
      surface(this.#points, found, heights);
    } else {
      heights.fill(0, 0, found);
    }
    let drawn = 0;
    for (let j = 0; j < found; j++) {
      const slot = this.#found[j] as Found;
      const p = slot.place;
      const h = heights[j] ?? 0;
      const look = slot.k.swim as SwimLook;
      if (
        sink.add(
          look,
          p.east,
          p.north,
          h + p.up,
          h,
          p.heading,
          p.pitch,
          p.roll,
          p.wave,
          p.beat,
          p.fold,
          p.stroke,
          slot.size,
        )
      ) {
        drawn++;
      }
    }
    return drawn;
  }

  /** Whether an animal is under a hull drawn, the page's own or another's. */
  #underHull(p: SwimPlace, f: LifeFrame): boolean {
    const near = (east: number, north: number, kind: number): boolean =>
      Math.hypot(p.east - east, p.north - north) < f.bowOf(kind) + 1.5;
    if (f.own !== null && near(f.own.east, f.own.north, f.ownKind)) {
      return true;
    }
    for (let i = 0; i < f.count; i++) {
      const b = f.fleet[i];
      if (b !== undefined && b.opacity > 0 && near(b.east, b.north, b.kind)) {
        return true;
      }
    }
    return false;
  }

  /** The animals in the water drawn at tick t: each one's group, its number and its place (the tests). */
  swimmersAt(store: LifeStore, f: LifeFrame, t: number): LifeBird[] {
    const out: LifeBird[] = [];
    const place = this.#swim;
    for (const e of store.values()) {
      const k = this.#life.kinds[e.kind];
      if (k === undefined || k.swim === undefined || t < e.start || t >= e.end) {
        continue;
      }
      const pose = this.pose(e, f);
      if (pose === null) {
        continue;
      }
      const n = swimCount(e, f.low);
      for (let i = 0; i < n; i++) {
        if (swimAt(e, k, i, t, pose ?? null, place) && place.shown) {
          const d = Math.hypot(place.east - f.cameraEast, place.north - f.cameraNorth);
          if (d < k.reach) {
            out.push({ id: e.id, k: i, east: place.east, north: place.north, up: place.up });
          }
        }
      }
    }
    return out;
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
