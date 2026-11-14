// SPDX-License-Identifier: AGPL-3.0-only

// The people aboard the boat in view, besides whoever holds the controls
// (the boat's own sailor, at the helm: onboat.ts): each at the station of
// its kind (the catalog's `stations`) its seat gives, in its own look.
// Whoever holds the controls is at the helm; the skipper, while someone
// else holds them, at that one's own station; everyone else at the station
// of their seat. What each does follows the crew's rules (crewrules.ts):
// to windward, crossing in a tack or a gybe at a crouch, sitting up or
// leaning out with the helm, changing places when the controls change hands.
//
// They are never still. Each is posed on the CPU (crewbody.ts): their
// station's clip, or two blended (sitting up and leaning out, a pose going
// over into another), the crouch's walk along a path, bent forward under
// the boom, and the life layers over it, each person's own from their
// seat. The GPU skins them (crewlevel.ts), every person of a level in one
// draw: the nearest few within NEAR_RANGE of the camera at their looks'
// deck level, posed every frame; the rest at their far level, posed in
// turn, every FAR_EVERY frames.
//
// Aboard a beach cat, her crew go out on her trapeze's wire: theirs drawn
// from the hounds to their hips, the model's own on that side hidden.
// Aboard a cruising yacht, her people are drawn with her own clips (her
// bench, her rail, her ways at a crouch), loaded with their looks; aboard a
// cruising catamaran, with hers (her seats, her ways upright, her ladder).
//
// The group is a child of the boat's model: the people heel, pitch and
// heave with it. Allocation-free from frame to frame once each person is
// made.

import { Color, Group, Mesh, type Object3D, Raycaster, Vector3 } from 'three';
import type { BoatStation } from '../../catalog';
import type { SailorLook } from '../boat';
import { catFloor } from './cat';
import { CrewBody, type Stance, stance } from './crewbody';
import { deckFigure, farFigure } from './crewfigures';
import { CrewLevel } from './crewlevel';
import { type Level, type PoseInput, poseMember } from './crewpose';
import {
  type CrewMember,
  type CrewMoment,
  type CrewPlan,
  CrewRules,
  duckFor,
  duckStep,
  waysOf,
} from './crewrules';
import type { FleetLook, FleetLooks, FleetSeat } from './fleetlooks';
import { setWire, wireColour, wireMesh } from './onboat';
import { ShipBraces } from './shipbraces';
import { plumbOf, poseShip, type ShipPoseInput } from './shippose';
import { type ShipMember, ShipRules } from './shiprules';

/** Someone aboard, as the crew drawn needs them: their seat and look code, and whether they wear the winner's cockade. */
export interface CrewPerson {
  seat: number;
  look: number;
  cockade?: boolean;
}

/** Who is aboard, the skipper (seat 0) first, and the seat of whoever holds the controls. */
export interface CrewShown {
  people: readonly CrewPerson[];
  holder: number;
}

/** A person drawn at a station: the station's index, and their look code. */
export interface CrewPlace {
  station: number;
  look: number;
}

/**
 * Where each person aboard is drawn, but whoever holds the controls (at
 * the helm, the boat's own sailor): the skipper, while another holds them,
 * at that one's station; everyone else at their seat's. A seat past the
 * stations is not drawn.
 */
export function crewPlaces(crew: CrewShown, stations: number): CrewPlace[] {
  const out: CrewPlace[] = [];
  for (const p of crew.people) {
    if (p.seat === crew.holder) {
      continue;
    }
    const station = p.seat === 0 ? crew.holder : p.seat;
    if (station > 0 && station < stations) {
      out.push({ station, look: p.look });
    }
  }
  return out;
}

/** The look whoever holds the controls is drawn in at the helm; null if none aboard holds them. */
export function helmLook(crew: CrewShown): number | null {
  return crew.people.find((p) => p.seat === crew.holder)?.look ?? null;
}

/** The nearest this many within this of the camera, metres, are drawn at the deck level: the fleet's full models' few and range. */
export const NEAR_MOST = 12;
export const NEAR_RANGE = 60;
/** The far are posed once in this many frames, each in their own turn. */
export const FAR_EVERY = 4;
/** The most figures kept in the far level's pool before it is emptied for those drawn: one for each look aboard. */
const FAR_FIGURES = 40;
/** The most triangles of a deck and a far figure (the build's budgets). */
const DECK_TRIANGLES = 3300;
const FAR_TRIANGLES = 300;

export { stationPlace } from './crewpose';

const down = new Vector3(0, -1, 0);
const from = new Vector3();

/** The materials of what is walked on: the deck and the cockpit's floor, a cuddy's canvas roof, and a beach cat's net. */
const WALKED = ['deck', 'canvas', 'net'];

/** What else is stepped on or over walking a cruising yacht's ways: her coachroof's scuttles and handrails, her hatches. */
export const STEPPED = ['varnish', 'glass'];

/**
 * The deck of a boat's model, as a height under (x, z) in the model's
 * frame: the highest of its hull's meshes walked on (the deck, the
 * cockpit's floor, a cuddy's roof) there, or null; and of those of the
 * materials also given, stepped on or over.
 */
export function modelDeck(
  model: Object3D,
  also: readonly string[] = [],
): (x: number, z: number) => number | null {
  model.updateMatrixWorld(true);
  const inverse = model.matrixWorld.clone().invert();
  const meshes: Mesh[] = [];
  const hull = model.getObjectByName('hull') ?? model;
  const walked = [...WALKED, ...also];
  hull.traverse((o) => {
    if (o instanceof Mesh && walked.includes((o.material as { name?: string }).name ?? '')) {
      meshes.push(o);
    }
  });
  const ray = new Raycaster();
  return (x, z) => {
    from.set(x, 50, z).applyMatrix4(model.matrixWorld);
    ray.set(from, down.set(0, -1, 0).transformDirection(model.matrixWorld));
    const hit = ray.intersectObjects(meshes, false)[0];
    return hit === undefined ? null : hit.point.applyMatrix4(inverse).y;
  };
}

/** How far out on the wire a crew leans before it hangs from it: the wire drawn to them. */
const WIRE_HOOKED = 0.5;

/** A boat lying still, for a moment that does not say how she lies. */
const NOT_LYING = { pitch: 0, heave: 0, aft: 0 };

/** How far the tiller's top is over its nodes (its head and the extension's hinge), m: its half-depth. */
const TILLER_HALF = 0.03;

/**
 * A boat's tiller, in its model's frame, from its nodes: its head (the
 * tiller's), the extension's hinge on it, and its top; null without one.
 */
export function tillerOf(model: Object3D): CrewPlan['tiller'] {
  const tiller = model.getObjectByName('tiller');
  const hinge = model.getObjectByName('extension');
  if (tiller === undefined || hinge === undefined) {
    return null;
  }
  model.updateMatrixWorld(true);
  const a = model.worldToLocal(tiller.getWorldPosition(new Vector3()));
  const b = model.worldToLocal(hinge.getWorldPosition(new Vector3()));
  return { head: a.z, hinge: b.z, top: Math.max(a.y, b.y) + TILLER_HALF };
}

const world = new Vector3();

/** Someone drawn: who they are under the rules, their look and body, and how they are drawn. */
interface Drawn {
  member: CrewMember;
  look: FleetLook;
  colours: { main: Color; skin: Color; hair: Color };
  /** Their body, made once their look's deck level and clips are in. */
  body: CrewBody | null;
  near: boolean;
  /** Whether drawn at all this frame, and whether posed since made. */
  shown: boolean;
  posed: boolean;
  /** Seconds since last posed; the duck, 0 to 1; their clips' own time, and where it is held under reduced motion. */
  wait: number;
  duck: number;
  time: number;
  hold: number;
  /** Their turn among the far, and the stances posed from. */
  turn: number;
  a: Stance;
  b: Stance;
}

/** The people aboard the boat in view, drawn at their stations and moving about. */
export class CrewDeck {
  /** Under the boat's model, when one is aboard to draw. */
  readonly group = new Group();
  #looks: FleetLooks | null = null;
  #near: CrewLevel | null = null;
  #far: CrewLevel | null = null;
  #stations: readonly BoatStation[] = [];
  #rules: CrewRules | ShipRules | null = null;
  /** A ship's braces, drawn under her model; null aboard any other boat. */
  braces: ShipBraces | null = null;
  #crew: CrewShown | null = null;
  #people: Drawn[] = [];
  /** Those drawn at each level, in order of their rows. */
  #nearRows: Drawn[] = [];
  #farRows: Drawn[] = [];
  /** Each figure, by key: a look's deck level's or far level's. */
  readonly #figures = new Map<string, Float32Array>();
  /** The levels' figures must be pooled again: a look or the nearest changed. */
  #dirty = true;
  #frames = 0;
  /** The boat's moment, as last told: the boom now and a frame ago, the heel; how the boat lies (for those in the water) and how far aft her helm stands. */
  #boom = 0;
  #boomRate = 0;
  #heel = 0;
  readonly #level: Level = { heel: 0, pitch: 0, heave: 0, cog: 0, solid: null };
  #aft = 0;
  /** The world's time, s: what picks an idle on a cruising yacht's bench. */
  #world = 0;
  #plan: CrewPlan | null = null;
  /** Aboard a beach cat, what her people's joints keep over: her net and decks. */
  #floor: ((x: number, z: number) => number | null) | null = null;
  /** Aboard a beach cat: each side's crew's wire drawn to whoever hangs on it, and the model's own (starboard, port). */
  #wires: { mesh: Mesh; node: Object3D | null }[] = [];
  readonly #still: boolean;
  /** Each person's distance from the camera, squared, and the people by it, nearest first. */
  #d2 = new Float64Array(0);
  #order: number[] = [];
  readonly #byDistance = (a: number, b: number): number =>
    (this.#d2[a] as number) - (this.#d2[b] as number);

  constructor(readonly sailorLookOf: (code: number) => SailorLook) {
    this.group.name = 'crew';
    this.#still =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /** The fleet's looks, which the crew is drawn in; until given, nothing is drawn. */
  useLooks(looks: FleetLooks, _capacity = 0): void {
    if (this.#looks !== null || looks.bones === 0) {
      return;
    }
    this.#looks = looks;
    this.#near = new CrewLevel('near', looks.bones, 3 * DECK_TRIANGLES, 12, looks);
    this.#far = new CrewLevel('far', looks.bones, 3 * FAR_TRIANGLES, FAR_FIGURES, looks);
    this.group.add(this.#near.mesh, this.#far.mesh);
    this.#show();
  }

  /** The boat whose crew is drawn: its model and its crew's plan (its stations and deck). */
  aboard(model: Object3D, plan: CrewPlan): void {
    model.add(this.group);
    this.#stations = plan.stations;
    this.#plan = plan;
    this.#floor = plan.cat == null ? null : catFloor(plan.cat);
    this.#level.cog = plan.cog ?? 0;
    this.#level.solid = plan.solid ?? null;
    for (const w of this.#wires) {
      this.group.remove(w.mesh);
    }
    this.#wires = [];
    if (plan.cat?.crewRings != null && plan.cat.hounds !== null) {
      for (const name of ['trapeze-crew-starboard', 'trapeze-crew-port']) {
        const node = model.getObjectByName(name) ?? null;
        const mesh = wireMesh(wireColour(node ?? undefined));
        mesh.visible = false;
        mesh.castShadow = true;
        this.group.add(mesh);
        this.#wires.push({ mesh, node });
      }
    }
    const ship = plan.ship ?? null;
    this.#rules =
      ship === null
        ? new CrewRules(plan)
        : new ShipRules({ stations: plan.stations, ship }, this.#still);
    if (this.braces !== null) {
      this.group.remove(this.braces.mesh);
      this.braces = null;
    }
    if (ship !== null && ship.company.braces.length > 0) {
      this.braces = new ShipBraces(ship.company);
      this.group.add(this.braces.mesh);
    }
    this.#show();
  }

  /** The crew's rules, as they stand: who is where, crossing or changing places; a ship's company's, aboard a ship. */
  get rules(): CrewRules | ShipRules | null {
    return this.#rules;
  }

  /** Aboard a ship, the seat whose look is drawn at the wheel (whoever holds the controls once relieved); null elsewhere. */
  get wheelSeat(): number | null {
    const r = this.#rules;
    return r instanceof ShipRules ? r.wheelSeat : null;
  }

  /** Whether whoever holds the controls is walking to or from the helm: the helm's figure is not drawn meanwhile. */
  get helmAway(): boolean {
    return this.#rules?.helmAway ?? false;
  }

  /** Aboard a beach cat, each side's crew's wire drawn to whoever hangs on it (starboard, port). */
  get wiresDrawn(): [boolean, boolean] {
    return [this.#wires[0]?.mesh.visible === true, this.#wires[1]?.mesh.visible === true];
  }

  /** Aboard a beach cat, whether someone crossing her net is in the helm's way: the helm waits to cross. */
  get helmHeld(): boolean {
    const r = this.#rules;
    return r instanceof CrewRules && r.helmHeld;
  }

  /** The people aboard; null for nobody but the one at the helm. */
  set(crew: CrewShown | null): void {
    this.#crew = crew;
    this.#show();
  }

  /**
   * The boat's moment, each frame before frame(): the rules stepped by it;
   * heel the boat's, radians; how she lies (her pitch, radians, and heave,
   * m) and how far aft of their places her helm stands, m.
   */
  sail(moment: CrewMoment, heel: number, lie = NOT_LYING): void {
    const dt = Math.max(1e-6, moment.dt);
    this.#boomRate = (moment.boom - this.#boom) / dt;
    this.#boom = moment.boom;
    this.#heel = heel;
    this.#level.heel = heel;
    this.#level.pitch = lie.pitch;
    this.#level.heave = lie.heave;
    this.#aft = lie.aft;
    this.#world = moment.ship?.time ?? this.#world + dt;
    this.#rules?.step(moment);
    // Her braces as her yards are now, and the falls those at them haul.
    const rules = this.#rules;
    if (this.braces !== null && rules instanceof ShipRules) {
      this.braces.update(rules.turns, rules.reef, this.#crew === null ? null : rules);
    }
  }

  /** Whether everyone aboard is drawn, in their own look, at the level their distance asks. */
  get ready(): boolean {
    const settled = (s: string): boolean => s === 'ready' || s === 'failed';
    const wanted = (p: Drawn): boolean => p.member.station > 0 || p.member.moving !== null;
    return (
      !this.#dirty &&
      this.#people.every(
        (p) =>
          !wanted(p) ||
          (settled(p.look.state) &&
            settled(p.look.clipsState) &&
            (!p.look.railed || settled(p.look.railState)) &&
            (!p.look.shipped || settled(p.look.shipState)) &&
            (!p.look.aloft || settled(p.look.aloftState)) &&
            (!this.#catted || settled(p.look.catState)) &&
            (!this.#yachted || settled(p.look.cruiserState)) &&
            (!this.#bridged || settled(p.look.bridgeState)) &&
            (p.look.clipsState === 'failed' || (p.shown && p.posed))),
      ) &&
      this.drawn.near + this.drawn.far === this.#people.filter((p) => p.shown).length
    );
  }

  /** How many are drawn beside the one at the helm. */
  get count(): number {
    return this.#people.filter((p) => p.shown).length;
  }

  /**
   * Where each person drawn is in the scene, as they were last posed: their
   * head (its joint), the level they are drawn at, their station, and how
   * far out from the centreline their head is (+ starboard) in the boat's
   * frame.
   */
  heads(): {
    at: Vector3;
    near: boolean;
    station: number;
    across: number;
    moving: boolean;
    seat: number;
    clip: string | null;
    model: [number, number, number];
  }[] {
    const parent = this.group.parent;
    if (parent === null) {
      return [];
    }
    parent.updateMatrixWorld();
    return this.#people
      .filter((p) => p.shown && p.body !== null)
      .map((p) => {
        const head = (p.body as CrewBody).head;
        return {
          at: head.clone().applyMatrix4(parent.matrixWorld),
          near: p.near,
          station: p.member.station,
          across: head.x,
          moving: p.member.moving !== null,
          seat: p.member.seat,
          clip: p.a.clip?.name ?? null,
          model: [head.x, head.y, head.z] as [number, number, number],
        };
      });
  }

  /** Each person drawn's body, with their member under the rules: for tests and hooks. */
  bodies(): { member: CrewMember; body: CrewBody | null; duck: number; near: boolean }[] {
    return this.#people
      .filter((p) => p.shown)
      .map((p) => ({ member: p.member, body: p.body, duck: p.duck, near: p.near }));
  }

  #show(): void {
    const rules = this.#rules;
    if (rules === null) {
      this.#people = [];
      return;
    }
    rules.set(this.#crew, this.#people.length > 0);
    this.#sync();
  }

  /** The members' version of a ship's rules last drawn: a relief changes who is at the wheel and who walks. */
  #version = -1;

  /** Those drawn, as the rules have them aboard: those already met kept. */
  #sync(): void {
    const looks = this.#looks;
    const rules = this.#rules;
    if (rules === null) {
      this.#people = [];
      return;
    }
    if (rules instanceof ShipRules) {
      this.#version = rules.version;
    }
    const before = new Map(this.#people.map((p) => [p.member, p]));
    this.#people = [];
    if (looks !== null) {
      const ship = rules instanceof ShipRules;
      const aloft = this.#stations.some((s) => s.pose === 'aloft');
      if (ship) {
        // Whoever is at the wheel too: relieved, they walk with the crew.
        for (const p of this.#crew?.people ?? []) {
          const l = this.sailorLookOf(p.look);
          looks.want(looks.add(l.art, l.machine), true, false, false, true, aloft);
        }
      }
      for (const member of rules.members) {
        const l = this.sailorLookOf(member.look);
        const look = looks.add(l.art, l.machine);
        // The rail's clips and the crouch for anyone who sits on a rail or
        // moves about; a ship's deck's (and aloft, if she has a top) for
        // anyone aboard a ship.
        const station = this.#stations[member.station];
        const railed =
          !ship &&
          !this.#yachted &&
          (this.#stations.some((s) => s.windward === true || s.pose === 'rail') ||
            station?.pose === 'rail');
        looks.want(
          look,
          true,
          false,
          railed,
          ship,
          ship && aloft,
          this.#catted,
          this.#yachted,
          this.#bridged,
        );
        const was = before.get(member);
        if (was !== undefined && was.look === look) {
          this.#people.push(was);
          continue;
        }
        this.#people.push({
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
          time: (member.seat * 7.31) % 30,
          hold: (member.seat * 7.31) % 30,
          turn: member.seat % FAR_EVERY,
          a: stance(),
          b: stance(),
        });
      }
    }
    this.#d2 = new Float64Array(this.#people.length);
    this.#order = this.#people.map((_, i) => i);
    this.#dirty = true;
  }

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

  /**
   * A frame, dt seconds on, the camera at camera (the scene's): the nearest
   * NEAR_MOST within NEAR_RANGE at the deck level and posed, the rest far,
   * posed in their turn.
   */
  frame(camera: Vector3, dt = 0): void {
    const near = this.#near;
    const far = this.#far;
    const looks = this.#looks;
    if (near === null || far === null || looks === null || this.group.parent === null) {
      return;
    }
    this.#frames++;
    const rules = this.#rules;
    if (rules instanceof ShipRules && rules.version !== this.#version) {
      this.#sync();
    }
    const people = this.#people;
    // Who is drawn: anyone not at the helm, or walking to or from it, once their look can be posed.
    for (const p of people) {
      const l = p.look;
      const done = (s: string): boolean => s === 'ready' || s === 'failed';
      const can =
        l.deck !== null &&
        l.clips !== null &&
        l.clipsState === 'ready' &&
        (!l.railed || done(l.railState)) &&
        (!l.shipped || done(l.shipState)) &&
        (!l.aloft || done(l.aloftState)) &&
        (!this.#catted || done(l.catState)) &&
        (!this.#yachted || done(l.cruiserState)) &&
        (!this.#bridged || done(l.bridgeState));
      const shown = can && (p.member.station > 0 || p.member.moving !== null);
      if (shown && p.body === null && l.deck !== null) {
        p.body = new CrewBody(l.deck, 1 + p.member.seat * 977 + l.index * 31, l.machine);
        p.posed = false;
      }
      if (shown !== p.shown) {
        p.shown = shown;
        this.#dirty = true;
      }
    }
    // Who is near, as the boat was last drawn.
    const model = this.group.parent.matrixWorld;
    const d2 = this.#d2;
    for (let i = 0; i < people.length; i++) {
      const p = people[i] as Drawn;
      const at = p.body?.root ?? null;
      d2[i] =
        at === null
          ? Number.POSITIVE_INFINITY
          : world.setFromMatrixPosition(at).applyMatrix4(model).distanceToSquared(camera);
    }
    const order = this.#order;
    order.sort(this.#byDistance);
    let shownNear = 0;
    for (let k = 0; k < order.length; k++) {
      const p = people[order[k] as number] as Drawn;
      const wantNear =
        p.shown &&
        shownNear < NEAR_MOST &&
        (d2[order[k] as number] as number) < NEAR_RANGE * NEAR_RANGE;
      if (wantNear) {
        shownNear++;
      }
      if (wantNear !== p.near) {
        p.near = wantNear;
        this.#dirty = true;
      }
    }
    // Each person posed: the near every frame, the far in their turn.
    const t0 = performance.now();
    plumbOf(this.group.parent.matrixWorld, this.#up);
    for (const p of people) {
      if (!p.shown || p.body === null) {
        continue;
      }
      p.wait += dt;
      p.time += dt;
      this.#duck(p, dt);
      if (p.near || !p.posed || (this.#frames + p.turn) % FAR_EVERY === 0) {
        this.#pose(p, p.wait);
        p.wait = 0;
        p.posed = true;
        this.stats.posed++;
      }
    }
    this.stats.frames++;
    this.stats.ms += performance.now() - t0;
    this.#drawWires();
    if (this.#dirty) {
      this.#dirty = false;
      this.#pool(near, far, looks.seat);
    }
    this.#rows(near, this.#nearRows);
    this.#rows(far, this.#farRows);
  }

  /** Whether the boat is a beach cat, whose people are drawn with her own clips. */
  get #catted(): boolean {
    return this.#plan?.cat != null;
  }

  /** Whether the boat is a cruising yacht, whose people are drawn with her own clips. */
  get #yachted(): boolean {
    return this.#plan?.yacht != null;
  }

  /** Whether the boat is a cruising catamaran, whose people are drawn with her own clips. */
  get #bridged(): boolean {
    return this.#plan?.bridge != null;
  }

  /**
   * Aboard a beach cat, each side's crew's wire: from the hounds to the hips
   * of whoever hangs on it, out on the wire (and not moving about or in the
   * water), the model's own on that side hidden; else the model's hanging.
   */
  #drawWires(): void {
    const cat = this.#plan?.cat ?? null;
    if (this.#wires.length !== 2 || cat === null || cat.hounds === null) {
      return;
    }
    for (let k = 0; k < 2; k++) {
      const side = k === 0 ? 1 : -1;
      const w = this.#wires[k] as { mesh: Mesh; node: Object3D | null };
      const on = this.#people.find(
        (p) =>
          p.shown &&
          p.body !== null &&
          p.member.moving === null &&
          (p.member.wet ?? null) === null &&
          p.member.lean >= WIRE_HOOKED &&
          p.member.side === side &&
          this.#stations[p.member.station]?.pose === 'hull',
      );
      w.mesh.visible = on !== undefined;
      if (w.node !== null) {
        w.node.visible = on === undefined;
      }
      if (on?.body != null) {
        setWire(w.mesh, cat.hounds, on.body.hips);
      }
    }
  }

  /** The duck: down quickly as the boom comes near the head (or will in a moment), up slowly after. */
  #duck(p: Drawn, dt: number): void {
    const rules = this.#rules;
    if (!(rules instanceof CrewRules) || p.body === null || !p.posed) {
      return;
    }
    p.duck = duckStep(p.duck, duckFor(rules.plan, this.#boom, this.#boomRate, p.body.headUp), dt);
  }

  /** Poses a person for what they are doing, dt seconds since they were last posed. */
  #pose(p: Drawn, dt: number): void {
    const seat = this.#looks?.seat;
    const clips = p.look.clips;
    if (seat === undefined || clips === null) {
      return;
    }
    const rules = this.#rules;
    if (rules instanceof ShipRules) {
      const s = this.#shipInput;
      s.rules = rules;
      s.clips = clips;
      s.machine = p.look.machine;
      s.time = this.#still ? p.hold : p.time;
      s.world = rules.time;
      s.life.dt = dt;
      s.life.heel = this.#heel;
      s.life.upright = 0;
      s.life.still = this.#still;
      s.a = p.a;
      s.b = p.b;
      if (!poseShip(p.body as CrewBody, p.member as ShipMember, s)) {
        p.body?.hide();
      }
      return;
    }
    const input = this.#input;
    input.stations = this.#stations;
    input.seat = seat;
    input.clips = clips;
    // Under reduced motion, the clips held: breathing only, but for moving about.
    input.time = this.#still ? p.hold : p.time;
    input.duck = p.duck;
    input.life.dt = dt;
    input.life.heel = this.#heel;
    input.life.upright = 0.5;
    input.life.still = this.#still;
    input.a = p.a;
    input.b = p.b;
    input.cat = this.#plan?.cat ?? null;
    input.aft = this.#aft;
    input.level = this.#level;
    input.life.floor = this.#floor;
    input.cruiser = this.#plan?.yacht ?? null;
    input.world = this.#world;
    input.machine = p.look.machine;
    input.ways = this.#plan === null ? null : waysOf(this.#plan);
    input.bridge = this.#plan?.bridge?.boat ?? null;
    poseMember(p.body as CrewBody, p.member, input);
  }

  /** The vertical in the boat's model's frame, kept within the sea legs' reach: what a ship's standing people are kept plumb to. */
  readonly #up = new Vector3(0, 1, 0);

  readonly #shipInput: ShipPoseInput = {
    rules: null as unknown as ShipRules,
    clips: new Map(),
    machine: false,
    time: 0,
    world: 0,
    life: { dt: 0, heel: 0, upright: 0, still: false, plumb: null },
    up: this.#up,
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

  /** The levels' figures pooled for those drawn at each. */
  #pool(near: CrewLevel, far: CrewLevel, seat: FleetSeat): void {
    const nearKeys: string[] = [];
    const farKeys: string[] = [];
    this.#nearRows = [];
    this.#farRows = [];
    for (const p of this.#people) {
      if (!p.shown || p.body === null) {
        continue;
      }
      const look = p.look;
      if (p.near && look.deck !== null) {
        const key = `deck ${look.index}`;
        if (this.#figure(key, () => (look.deck === null ? null : deckFigure(look.deck))) !== null) {
          nearKeys.push(key);
          this.#nearRows.push(p);
          continue;
        }
      }
      p.near = false;
      const key = `far ${look.index}`;
      if (this.#figure(key, () => farFigure(look, seat)) !== null) {
        farKeys.push(key);
        this.#farRows.push(p);
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
          const worn = this.#crew?.people.find((q) => q.seat === p.member.seat)?.cockade === true;
          level.head(r, placed, p.colours, p.look.layer, p.look.machine, worn);
          level.frame(r, null);
        }
      });
      level.commit(rows.length, keys);
    }
    let tn = 0;
    let tf = 0;
    for (const k of nearKeys) {
      tn += (near.pool.placed.get(k)?.count ?? 0) / 3;
    }
    for (const k of farKeys) {
      tf += (far.pool.placed.get(k)?.count ?? 0) / 3;
    }
    this.drawn = {
      near: this.#nearRows.length,
      far: this.#farRows.length,
      nearTriangles: tn,
      farTriangles: tf,
    };
  }

  /** Each row's bones, as their person was last posed. */
  #rows(level: CrewLevel, rows: readonly Drawn[]): void {
    if (rows.length === 0) {
      return;
    }
    for (let r = 0; r < rows.length; r++) {
      const body = (rows[r] as Drawn).body;
      if (body !== null) {
        level.bonesAt(r, body.bones);
      }
    }
    level.touch();
  }

  /** Frames drawn, people posed and the milliseconds posing them took, counted until read and reset. */
  stats = { frames: 0, posed: 0, ms: 0 };

  /**
   * How many were drawn at each level at the last change, and their
   * figures' triangles (the draws' own count is more: every instance runs
   * its level's largest figure's vertices, those past its own folded).
   */
  drawn = { near: 0, far: 0, nearTriangles: 0, farTriangles: 0 };
}
