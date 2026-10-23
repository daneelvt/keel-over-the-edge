// SPDX-License-Identifier: AGPL-3.0-only

// Prediction against the server (Gambetta, "Fast-Paced Multiplayer";
// Fiedler, "What Every Programmer Needs to Know About Game Networking"):
// the player's boat is stepped ahead of the server, with the physics module
// the server runs, and each step's controls and resulting state are kept
// for 64 ticks. Each snapshot is compared with the state predicted for its
// tick: equal to the bit, as it is whenever the inputs reached the server
// in time, nothing happens; otherwise the boat is put back to the server's
// state and stepped again to the present with the controls kept, and the
// difference that makes to the drawn boat is eased away over 100 ms (drawn
// at once past 3 m or 20°). Each step sails in the sea of its own tick,
// which the server says a second ahead (seas.ts), and in the wind at the
// boat at that tick, computed from the spells of weather the server sends
// (weather.ts) as the server computes it, so neither the waves nor the wind
// cause a correction; the current there too, from the world's way round the
// disk and the ground the module holds. A boat whose centre crosses the lip
// is held there, unstepped, from the tick it crossed, as the server holds
// it while it falls; a snapshot after the fall that does not say it is
// falling is the boat back at the start, and the prediction starts again
// from it. A boat that stays where it is while its owner's free camera
// roams is held so too, as the server holds it, and the first snapshot that
// lets it go starts the prediction again from it. The Go test client
// predicts the same way
// (internal/client/predict.go), and the tests replay its traces here.

import type { BoatPhysics, Encounters, Weather } from '../catalog/types.gen';
import type { BoatDriver } from '../game/driver';
import { PILOT_IDLE, type PilotControl } from '../input/pilot';
import type { OwnSnapshot } from '../net/snapshot';
import { type BoatPose, StatePair } from './blend';
import { RECORDS, SIZES } from './layout.gen';
import {
  writeCloudParams,
  writeEncounterParams,
  writeParams,
  writeSeaParams,
  writeWeatherParams,
} from './params.gen';
import type { Physics } from './physics';
import { Seas } from './seas';
import { Wakes } from './wakes';
import {
  type BoatWind,
  newBoatWind,
  Spells,
  systemKindRecord,
  type VisibilityWorld,
  writeForecastParams,
  writeVisibilityParams,
} from './weather';

/** Ticks of prediction kept. */
export const RING = 64;
/** Corrections drawn at once rather than eased: metres, and radians. */
export const SNAP_DISTANCE = 3;
export const SNAP_HEADING = (20 * Math.PI) / 180;
/** The eased offset's time constant, seconds. */
export const SMOOTHING = 0.1;

const S = RECORDS.state;
const N = SIZES.state;

/** What a snapshot did to the prediction. */
export interface Outcome {
  /** Older than the ticks kept: it changed nothing. */
  stale: boolean;
  /** The prediction started again from it. */
  reset: boolean;
  corrected: boolean;
  /** How far the present tick's boat moved in the replay, metres and radians. */
  distance: number;
  heading: number;
}

/** The helm, −1 … 1, of an index 0 … 1024: exactly as the server decodes it. */
export function helmOf(index: number): number {
  return (index - 512) / 512;
}

/** The sheet, 0 … 1, of an index 0 … 1024. */
export function sheetOf(index: number): number {
  return index / 1024;
}

/** The index of a control already at the controls' resolution. */
export function helmIndex(helm: number): number {
  return Math.round((helm + 1) * 512);
}

export function sheetIndex(sheet: number): number {
  return Math.round(sheet * 1024);
}

/**
 * Readies a physics module for a kind of boat in the catalog's weather:
 * every record cleared, the sea's waves derived, then the boat's constants,
 * the wind's, the visibility's and, if given, the encounters'. No spell of weather is in play
 * until one is set.
 */
export function preparePhysics(
  physics: Physics,
  boat: BoatPhysics,
  weather: Weather,
  world: VisibilityWorld,
  encounters?: Encounters,
): void {
  const r = physics.records;
  for (const v of Object.values(r)) {
    v.fill(0);
  }
  writeSeaParams(r.seaParams, weather.sea);
  physics.prepareSea();
  writeParams(physics.records.params, boat);
  physics.prepare();
  writeWeatherParams(physics.records.weatherParams, weather);
  physics.prepareWeather();
  physics.setSystemKinds(weather.systems.map(systemKindRecord));
  writeCloudParams(physics.records.cloudParams, weather.clouds);
  physics.prepareClouds(weather.regimes.map((g) => g.cumulus));
  writeVisibilityParams(physics.records.visibilityParams, weather, world);
  physics.prepareVisibility();
  writeForecastParams(physics.records.forecastParams, weather);
  physics.prepareForecast();
  if (encounters !== undefined) {
    prepareEncounters(physics, encounters);
  }
  physics.setSpells([]);
}

/** Readies a physics module's encounters: the shadow, contacts and the Articles. */
export function prepareEncounters(physics: Physics, encounters: Encounters): void {
  writeEncounterParams(physics.records.encounterParams, encounters);
  physics.prepareEncounters();
}

function wrapAngle(a: number): number {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
}

export class Predictor implements BoatDriver {
  readonly states = new StatePair();
  readonly out = new Float64Array(SIZES.out);
  readonly wind: BoatWind = newBoatWind();
  started = false;
  /** The tick the boat's state is after. */
  tick = 0;
  /**
   * Counts, for the developer panel and the tests; shadowed is the steps
   * another boat's wake reached, whose shadow the snapshots' samples only
   * approximate.
   */
  readonly counts = { snapshots: 0, corrections: 0, resets: 0, stale: 0, largest: 0, shadowed: 0 };
  /** The last 200 corrections' distances, for the 95th percentile. */
  readonly sizes: number[] = [];
  /** How many steps pushed the boat off the ground. */
  pushes = 0;
  /** The tick the boat went over the lip, 0 while it is afloat: held there, unstepped. */
  over = 0;
  /** How many times a snapshot has put the boat back at the start after going over. */
  restarts = 0;
  /** The boat stays where it is while its owner's free camera roams: held, unstepped. */
  stays = false;

  /** The sea the boat is stepped in, from the server's SeaAreas. */
  readonly seas: Seas;
  /** The spells of weather whose wind the boat is stepped in, from the server's WeatherSystems. */
  readonly weather: Spells;
  /** The other boats' wakes, from the snapshots, whose shadow each step sails in. */
  readonly wakes: Wakes;

  readonly #physics: Physics;
  readonly #ticks = new Float64Array(RING).fill(Number.NaN);
  readonly #helm = new Uint16Array(RING);
  readonly #sheet = new Uint16Array(RING);
  /** Each tick's autopilot control: mode, way and order count, and target. */
  readonly #pilot = new Uint8Array(RING * 3);
  readonly #target = new Uint16Array(RING);
  readonly #ring = new Float64Array(RING * N);
  readonly #before = new Float64Array(N);
  /** The drawn boat's offset from the predicted one, eased away. */
  readonly offset = { east: 0, north: 0, heading: 0 };

  constructor(
    physics: Physics,
    boat: BoatPhysics,
    weather: Weather,
    world: VisibilityWorld,
    encounters?: Encounters,
  ) {
    this.#physics = physics;
    preparePhysics(physics, boat, weather, world, encounters);
    this.seas = new Seas(physics);
    this.weather = new Spells(physics);
    this.wakes = new Wakes(physics);
  }

  /** The physics module, for whoever draws its sea. */
  get physics(): Physics {
    return this.#physics;
  }

  /** The physics module's records (the developer panel). */
  get records(): Physics['records'] {
    return this.#physics.records;
  }

  /** Sets the world's way round the disk, from the Welcome, for the current the boat is stepped in. */
  setCirculation(way: number): void {
    this.#physics.circulation(way);
    this.seas.recirculate();
  }

  /** The boat at a snapshot's state, what was predicted forgotten. */
  reset(sn: OwnSnapshot): void {
    this.started = true;
    this.tick = sn.tick;
    this.over = sn.over;
    this.stays = sn.stays;
    this.#physics.records.state.set(sn.state);
    this.weather.read(sn.tick, sn.state[S.x] ?? 0, sn.state[S.y] ?? 0, this.wind);
    this.#ticks.fill(Number.NaN);
    this.states.hold(sn.state);
    this.offset.east = 0;
    this.offset.north = 0;
    this.offset.heading = 0;
    this.counts.resets++;
  }

  /**
   * Steps the boat into tick, in the wind and the current at its place and
   * the sea of that tick, as the server does; a boat over the lip is held.
   */
  #stepModule(
    tick: number,
    helm: number,
    sheet: number,
    mode: number,
    target: number,
    order: number,
    way: number,
  ): void {
    const r = this.#physics.records;
    const c = r.control;
    c[RECORDS.control.helm] = helmOf(helm);
    c[RECORDS.control.sheet] = sheetOf(sheet);
    c[RECORDS.control.pilot] = mode;
    c[RECORDS.control.target] = target;
    c[RECORDS.control.order] = order;
    c[RECORDS.control.way] = way;
    if (this.over !== 0 || this.stays) {
      return;
    }
    this.weather.use(tick);
    this.wakes.use(tick);
    this.seas.use(tick);
    this.#physics.step();
    if (this.#physics.over()) {
      this.over = tick;
    }
  }

  /** Steps the next tick with the controls' indices and the autopilot's control. */
  stepIndices(helm: number, sheet: number, pilot: PilotControl = PILOT_IDLE): void {
    const before = this.#physics.records.state;
    // The wind the step sails in is the wind where the boat is as it begins.
    this.weather.read(this.tick + 1, before[S.x] ?? 0, before[S.y] ?? 0, this.wind);
    this.#stepModule(this.tick + 1, helm, sheet, pilot.mode, pilot.target, pilot.order, pilot.way);
    if (this.wakes.reaching > 0) {
      this.counts.shadowed++;
      // The wind the step sailed in, in the shadow of the boats near.
      const env = this.#physics.records.env;
      this.wind.shadowSpeed = env[RECORDS.env.windSpeed] ?? 0;
      this.wind.shadowFrom = env[RECORDS.env.windFrom] ?? 0;
    }
    this.tick++;
    const i = this.tick % RING;
    const r = this.#physics.records;
    this.#ticks[i] = this.tick;
    this.#helm[i] = helm;
    this.#sheet[i] = sheet;
    this.#pilot[3 * i] = pilot.mode;
    this.#pilot[3 * i + 1] = pilot.way;
    this.#pilot[3 * i + 2] = pilot.order;
    this.#target[i] = pilot.target;
    this.#ring.set(r.state, i * N);
    this.out.set(r.out);
    if ((r.out[RECORDS.out.pushedOff] ?? 0) !== 0) {
      // Up to 40 m in a step: drawn where it is, not slid there.
      this.pushes++;
      this.states.hold(r.state);
    } else {
      this.states.push(r.state);
    }
  }

  /** A BoatDriver's step: controls already at their resolution. */
  step(helm: number, sheet: number, pilot: PilotControl = PILOT_IDLE): void {
    this.stepIndices(helmIndex(helm), sheetIndex(sheet), pilot);
  }

  readonly #outcome: Outcome = {
    stale: false,
    reset: false,
    corrected: false,
    distance: 0,
    heading: 0,
  };

  /**
   * Reconciles the prediction with a snapshot. The outcome is a record the
   * predictor reuses: read it before the next snapshot.
   */
  snapshot(sn: OwnSnapshot): Outcome {
    const o = this.#outcome;
    o.stale = false;
    o.reset = false;
    o.corrected = false;
    o.distance = 0;
    o.heading = 0;
    this.counts.snapshots++;
    if (this.started && sn.tick <= this.tick - RING) {
      o.stale = true;
      this.counts.stale++;
      return o;
    }
    const i = sn.tick % RING;
    if (
      !this.started ||
      sn.tick > this.tick ||
      this.#ticks[i] !== sn.tick ||
      (this.over !== 0 && sn.over === 0 && sn.tick > this.over) ||
      (this.stays && !sn.stays)
    ) {
      if (this.over !== 0 && sn.over === 0 && sn.tick > this.over) {
        this.restarts++;
      }
      this.reset(sn);
      o.reset = true;
      return o;
    }
    const r = this.#physics.records;
    if (sn.over !== 0 || sn.stays) {
      // The server's boat is falling, held where it went over; or stays
      // where it is.
      if (
        this.over === sn.over &&
        this.stays === sn.stays &&
        this.#same(this.tick % RING, sn.state)
      ) {
        return o;
      }
      this.#before.set(r.state);
      this.over = sn.over;
      this.stays = sn.stays;
      r.state.set(sn.state);
      for (let t = sn.tick; t <= this.tick; t++) {
        this.#ring.set(sn.state, (t % RING) * N);
      }
      this.states.hold(sn.state);
      return this.#corrected(o, r.state);
    }
    if (this.#same(i, sn.state)) {
      return o;
    }
    this.#before.set(r.state);
    r.state.set(sn.state);
    this.over = 0;
    this.#ring.set(sn.state, i * N);
    for (let t = sn.tick + 1; t <= this.tick; t++) {
      const j = t % RING;
      const p = this.#pilot;
      this.#stepModule(
        t,
        this.#helm[j] ?? 512,
        this.#sheet[j] ?? 512,
        p[3 * j] ?? 0,
        this.#target[j] ?? 0,
        p[3 * j + 2] ?? 0,
        p[3 * j + 1] ?? 0,
      );
      this.#ring.set(r.state, j * N);
    }
    const prev = (this.tick - 1) % RING;
    if (this.tick - 1 >= sn.tick) {
      this.states.previous.set(this.#ring.subarray(prev * N, prev * N + N));
    }
    this.states.current.set(r.state);
    this.out.set(r.out);
    return this.#corrected(o, r.state);
  }

  /** Counts a correction from the state before it to s, and eases or snaps the drawn boat. */
  #corrected(o: Outcome, s: Float64Array): Outcome {
    const b = this.#before;
    const dx = (b[S.x] ?? 0) - (s[S.x] ?? 0);
    const dy = (b[S.y] ?? 0) - (s[S.y] ?? 0);
    const dh = wrapAngle((b[S.heading] ?? 0) - (s[S.heading] ?? 0));
    o.corrected = true;
    o.distance = Math.hypot(dx, dy);
    o.heading = Math.abs(dh);
    this.counts.corrections++;
    this.counts.largest = Math.max(this.counts.largest, o.distance);
    this.sizes.push(o.distance);
    if (this.sizes.length > 200) {
      this.sizes.shift();
    }
    if (o.distance > SNAP_DISTANCE || o.heading > SNAP_HEADING) {
      this.offset.east = 0;
      this.offset.north = 0;
      this.offset.heading = 0;
    } else {
      this.offset.east += dx;
      this.offset.north += dy;
      this.offset.heading += dh;
    }
    return o;
  }

  /** Whether the state kept in slot i is s, bit for bit (-0 is not 0). */
  #same(i: number, s: Float64Array): boolean {
    for (let k = 0; k < N; k++) {
      const x = this.#ring[i * N + k] ?? 0;
      const y = s[k] ?? 0;
      if (x !== y || Object.is(x, -0) !== Object.is(y, -0)) {
        return false;
      }
    }
    return true;
  }

  /** Moves the drawn pose by the offset, and eases the offset over dt seconds. */
  decorate(pose: BoatPose, dt: number): void {
    const o = this.offset;
    pose.east += o.east;
    pose.north += o.north;
    pose.heading += o.heading;
    const k = Math.exp(-Math.max(0, dt) / SMOOTHING);
    o.east *= k;
    o.north *= k;
    o.heading *= k;
  }

  /** The 95th percentile of the recent corrections' distances. */
  p95(): number {
    if (this.sizes.length === 0) {
      return 0;
    }
    const v = [...this.sizes].sort((a, b) => a - b);
    return v[Math.min(v.length - 1, Math.ceil(0.95 * v.length) - 1)] ?? 0;
  }
}
