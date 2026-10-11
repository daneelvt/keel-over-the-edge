// SPDX-License-Identifier: AGPL-3.0-only

// The offline sandbox: one boat, stepped by the physics module in the
// page, in a steady wind that is the same everywhere and the sea it raises
// (localsea.ts). No server corrects it. It is the game's page until the
// game connects to a server, and stays reachable with ?sandbox afterwards,
// as a tool.

import type { BoatPhysics, WeatherSea } from '../catalog/types.gen';
import type { BoatDriver, Wind } from '../game/driver';
import { StatePair } from '../predict/blend';
import { RECORDS, SIZES } from '../predict/layout.gen';
import { loadPhysics, type Physics, type PhysicsSource } from '../predict/physics';
import { preparePhysics } from '../predict/predictor';
import { Seas } from '../predict/seas';
import { LocalSea } from './localsea';
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

/** The winds of the sea states the look was chosen in, in knots: ?sea=calm and so on. */
export const SEA_STATES: Record<string, number> = { calm: 6, breeze: 12, fresh: 20, gale: 34 };

/** Reads ?sea=calm|breeze|fresh|gale: that state's wind from the north, or null. */
export function seaFromQuery(query: URLSearchParams): Wind | null {
  const knots = SEA_STATES[query.get('sea') ?? ''];
  return knots === undefined ? null : { speed: knots * KNOT, from: 0 };
}

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
  /** The sea about the boat, as the physics module holds it, and what makes it. */
  readonly seas: Seas;
  readonly sea: LocalSea;
  /**
   * The world clock the boat is drawn by, once the game has it. The state
   * after a step is drawn as the clock passes on to the next one, so a step
   * taken at the clock's step n sails into tick n + 2: then the boat and the
   * sea drawn under it are of the same time.
   */
  clock: { readonly steps: number } | null = null;
  /** The tick the boat's state is after. */
  tick = 1;

  readonly #physics: Physics;
  readonly #boat: BoatPhysics;
  /** The wind as the last step had it: what the sea's next second is fixed from. */
  readonly #windBefore: Wind;

  constructor(physics: Physics, boat: BoatPhysics, sea: WeatherSea, start: SandboxStart = START) {
    this.#physics = physics;
    this.#boat = boat;
    this.start = start;
    this.wind = { ...start.wind };
    this.#windBefore = { ...start.wind };
    preparePhysics(physics, boat, sea);
    this.seas = new Seas(physics);
    this.sea = new LocalSea(physics, this.seas);
    this.reset();
  }

  /** The physics module, for whoever draws its sea. */
  get physics(): Physics {
    return this.#physics;
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

  /**
   * Raises the sea the wind and the sea's options give, at once, without the
   * second the sea otherwise takes to follow.
   */
  settleSea(): void {
    const s = this.#physics.records.state;
    this.tick = this.clock === null ? this.tick : this.clock.steps + 1;
    this.sea.settle(this.wind, s[S.x] ?? 0, s[S.y] ?? 0, this.tick);
    this.#windBefore.speed = this.wind.speed;
    this.#windBefore.from = this.wind.from;
  }

  /**
   * Lays the boat on the sea of a time, in ticks, as it would float there
   * at rest: its heave and pitch those of the water under its hull. For a
   * boat shown without having been sailed to that time (the tests' frozen
   * pictures).
   */
  floatAt(tick: number): void {
    const p = this.#physics;
    const s = p.records.state;
    const slot = this.seas.slotAt(Math.floor(tick) + 1);
    let heave = 0;
    let pitch = 0;
    if (slot >= 0) {
      p.seaDrawAt(tick);
      const { waterlineLength, waterlineBeam } = this.#boat.hull;
      const w = p.waveUnder(
        slot,
        s[S.x] ?? 0,
        s[S.y] ?? 0,
        s[S.heading] ?? 0,
        waterlineLength,
        waterlineBeam,
      );
      heave = w[RECORDS.wave.height] ?? 0;
      pitch = w[RECORDS.wave.ahead] ?? 0;
    }
    const state = p.records.state;
    state[S.heave] = heave;
    state[S.pitch] = pitch;
    state[S.heaveRate] = 0;
    state[S.pitchRate] = 0;
    this.states.hold(state);
  }

  step(helm: number, sheet: number): void {
    const r = this.#physics.records;
    const tick = this.clock === null ? this.tick + 1 : this.clock.steps + 2;
    this.sea.advance(tick, this.#windBefore, r.state[S.x] ?? 0, r.state[S.y] ?? 0);
    this.recorder.step(helm, sheet, this.wind.speed, this.wind.from, tick, this.sea);
    r.control[RECORDS.control.helm] = helm;
    r.control[RECORDS.control.sheet] = sheet;
    r.env[RECORDS.env.windSpeed] = this.wind.speed;
    r.env[RECORDS.env.windFrom] = this.wind.from;
    this.seas.use(tick);
    this.#physics.step();
    this.tick = tick;
    this.#windBefore.speed = this.wind.speed;
    this.#windBefore.from = this.wind.from;
    // The module's memory never grows while stepping, so the views stay valid.
    const after = this.#physics.records;
    this.states.push(after.state);
    this.out.set(after.out);
  }

  /**
   * Starts recording the sail from the boat as it is now, in the sea its
   * wind has raised; every reset or placing starts again. Off by default,
   * since a recording keeps every change of control.
   */
  record(): void {
    this.recording = true;
    this.settleSea();
    const r = this.#physics.records;
    this.recorder.start(r.state, r.control, r.env);
  }

  /** The sail since recording started, or the last reset or placing, as a golden scenario. */
  recorded(name: string): Recording {
    const r = this.#physics.records;
    return this.recorder.recording(name, r.seaParams, r.params, r.state);
  }

  #settle(): void {
    const r = this.#physics.records;
    r.env[RECORDS.env.windSpeed] = this.wind.speed;
    r.env[RECORDS.env.windFrom] = this.wind.from;
    this.states.hold(r.state);
    this.settleSea();
    if (this.recording) {
      this.recorder.start(r.state, r.control, r.env);
    }
  }
}

/** Compiles the physics module and starts a sandbox for a boat. */
export async function startSandbox(
  source: PhysicsSource,
  boat: BoatPhysics,
  sea: WeatherSea,
  start: SandboxStart = START,
): Promise<Sandbox> {
  return new Sandbox(await loadPhysics(source), boat, sea, start);
}

function wrap(a: number): number {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI;
}
