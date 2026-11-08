// SPDX-License-Identifier: AGPL-3.0-only

// The sea's life drawn each frame: each group the page holds, about the
// boat it is with where it is with one, each of its birds within its
// kind's reach of the camera, shrinking to nothing over the last of it so
// none appears or vanishes in sight; and the gulls over the towns near, by
// day. Every bird goes to the scene's one draw of birds.

import type { BirdLook, BuildingKind, Life, LifeKind, SwimLook } from '../catalog/types.gen';
import type { LifeSeen } from '../net/messages';
import { type BirdPlace, type BoatAt, birdAt, birdPhase, drawnCount, newBirdPlace } from './birds';
import { type FlockPlace, flockAt, lerp, own } from './flock';
import { patchOf } from './flush';
import {
  type GullBuilding,
  type GullPlace,
  type GullTown,
  gullAt,
  gullCount,
  gullTowns,
} from './gulls';
import { type Aboard, deckAt, newDeckPlace, newPerchPlace, perchAt } from './perch';
import type { LifeStore } from './store';
import { type Boil, boilAt, newSwimPlace, type SwimPlace, swimAt, swimCount } from './swim';
import { WHALE_BLOW, WHALE_BREACH, WHALE_FLUKE, WHALE_SLAP, whaleEvents } from './whale';

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
    body?: string,
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
  heave: number;
  heel: number;
  pitch: number;
}

/** Something breaking the water this frame: a leap's or a dive's splash, a plunge, a flying fish. */
export interface Splash {
  east: number;
  north: number;
  /** How big, 0 to 1: a flying fish's taxi to a dolphin's fall; over 1, a whale's, up to 3 for a humpback's breach. */
  size: number;
}

/** A breath heard: where, from an animal at the surface. */
export interface Breath {
  east: number;
  north: number;
}

/** A whale's blow this frame: where its blowhole is, the sea's height there, its heading, and its kind's blow. */
export interface Blow {
  east: number;
  north: number;
  sea: number;
  heading: number;
  height: number;
  width: number;
  lean: number;
  left: number;
}

/** Something big heard this frame: a whale's blow, a breach's boom, a slap, a fish landing aboard; where, and how big, 0 to 1. */
export interface Heard {
  kind: 'blow' | 'boom' | 'slap' | 'thump';
  east: number;
  north: number;
  size: number;
}

/** The most splashes, breaths and boils kept a frame; blows, prints and things heard; and glowing trails. */
export const SPLASHES = 24;
export const BOILS = 4;
export const BLOWS = 8;
export const TRAILS = 24;
/** Whales' blows and splashes are looked for within this of the camera, m: a blow is seen to the dome. */
const BLOW_REACH = 2500;
/** A whale's breach or slap, and a fish aboard, are heard within these, m. */
const BOOM_REACH = 1500;
/** Glowing water's trails are laid by animals within this of the camera, m, no deeper than TRAIL_DOWN. */
const TRAIL_REACH = 150;
const TRAIL_DOWN = 2.5;
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
  /** A boat kind's perch, deck and centre of gravity, for what comes aboard. */
  aboardOf: (kind: number) => Aboard | undefined;
  /** Where the wind comes from at the boat, radians clockwise from north. */
  windFrom: number;
  /** How dark the sky is for glowing water to show, 0 to 1, at a limit of the moon's light. */
  skyDark: (moon: number) => number;
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
  /** This frame's whales' blows, [0, blowCount); their footprints, [0, printCount); what big was heard, [0, heardCount). */
  readonly blows: Blow[] = Array.from({ length: BLOWS }, () => ({
    east: 0,
    north: 0,
    sea: 0,
    heading: 0,
    height: 0,
    width: 0,
    lean: 0,
    left: 0,
  }));
  blowCount = 0;
  readonly prints: Splash[] = Array.from({ length: BLOWS }, () => ({ east: 0, north: 0, size: 0 }));
  printCount = 0;
  readonly heard: Heard[] = Array.from({ length: BLOWS }, () => ({
    kind: 'blow' as const,
    east: 0,
    north: 0,
    size: 0,
  }));
  heardCount = 0;
  /** Where glowing water is lit this frame by animals swimming through it, [0, trailCount). */
  readonly trails: Splash[] = Array.from({ length: TRAILS }, () => ({
    east: 0,
    north: 0,
    size: 0,
  }));
  trailCount = 0;
  /** The glow of the water about the camera this frame: its colour, display 0 to 1, and its strength, 0 to 1. */
  readonly glow = { r: 0, g: 0, b: 0, strength: 0 };
  readonly #perch = newPerchPlace();
  readonly #deck = newDeckPlace();
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
  readonly #pose: BoatAt = {
    east: 0,
    north: 0,
    heading: 0,
    speed: 0,
    heave: 0,
    heel: 0,
    pitch: 0,
    kind: 0,
  };
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
        f.own.kind = f.ownKind;
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
        p.heave = b.heave;
        p.heel = b.heel;
        p.pitch = b.pitch;
        p.kind = b.kind;
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
    this.blowCount = 0;
    this.printCount = 0;
    this.heardCount = 0;
    this.trailCount = 0;
    this.#glowAt(store, f);
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
      if (k.binds === 'perch' && boat !== null) {
        // Flying to its perch or from it; on it, it is drawn as a body.
        const aboard = f.aboardOf(boat.kind ?? 0);
        const p = this.#perch;
        if (aboard === undefined || !perchAt(e, k, t, boat, aboard, f.windFrom, p) || p.perched) {
          continue;
        }
        place.east = p.east;
        place.north = p.north;
        place.up = p.up;
        place.heading = p.heading;
        place.pitch = p.pitch;
        place.bank = 0;
        place.plunge = false;
        place.folded = false;
        place.under = false;
        bird(e, k, 0, place);
        continue;
      }
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
    let aboard = 0;
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
      if (boat !== null && (k.binds === 'perch' || k.form === 'glider')) {
        aboard += this.#aboard(e, k, k.swim, f, boat, before, sink);
        continue;
      }
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
        if (k.form === 'whale' && f.dt > 0 && d < BLOW_REACH) {
          this.#whale(e, k, k.swim, i, place, before, f);
        }
        if (
          this.glow.strength > 0 &&
          k.form !== 'glider' &&
          d < TRAIL_REACH &&
          place.up > -TRAIL_DOWN
        ) {
          const tr = this.trails[this.trailCount];
          if (tr !== undefined) {
            tr.east = place.east;
            tr.north = place.north;
            tr.size = Math.min(k.swim.length / 2, 1) * this.glow.strength;
            this.trailCount++;
          }
        }
        if (d < SPLASH_REACH && f.dt > 0 && swimAt(e, k, i, before, boat, was)) {
          if (k.form !== 'whale' && place.shown && was.shown && place.up > 0 !== was.up > 0) {
            this.#splash(
              place.east,
              place.north,
              k.form === 'ray' ? 0.8 : Math.min(k.swim.length / 2.5, 1),
            );
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
    return drawn + aboard;
  }

  /**
   * A whale's events since the last frame, at its place now: each blow
   * thrown from its blowhole (a third of its length ahead of its middle,
   * or at the front of its head for a kind whose blow leans to the left);
   * a breach's fall and a slap, splashes heard far; and the smooth patch
   * its flukes leave as it dives, or as it breaches or slaps.
   */
  #whale(
    e: LifeSeen,
    k: LifeKind,
    swim: SwimLook,
    i: number,
    p: SwimPlace,
    before: number,
    f: LifeFrame,
  ): void {
    const blow = swim.blow;
    const from = (before - e.start) / STEPS;
    const to = (f.ticks - e.start) / STEPS;
    whaleEvents(k, e, i, from, to, (event) => {
      const sh = Math.sin(p.heading);
      const ch = Math.cos(p.heading);
      switch (event) {
        case WHALE_BLOW: {
          const b = this.blows[this.blowCount];
          if (blow === undefined || b === undefined) {
            return;
          }
          const ahead = swim.length * (blow.left > 0 ? 0.47 : 0.3);
          b.east = p.east + sh * ahead;
          b.north = p.north + ch * ahead;
          b.sea = 0;
          b.heading = p.heading;
          b.height = lerp(blow.height[0], blow.height[1], own(e.seed + i, 70 + Math.floor(to)));
          b.width = blow.width;
          b.lean = (blow.lean * Math.PI) / 180;
          b.left = (blow.left * Math.PI) / 180;
          this.blowCount++;
          this.#hear('blow', b.east, b.north, Math.min(swim.length / 14, 1));
          return;
        }
        case WHALE_BREACH:
          this.#splash(p.east, p.north, 3 * Math.min(swim.length / 14, 1));
          this.#splash(
            p.east + sh * swim.length * 0.3,
            p.north + ch * swim.length * 0.3,
            2 * Math.min(swim.length / 14, 1),
          );
          this.#print(p.east, p.north, swim.length * 0.6);
          this.#hear('boom', p.east, p.north, Math.min(swim.length / 14, 1));
          return;
        case WHALE_SLAP: {
          const back = swim.length * 0.45;
          this.#splash(p.east - sh * back, p.north - ch * back, 2 * Math.min(swim.length / 14, 1));
          this.#hear(
            'slap',
            p.east - sh * back,
            p.north - ch * back,
            Math.min(swim.length / 14, 1),
          );
          return;
        }
        case WHALE_FLUKE:
          this.#print(
            p.east - sh * swim.length * 0.3,
            p.north - ch * swim.length * 0.3,
            swim.length * 0.5,
          );
          return;
      }
    });
  }

  /** A whale's footprint this frame, if there is room. */
  #print(east: number, north: number, radius: number): void {
    const s = this.prints[this.printCount];
    if (s !== undefined) {
      s.east = east;
      s.north = north;
      s.size = radius;
      this.printCount++;
    }
  }

  /** Something big heard this frame, if there is room. */
  #hear(kind: Heard['kind'], east: number, north: number, size: number): void {
    const h = this.heard[this.heardCount];
    if (h !== undefined) {
      h.kind = kind;
      h.east = east;
      h.north = north;
      h.size = size;
      this.heardCount++;
    }
  }

  /**
   * What is aboard a boat drawn this frame: a booby on its perch, drawn as
   * its body, standing or by night asleep (flying to it or from it, it is
   * one of the birds); a fish landed on the deck, flapping, with a thump
   * as it lands. The deck is never under the water: the body's surface is
   * put far below it. It reports how many it drew.
   */
  #aboard(
    e: LifeSeen,
    k: LifeKind,
    swim: SwimLook,
    f: LifeFrame,
    boat: BoatAt,
    before: number,
    sink: SwimSink,
  ): number {
    const aboard = f.aboardOf(boat.kind ?? 0);
    if (
      aboard === undefined ||
      Math.hypot(boat.east - f.cameraEast, boat.north - f.cameraNorth) > k.reach
    ) {
      return 0;
    }
    if (k.binds === 'perch') {
      const p = this.#perch;
      if (!perchAt(e, k, f.ticks, boat, aboard, f.windFrom, p) || !p.perched) {
        return 0;
      }
      const body = f.night && swim.asleep !== undefined ? swim.asleep : swim.body;
      return sink.add(
        swim,
        p.east,
        p.north,
        p.up,
        p.up - 100,
        p.heading,
        p.pitch,
        p.roll,
        0,
        0,
        0,
        0,
        1,
        body,
      )
        ? 1
        : 0;
    }
    const d = this.#deck;
    if (!deckAt(e, f.ticks, boat, aboard, d)) {
      return 0;
    }
    if (f.dt > 0 && before < e.start + 1 && f.ticks >= e.start + 1) {
      this.#hear('thump', d.east, d.north, 0.3);
    }
    const u = (f.ticks - e.start) / STEPS;
    // On its side, its tail flapping, its wings half folded.
    return sink.add(
      swim,
      d.east,
      d.north,
      d.up + 0.02,
      d.up - 100,
      d.heading,
      0,
      1.45,
      d.flap,
      2 * Math.PI * 9 * u,
      0.6,
      0,
      1,
    )
      ? 1
      : 0;
  }

  /** The glow of the water about the camera: the strongest of the glowing patches it is in, by its distance in from the patch's edge and how dark the sky is. */
  #glowAt(store: LifeStore, f: LifeFrame): void {
    const g = this.glow;
    g.strength = 0;
    for (const e of store.values()) {
      const k = this.#life.kinds[e.kind];
      if (k === undefined || k.glow === undefined || f.ticks < e.start || f.ticks >= e.end) {
        continue;
      }
      const mid = this.#mid;
      if (!flockAt(e, k, f.ticks, null, mid)) {
        continue;
      }
      const reach = patchOf(k, e.seed);
      const d = Math.hypot(mid.east - f.cameraEast, mid.north - f.cameraNorth);
      const inside = Math.min(Math.max((reach - d) / 60, 0), 1);
      // Fading in and out over its first and last minutes.
      const life = Math.min(f.ticks - e.start, e.end - f.ticks) / STEPS / 60;
      const s = inside * Math.min(life, 1) * f.skyDark(k.glow.moon);
      if (s > g.strength) {
        const c = Number.parseInt(k.glow.colour.slice(1), 16);
        g.r = ((c >> 16) & 255) / 255;
        g.g = ((c >> 8) & 255) / 255;
        g.b = (c & 255) / 255;
        g.strength = s;
      }
    }
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
