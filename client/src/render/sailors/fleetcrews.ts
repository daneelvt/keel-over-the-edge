// SPDX-License-Identifier: AGPL-3.0-only

// The crews of the other boats in view: everyone the server says is aboard
// a boat near the player, but whoever holds its controls (the fleet's
// sailor of that boat, at its helm), drawn at their stations by the same
// rules as the crew of the boat in view (crewrules.ts): to windward of each
// boat's boom, crossing in its tacks and gybes, sitting up or leaning out as
// its helm hikes, changing places when its controls change hands. While its
// helm walks to or from the tiller, the fleet does not draw it there
// (DrawnBoat's helmAway) and its crew draws it walking.
//
// Every boat's crew shares two draws (crewlevel.ts): those on the nearest
// boats the fleet draws in full (its NEAR_MODELS within NEAR_RANGE) at their
// looks' deck level, posed every frame; the rest at the far level, posed in
// turn every FAR_EVERY frames. Each row's frame is its boat's model placed
// in the scene as the fleet's parts place it (fleetparts.ts' placePoint),
// given every frame, so the far follow their boats between their poses. At
// most CREW_MOST people are drawn, those of the nearest boats first; a boat
// past that shows its helm only.
//
// The levels hang under the fleet's root. Nothing is allocated from frame
// to frame once each boat and person is met.

import { Color, Group, Matrix4, Vector3 } from 'three';
import type { Boat as BoatKind } from '../../catalog';
import type { BoatCrew, DrawnBoat } from '../../game/fleet';
import type { SailorLook } from '../boat';
import type { FloatingOrigin } from '../coords';
import { FAR_EVERY, modelDeck, tillerOf } from './crew';
import { CrewBody, type Stance, stance } from './crewbody';
import { deckFigure, farFigure } from './crewfigures';
import { CrewLevel, LEVEL_MOST } from './crewlevel';
import { type PoseInput, poseMember } from './crewpose';
import {
  type CrewMember,
  type CrewPlan,
  CrewRules,
  crewPlan,
  duckFor,
  duckStep,
} from './crewrules';
import type { FleetLook, FleetLooks } from './fleetlooks';
import { type Hike, STRAPPED, seating } from './restage';
import { company } from './ship';
import { plumbOf, poseShip, type ShipPoseInput } from './shippose';
import { type ShipMember, ShipRules, shipPlan } from './shiprules';
import { hullSolid } from './solid';

/** The most people drawn on other boats: the frame's budget on a phone, with a port of crewed boats in view. */
export const CREW_MOST = 160;
/** The fleet's full models: the nearest this many within this of the camera, m. */
const NEAR_MODELS = 12;
const NEAR_RANGE = 60;
/** The most triangles of a deck and a far figure (the build's budgets), and the far figures kept. */
const DECK_TRIANGLES = 3300;
const FAR_TRIANGLES = 300;
const FAR_FIGURES = 40;

/** What a boat's crew needs of its kind, read once from the fleet's model of it. */
export interface KindCrew {
  plan: CrewPlan;
  /** How its sailor hikes, and its centre of gravity's height (the fleet's pivot). */
  hike: Hike;
  cog: number;
}

/**
 * A kind's crew's plan from the fleet's near model of it: its stations, its
 * hull's solid, its boom, its deck and tiller, and how its sailor hikes.
 */
export function kindCrew(
  kind: BoatKind,
  parts: {
    objects: Map<string, import('three').Object3D>;
    gooseneck: Vector3;
    boardRoot: Vector3 | null;
    hullData: unknown;
  },
): KindCrew {
  let root = parts.objects.get('hull') ?? null;
  while (root?.parent != null) {
    root = root.parent;
  }
  const solid = hullSolid(parts.hullData, parts.boardRoot, {
    span: kind.physics.foils.boardSpan,
    chord: kind.physics.foils.boardChord,
  });
  const plan = crewPlan(
    kind.stations,
    solid,
    parts.gooseneck,
    kind.physics.rig.foot,
    root === null ? null : modelDeck(root),
    root === null ? null : tillerOf(root),
  );
  // A ship: her company's places and ways, which her model marks.
  plan.ship = shipPlan(kind.stations, company(parts.objects));
  return {
    plan,
    hike: seating(parts.objects, kind.physics.sailor.hikeReach).hike,
    cog: kind.physics.hull.centreOfGravity,
  };
}

/** A crewed boat in view: its slot's boat, its crew under the rules, and where its model is. */
interface Crewed {
  slot: number;
  entered: number;
  kind: number;
  told: BoatCrew | null;
  rules: CrewRules | ShipRules;
  /** A ship's rules' members' version its people were last made from. */
  version: number;
  /** The vertical in its model's frame, kept within the sea legs' reach. */
  readonly up: Vector3;
  people: Person[];
  /** The boom last frame, its swing, the heel; the model's place in the scene; how far from the camera, squared. */
  boom: number;
  boomRate: number;
  heel: number;
  readonly matrix: Matrix4;
  d2: number;
  /** Whether in view this frame, and whether its people are drawn. */
  seen: boolean;
  drawn: boolean;
  near: boolean;
}

/** Someone drawn on another boat. */
interface Person {
  member: CrewMember;
  look: FleetLook;
  colours: { main: Color; skin: Color; hair: Color };
  body: CrewBody | null;
  near: boolean;
  shown: boolean;
  posed: boolean;
  wait: number;
  duck: number;
  time: number;
  hold: number;
  turn: number;
  a: Stance;
  b: Stance;
}

const m1 = new Matrix4();
const m2 = new Matrix4();
const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);

/** The other boats' crews, drawn at their stations and moving about. */
export class FleetCrews {
  /** Under the fleet's root: the two levels. */
  readonly group = new Group();
  #looks: FleetLooks | null = null;
  #near: CrewLevel | null = null;
  #far: CrewLevel | null = null;
  /** Each kind's crew, once its fleet model has loaded; by kind index. */
  readonly #kinds: (KindCrew | undefined)[] = [];
  /** The crewed boats by view slot. */
  readonly #boats: (Crewed | undefined)[] = [];
  readonly #order: Crewed[] = [];
  readonly #nearRows: Person[] = [];
  readonly #farRows: Person[] = [];
  readonly #figures = new Map<string, Float32Array>();
  #dirty = true;
  #frames = 0;
  readonly #still: boolean;
  /** The wind's direction, radians from north: each boat's wind off its bow. */
  windFrom = 0;
  /** The most people drawn: CREW_MOST, or as a test asks. */
  most = CREW_MOST;
  /** The wind's speed, m/s, and the world's time, s: a ship's company's by them. */
  windSpeed = 0;
  time = 0;

  constructor(
    readonly kinds: readonly BoatKind[],
    readonly sailorLookOf: (code: number) => SailorLook,
  ) {
    this.group.name = 'crews';
    this.#still =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /** The fleet's looks, which the crews are drawn in; until given, nothing is drawn. */
  useLooks(looks: FleetLooks): void {
    if (this.#looks !== null || looks.bones === 0) {
      return;
    }
    this.#looks = looks;
    this.#near = new CrewLevel('fleet near', looks.bones, 3 * DECK_TRIANGLES, 16, looks);
    this.#far = new CrewLevel('fleet far', looks.bones, 3 * FAR_TRIANGLES, FAR_FIGURES, looks);
    this.group.add(this.#near.mesh, this.#far.mesh);
  }

  /** A kind's crew, from the fleet's model of it, as it loads. */
  useKind(index: number, crew: KindCrew): void {
    this.#kinds[index] = crew;
  }

  /** Whether a kind's crew can be drawn: its fleet model has loaded. */
  hasKind(index: number): boolean {
    return this.#kinds[index] !== undefined;
  }

  /**
   * The frame, before the fleet draws: each crewed boat of boats[0 …
   * count) stepped by the rules from how it is drawn, its helm marked away
   * while it walks; those drawn chosen, nearest first, and posed. The camera
   * is at camera (the scene's); dt is the world time since the last frame.
   */
  frame(
    boats: readonly DrawnBoat[],
    count: number,
    origin: FloatingOrigin,
    camera: Vector3,
    dt: number,
  ): void {
    this.#frames++;
    for (const c of this.#order) {
      c.seen = false;
    }
    for (let i = 0; i < count; i++) {
      const b = boats[i] as DrawnBoat;
      b.helmAway = false;
      if (b.slot < 0 || b.crew === null || b.opacity <= 0) {
        continue;
      }
      const kc = this.#kinds[b.kind];
      if (kc === undefined) {
        continue;
      }
      const c = this.#boat(b, kc);
      c.seen = true;
      this.#place(c, b, kc, origin, camera);
      // The rules by the boat as drawn: its boom, the wind off its bow, its helm's depth.
      const boom = b.boom;
      c.boomRate = dt > 0 ? (boom - c.boom) / dt : 0;
      c.boom = boom;
      c.heel = b.heel;
      const sm = this.#shipMoment;
      sm.yards = b.yardsTurn;
      sm.foreYards = b.foreYardsTurn;
      sm.reef = b.reef;
      sm.heel = b.heel;
      sm.wind = this.windSpeed;
      sm.time = this.time;
      c.rules.step({
        dt,
        boom,
        windOffBow: this.windFrom - b.heading,
        depth: depthOf(b, kc.hike),
        ship: sm,
      });
      // A ship's wheel drawn in the look of whoever is at it till relieved.
      if (c.rules instanceof ShipRules && b.crew !== null && c.rules.wheelSeat !== b.crew.holder) {
        const wheel = c.rules.wheelSeat;
        const look = b.crew.people.find((p) => p.seat === wheel)?.look;
        if (look !== undefined) {
          b.look = look;
        }
      }
    }
    // Boats gone from view, or with nobody aboard now, forgotten.
    for (let k = this.#order.length - 1; k >= 0; k--) {
      const c = this.#order[k] as Crewed;
      if (!c.seen) {
        this.#order.splice(k, 1);
        this.#boats[c.slot] = undefined;
        this.#dirty = true;
      }
    }
    const looks = this.#looks;
    const near = this.#near;
    const far = this.#far;
    if (looks === null || near === null || far === null) {
      return;
    }
    // Those drawn: the nearest boats' crews first, to the most; the
    // nearest few boats within range at the deck level.
    this.#order.sort((a, b) => a.d2 - b.d2);
    let people = 0;
    let nearBoats = 0;
    for (const c of this.#order) {
      const n = c.people.length;
      const drawn = people + n <= this.most;
      const isNear = drawn && nearBoats < NEAR_MODELS && c.d2 < NEAR_RANGE * NEAR_RANGE;
      if (isNear) {
        nearBoats++;
      }
      if (drawn !== c.drawn || isNear !== c.near) {
        c.drawn = drawn;
        c.near = isNear;
        this.#dirty = true;
      }
      if (drawn) {
        people += n;
      }
    }
    // Each drawn: their look in, their body made; their helm away while it walks.
    for (let i = 0; i < count; i++) {
      const b = boats[i] as DrawnBoat;
      const c = b.slot >= 0 ? this.#boats[b.slot] : undefined;
      if (c !== undefined && c.drawn && c.rules.helmAway) {
        b.helmAway = true;
      }
    }
    for (const c of this.#order) {
      for (const p of c.people) {
        const l = p.look;
        looks.want(l, true, false, l.railed, l.shipped, l.aloft);
        const done = (s: string): boolean => s === 'ready' || s === 'failed';
        const can =
          c.drawn &&
          l.deck !== null &&
          l.clips !== null &&
          l.clipsState === 'ready' &&
          (!l.railed || done(l.railState)) &&
          (!l.shipped || done(l.shipState)) &&
          (!l.aloft || done(l.aloftState));
        const shown = can && (p.member.station > 0 || p.member.moving !== null);
        if (shown && p.body === null && l.deck !== null) {
          p.body = new CrewBody(
            l.deck,
            1 + p.member.seat * 977 + l.index * 31 + c.slot * 7919,
            l.machine,
          );
          p.posed = false;
        }
        if (shown !== p.shown) {
          p.shown = shown;
          this.#dirty = true;
        }
        if (c.near !== p.near) {
          p.near = c.near;
          this.#dirty = true;
        }
      }
    }
    // Each posed: the near every frame, the far in their turn.
    const t0 = performance.now();
    for (const c of this.#order) {
      const kc = this.#kinds[c.kind] as KindCrew;
      if (c.rules instanceof ShipRules) {
        plumbOf(c.matrix, c.up);
      }
      for (const p of c.people) {
        if (!p.shown || p.body === null) {
          continue;
        }
        p.wait += dt;
        p.time += dt;
        if (p.posed && c.rules instanceof CrewRules) {
          p.duck = duckStep(p.duck, duckFor(kc.plan, c.boom, c.boomRate, p.body.headUp), dt);
        }
        if (p.near || !p.posed || (this.#frames + p.turn) % FAR_EVERY === 0) {
          this.#pose(p, c, kc, p.wait);
          p.wait = 0;
          p.posed = true;
          this.stats.posed++;
        }
      }
    }
    this.stats.frames++;
    this.stats.ms += performance.now() - t0;
    if (this.#dirty) {
      this.#dirty = false;
      this.#pool(near, far);
    }
    this.#rows(near, this.#nearRows);
    this.#rows(far, this.#farRows);
  }

  /** The boat in a drawn boat's slot, met afresh if it is another boat or a new crew; its crew told. */
  #boat(b: DrawnBoat, kc: KindCrew): Crewed {
    let c = this.#boats[b.slot];
    if (c === undefined || c.entered !== b.entered || c.kind !== b.kind) {
      if (c !== undefined) {
        this.#order.splice(this.#order.indexOf(c), 1);
      }
      c = {
        slot: b.slot,
        entered: b.entered,
        kind: b.kind,
        told: null,
        rules:
          kc.plan.ship == null
            ? new CrewRules(kc.plan)
            : new ShipRules({ stations: kc.plan.stations, ship: kc.plan.ship }, this.#still),
        up: new Vector3(0, 1, 0),
        version: -1,
        people: [],
        boom: b.boom,
        boomRate: 0,
        heel: b.heel,
        matrix: new Matrix4(),
        d2: Number.POSITIVE_INFINITY,
        seen: true,
        drawn: false,
        near: false,
      };
      this.#boats[b.slot] = c;
      this.#order.push(c);
      this.#dirty = true;
    }
    if (b.crew !== c.told) {
      // Met first, everyone at their place; after, the change walked.
      const first = c.told === null;
      c.told = b.crew;
      c.rules.set(b.crew, !first);
      this.#people(c);
    } else if (c.rules instanceof ShipRules && c.rules.version !== c.version) {
      // A relief has taken the spokes: who walks has changed.
      this.#people(c);
    }
    return c;
  }

  /** A boat's people as its rules have them: those already met kept. */
  #people(c: Crewed): void {
    const looks = this.#looks;
    const before = new Map(c.people.map((p) => [p.member, p]));
    c.people = [];
    if (looks === null) {
      return;
    }
    const stations = c.rules.plan.stations;
    const ship = c.rules instanceof ShipRules;
    if (c.rules instanceof ShipRules) {
      c.version = c.rules.version;
    }
    const railed = !ship && stations.some((s) => s.windward === true || s.pose === 'rail');
    const aloft = ship && stations.some((s) => s.pose === 'aloft');
    if (ship) {
      // Whoever is at the wheel too: relieved, they walk with the crew.
      for (const p of c.told?.people ?? []) {
        const l = this.sailorLookOf(p.look);
        looks.want(looks.add(l.art, l.machine), true, false, false, true, aloft);
      }
    }
    for (const member of c.rules.members) {
      const l = this.sailorLookOf(member.look);
      const look = looks.add(l.art, l.machine);
      looks.want(look, true, false, railed, ship, aloft);
      const was = before.get(member);
      if (was !== undefined && was.look === look) {
        c.people.push(was);
        continue;
      }
      c.people.push({
        member,
        look,
        colours: {
          main: new Color(l.colours.main),
          skin: new Color(l.colours.skin),
          hair: new Color(l.colours.hair),
        },
        body: null,
        near: false,
        shown: false,
        posed: false,
        wait: 0,
        duck: 0,
        time: (member.seat * 7.31 + c.slot * 3.7) % 30,
        hold: (member.seat * 7.31 + c.slot * 3.7) % 30,
        turn: (member.seat + c.slot) % FAR_EVERY,
        a: stance(),
        b: stance(),
      });
    }
    this.#dirty = true;
  }

  /** A boat's model's place in the scene, as the fleet's parts place it, and its distance from the camera. */
  #place(c: Crewed, b: DrawnBoat, kc: KindCrew, origin: FloatingOrigin, camera: Vector3): void {
    const x = b.east - origin.world.x;
    const z = -(b.north - origin.world.y);
    // About the centre of gravity's height: the heel, then the pitch; then the heading; then where it is, heaved.
    c.matrix
      .makeTranslation(x, b.heave, z)
      .multiply(m1.makeRotationAxis(Y, -b.heading))
      .multiply(m1.makeTranslation(0, kc.cog, 0))
      .multiply(m1.makeRotationAxis(X, b.pitch))
      .multiply(m2.makeRotationAxis(Z, -b.heel))
      .multiply(m1.makeTranslation(0, -kc.cog, 0));
    const dx = x - camera.x;
    const dz = z - camera.z;
    c.d2 = dx * dx + dz * dz;
  }

  /** Poses someone for what they are doing, dt seconds since they were last posed. */
  #pose(p: Person, c: Crewed, kc: KindCrew, dt: number): void {
    const seat = this.#looks?.seat;
    const clips = p.look.clips;
    if (seat === undefined || clips === null || p.body === null) {
      return;
    }
    if (c.rules instanceof ShipRules) {
      const s = this.#shipInput;
      s.rules = c.rules;
      s.clips = clips;
      s.machine = p.look.machine;
      s.time = this.#still ? p.hold : p.time;
      s.world = c.rules.time;
      s.life.dt = dt;
      s.life.heel = c.heel;
      s.life.upright = 0;
      s.life.still = this.#still;
      s.up = c.up;
      s.a = p.a;
      s.b = p.b;
      if (!poseShip(p.body, p.member as ShipMember, s)) {
        p.body.hide();
      }
      return;
    }
    const input = this.#input;
    input.stations = kc.plan.stations;
    input.seat = seat;
    input.clips = clips;
    input.time = this.#still ? p.hold : p.time;
    input.duck = p.duck;
    input.life.dt = dt;
    input.life.heel = c.heel;
    input.life.upright = 0.5;
    input.life.still = this.#still;
    input.a = p.a;
    input.b = p.b;
    poseMember(p.body, p.member, input);
  }

  readonly #shipMoment = { yards: 0, foreYards: 0, reef: 0, heel: 0, wind: 0, time: 0 };
  readonly #shipInput: ShipPoseInput = {
    rules: null as unknown as ShipRules,
    clips: new Map(),
    machine: false,
    time: 0,
    world: 0,
    life: { dt: 0, heel: 0, upright: 0, still: false, plumb: null },
    up: new Vector3(0, 1, 0),
    a: stance(),
    b: stance(),
  };

  readonly #input: PoseInput = {
    stations: [],
    seat: { out: 0, y: 0, z: 0 },
    clips: new Map(),
    time: 0,
    duck: 0,
    life: { dt: 0, heel: 0, upright: 0.5, still: false },
    a: stance(),
    b: stance(),
  };

  /** The figure for a key, made the first time it is asked for. */
  #figure(key: string, make: () => Float32Array | null): Float32Array | null {
    let f = this.#figures.get(key) ?? null;
    if (f === null) {
      f = make();
      if (f !== null) {
        this.#figures.set(key, f);
      }
    }
    return f;
  }

  /** The levels' figures pooled for those drawn at each, and their rows' heads. */
  #pool(near: CrewLevel, far: CrewLevel): void {
    const seat = this.#looks?.seat;
    if (seat === undefined) {
      return;
    }
    const nearKeys: string[] = [];
    const farKeys: string[] = [];
    this.#nearRows.length = 0;
    this.#farRows.length = 0;
    this.#rowBoats.length = 0;
    this.#farBoats.length = 0;
    for (const c of this.#order) {
      if (!c.drawn) {
        continue;
      }
      for (const p of c.people) {
        if (!p.shown || p.body === null) {
          continue;
        }
        const look = p.look;
        if (p.near && look.deck !== null && this.#nearRows.length < LEVEL_MOST) {
          const key = `deck ${look.index}`;
          if (
            this.#figure(key, () => (look.deck === null ? null : deckFigure(look.deck))) !== null
          ) {
            nearKeys.push(key);
            this.#nearRows.push(p);
            this.#rowBoats.push(c);
            continue;
          }
        }
        const key = `far ${look.index}`;
        if (
          this.#farRows.length < LEVEL_MOST &&
          this.#figure(key, () => farFigure(look, seat)) !== null
        ) {
          farKeys.push(key);
          this.#farRows.push(p);
          this.#farBoats.push(c);
        }
      }
    }
    const figure = (k: string): Float32Array => this.#figures.get(k) as Float32Array;
    near.pool.add(nearKeys, figure);
    far.pool.add(farKeys, figure);
    for (const [level, rows, keys] of [
      [near, this.#nearRows, nearKeys],
      [far, this.#farRows, farKeys],
    ] as const) {
      level.room(rows.length);
      rows.forEach((p, r) => {
        const placed = level.pool.placed.get(keys[r] as string);
        if (placed !== undefined) {
          level.head(r, placed, p.colours, p.look.layer, p.look.machine);
        }
      });
      level.commit(rows.length, keys);
    }
    this.drawn = { near: this.#nearRows.length, far: this.#farRows.length };
  }

  /** The boat of each near row, and of each far row. */
  readonly #rowBoats: Crewed[] = [];
  readonly #farBoats: Crewed[] = [];

  /** Each row's frame and bones, as their person and boat were last posed and placed. */
  #rows(level: CrewLevel, rows: readonly Person[]): void {
    if (rows.length === 0) {
      return;
    }
    const boats = level === this.#near ? this.#rowBoats : this.#farBoats;
    for (let r = 0; r < rows.length; r++) {
      const body = (rows[r] as Person).body;
      const c = boats[r];
      if (body !== null && c !== undefined) {
        level.frame(r, c.matrix.elements);
        level.bonesAt(r, body.bones);
      }
    }
    level.touch();
  }

  /** The crewed boats in view and their people, for tests and hooks. */
  boats(): {
    slot: number;
    drawn: boolean;
    near: boolean;
    helmAway: boolean;
    side: number;
    tack: boolean;
    members: {
      seat: number;
      station: number;
      side: number;
      moving: string | null;
      from: number;
      t: number;
    }[];
    heads: Vector3[];
  }[] {
    return this.#order.map((c) => ({
      slot: c.slot,
      drawn: c.drawn,
      near: c.near,
      helmAway: c.rules.helmAway,
      side: c.rules.side.side,
      tack: c.rules.side.tack,
      members: c.rules.members.map((m) => ({
        seat: m.seat,
        station: m.station,
        side: m.side,
        moving: m.moving?.kind ?? null,
        from: m.moving?.from.station ?? m.station,
        t: m.moving?.t ?? 0,
      })),
      heads: c.people
        .filter((p) => p.shown && p.body !== null)
        .map((p) => (p.body as CrewBody).head.clone().applyMatrix4(c.matrix)),
    }));
  }

  /** Whether everyone on the boats drawn is drawn, in their own look. */
  get ready(): boolean {
    const settled = (s: string): boolean => s === 'ready' || s === 'failed';
    return (
      !this.#dirty &&
      this.#order.every(
        (c) =>
          !c.drawn ||
          c.people.every(
            (p) =>
              (p.member.station <= 0 && p.member.moving === null) ||
              (settled(p.look.state) &&
                settled(p.look.clipsState) &&
                (!p.look.railed || settled(p.look.railState)) &&
                (!p.look.shipped || settled(p.look.shipState)) &&
                (!p.look.aloft || settled(p.look.aloftState)) &&
                (p.look.clipsState === 'failed' || (p.shown && p.posed))),
          ),
      )
    );
  }

  /** Frames drawn, people posed and the milliseconds posing them took, counted until read and reset. */
  stats = { frames: 0, posed: 0, ms: 0 };

  /** How many are drawn at each level, at the last change. */
  drawn = { near: 0, far: 0 };
}

/**
 * How far a boat's helm hikes, from its sailor's offset out from the
 * centreline as the wire gives it (+ starboard) and the side away from its
 * boom: 0 sat in, 1 at the first hiking depth, as the helm's own is.
 */
export function depthOf(b: DrawnBoat, hike: Hike = STRAPPED): number {
  const side = b.boom > 0 ? -1 : 1;
  const out = Math.max(0, b.sailor * side);
  return Math.max(0, Math.min(1, (out - hike.from) / (hike.full - hike.from))) * hike.depth;
}
