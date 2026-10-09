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
// at once past 3 m or 20°). The Go test client predicts the same way
// (internal/edge/edgetest/predict.go), and the tests replay its traces here.

import type { BoatPhysics } from '../catalog/types.gen';
import type { BoatDriver, Wind } from '../game/driver';
import type { OwnSnapshot } from '../net/snapshot';
import { type BoatPose, StatePair } from './blend';
import { RECORDS, SIZES } from './layout.gen';
import { writeParams } from './params.gen';
import type { Physics } from './physics';

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

function wrapAngle(a: number): number {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
}

export class Predictor implements BoatDriver {
  readonly states = new StatePair();
  readonly out = new Float64Array(SIZES.out);
  readonly wind: Wind = { speed: 0, from: 0 };
  started = false;
  /** The tick the boat's state is after. */
  tick = 0;
  /** Counts, for the developer panel and the tests. */
  readonly counts = { snapshots: 0, corrections: 0, resets: 0, stale: 0, largest: 0 };
  /** The last 200 corrections' distances, for the 95th percentile. */
  readonly sizes: number[] = [];

  readonly #physics: Physics;
  readonly #ticks = new Float64Array(RING).fill(Number.NaN);
  readonly #helm = new Uint16Array(RING);
  readonly #sheet = new Uint16Array(RING);
  readonly #ring = new Float64Array(RING * N);
  readonly #before = new Float64Array(N);
  /** The drawn boat's offset from the predicted one, eased away. */
  readonly offset = { east: 0, north: 0, heading: 0 };

  constructor(physics: Physics, boat: BoatPhysics) {
    this.#physics = physics;
    const r = physics.records;
    for (const v of Object.values(r)) {
      v.fill(0);
    }
    writeParams(r.params, boat);
    physics.prepare();
  }

  /** The physics module's records (the developer panel). */
  get records(): Physics['records'] {
    return this.#physics.records;
  }

  /** The boat at a snapshot's state, what was predicted forgotten. */
  reset(sn: OwnSnapshot): void {
    this.started = true;
    this.tick = sn.tick;
    this.#physics.records.state.set(sn.state);
    this.wind.speed = sn.windSpeed;
    this.wind.from = sn.windFrom;
    this.#ticks.fill(Number.NaN);
    this.states.hold(sn.state);
    this.offset.east = 0;
    this.offset.north = 0;
    this.offset.heading = 0;
    this.counts.resets++;
  }

  #stepModule(helm: number, sheet: number): void {
    const r = this.#physics.records;
    r.control[RECORDS.control.helm] = helmOf(helm);
    r.control[RECORDS.control.sheet] = sheetOf(sheet);
    r.env[RECORDS.env.windSpeed] = this.wind.speed;
    r.env[RECORDS.env.windFrom] = this.wind.from;
    this.#physics.step();
  }

  /** Steps the next tick with the controls' indices. */
  stepIndices(helm: number, sheet: number): void {
    this.#stepModule(helm, sheet);
    this.tick++;
    const i = this.tick % RING;
    const r = this.#physics.records;
    this.#ticks[i] = this.tick;
    this.#helm[i] = helm;
    this.#sheet[i] = sheet;
    this.#ring.set(r.state, i * N);
    this.states.push(r.state);
    this.out.set(r.out);
  }

  /** A BoatDriver's step: controls already at their resolution. */
  step(helm: number, sheet: number): void {
    this.stepIndices(helmIndex(helm), sheetIndex(sheet));
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
    if (!this.started || sn.tick > this.tick || this.#ticks[i] !== sn.tick) {
      this.reset(sn);
      o.reset = true;
      return o;
    }
    this.wind.speed = sn.windSpeed;
    this.wind.from = sn.windFrom;
    if (this.#same(i, sn.state)) {
      return o;
    }
    const r = this.#physics.records;
    this.#before.set(r.state);
    r.state.set(sn.state);
    this.#ring.set(sn.state, i * N);
    for (let t = sn.tick + 1; t <= this.tick; t++) {
      const j = t % RING;
      this.#stepModule(this.#helm[j] ?? 512, this.#sheet[j] ?? 512);
      this.#ring.set(r.state, j * N);
    }
    const prev = (this.tick - 1) % RING;
    if (this.tick - 1 >= sn.tick) {
      this.states.previous.set(this.#ring.subarray(prev * N, prev * N + N));
    }
    this.states.current.set(r.state);
    this.out.set(r.out);
    const b = this.#before;
    const dx = (b[S.x] ?? 0) - (r.state[S.x] ?? 0);
    const dy = (b[S.y] ?? 0) - (r.state[S.y] ?? 0);
    const dh = wrapAngle((b[S.heading] ?? 0) - (r.state[S.heading] ?? 0));
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

  /** The state predicted for tick, or null if it is not among the ticks kept (the tests). */
  stateAt(tick: number): Float64Array | null {
    const i = tick % RING;
    if (this.#ticks[i] !== tick) {
      return null;
    }
    return this.#ring.slice(i * N, i * N + N);
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
