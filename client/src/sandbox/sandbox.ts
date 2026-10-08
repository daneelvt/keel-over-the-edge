// SPDX-License-Identifier: AGPL-3.0-only

// The offline sandbox: one boat, stepped by the physics module in the
// page, in a steady wind that is the same everywhere. No server corrects
// it. It is the game's page until the game connects to a server, and stays
// reachable with ?sandbox afterwards, as a tool.

import type { BoatPhysics } from '../catalog/types.gen';
import type { BoatDriver, Wind } from '../game/driver';
import { StatePair } from '../predict/blend';
import { RECORDS, SIZES } from '../predict/layout.gen';
import { writeParams } from '../predict/params.gen';
import { loadPhysics, type Physics, type PhysicsSource } from '../predict/physics';
import { Recorder, type Recording } from './record';

const S = RECORDS.state;
/** One knot, in m/s. */
export const KNOT = 1852 / 3600;

export interface SandboxStart {
  /** World position, metres east and north of the disk's centre. */
  east: number;
  north: number;
  /** Clockwise from north, radians. */
  heading: number;
  helm: number;
  sheet: number;
  wind: Wind;
}

/**
 * The start: the disk's centre, at rest, heading 090°, the helm centred and
 * the sheet half out, in 10 knots from the north. A beam reach in a breeze
 * the full rig carries without depowering.
 */
export const START: SandboxStart = {
  east: 0,
  north: 0,
  heading: Math.PI / 2,
  helm: 0,
  sheet: 0.5,
  wind: { speed: 10 * KNOT, from: 0 },
};

/** Reads ?wind=knots,degrees-from: the sandbox's wind, or null. */
export function windFromQuery(query: URLSearchParams): Wind | null {
  const raw = query.get('wind');
  if (raw === null) {
    return null;
  }
  const [knots, from] = raw.split(',').map(Number);
  if (knots === undefined || !Number.isFinite(knots) || knots < 0) {
    return null;
  }
  const deg = from !== undefined && Number.isFinite(from) ? from : 0;
  return { speed: knots * KNOT, from: (((deg % 360) + 360) % 360) * (Math.PI / 180) };
}

export class Sandbox implements BoatDriver {
  readonly states = new StatePair();
  readonly out = new Float64Array(SIZES.out);
  readonly wind: Wind;
  readonly recorder = new Recorder();
  readonly start: SandboxStart;
  /** Whether the sail is being recorded (the developer panel turns it on). */
  recording = false;

  readonly #physics: Physics;

  constructor(physics: Physics, boat: BoatPhysics, start: SandboxStart = START) {
    this.#physics = physics;
    this.start = start;
    this.wind = { ...start.wind };
    const r = physics.records;
    for (const v of Object.values(r)) {
      v.fill(0);
    }
    writeParams(r.params, boat);
    physics.prepare();
    this.reset();
  }

  /** The physics module's records, for the developer panel and the tests. */
  get records(): Physics['records'] {
    return this.#physics.records;
  }

  /** Back to the start, at rest, and a new recording. */
  reset(): void {
    const r = this.#physics.records;
    r.state.fill(0);
    r.out.fill(0);
    r.state[S.x] = this.start.east;
    r.state[S.y] = this.start.north;
    r.state[S.heading] = this.start.heading;
    r.control[RECORDS.control.helm] = this.start.helm;
    r.control[RECORDS.control.sheet] = this.start.sheet;
    this.out.fill(0);
    this.#settle();
  }

  /**
   * Puts the boat at a world position and heading, keeping its motion. A
   * recording starts again from there.
   */
  place(east: number, north: number, heading: number): void {
    const s = this.#physics.records.state;
    s[S.x] = east;
    s[S.y] = north;
    s[S.heading] = wrap(heading);
    this.#settle();
  }

  /** Sets any of the state's fields by name (tests and the panel). */
  setState(values: Record<string, number>): void {
    const s = this.#physics.records.state;
    const fields: Record<string, number> = S;
    for (const [name, v] of Object.entries(values)) {
      const i = fields[name];
      if (i === undefined) {
        throw new Error(`state has no field ${name}`);
      }
      s[i] = v;
    }
    this.#settle();
  }

  setWind(speed: number, from: number): void {
    this.wind.speed = speed;
    this.wind.from = from;
  }

  step(helm: number, sheet: number): void {
    const r = this.#physics.records;
    this.recorder.step(helm, sheet, this.wind.speed, this.wind.from);
    r.control[RECORDS.control.helm] = helm;
    r.control[RECORDS.control.sheet] = sheet;
    r.env[RECORDS.env.windSpeed] = this.wind.speed;
    r.env[RECORDS.env.windFrom] = this.wind.from;
    this.#physics.step();
    // The module's memory never grows while stepping, so the views stay valid.
    const after = this.#physics.records;
    this.states.push(after.state);
    this.out.set(after.out);
  }

  /**
   * Starts recording the sail from the boat as it is now; every reset or
   * placing starts again. Off by default, since a recording keeps every
   * change of control.
   */
  record(): void {
    this.recording = true;
    const r = this.#physics.records;
    this.recorder.start(r.state, r.control, r.env);
  }

  /** The sail since recording started, or the last reset or placing, as a golden scenario. */
  recorded(name: string): Recording {
    const r = this.#physics.records;
    return this.recorder.recording(name, r.params, r.state);
  }

  #settle(): void {
    const r = this.#physics.records;
    r.env[RECORDS.env.windSpeed] = this.wind.speed;
    r.env[RECORDS.env.windFrom] = this.wind.from;
    this.states.hold(r.state);
    if (this.recording) {
      this.recorder.start(r.state, r.control, r.env);
    }
  }
}

/** Compiles the physics module and starts a sandbox for a boat. */
export async function startSandbox(
  source: PhysicsSource,
  boat: BoatPhysics,
  start: SandboxStart = START,
): Promise<Sandbox> {
  return new Sandbox(await loadPhysics(source), boat, start);
}

function wrap(a: number): number {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI;
}
