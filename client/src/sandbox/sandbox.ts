// SPDX-License-Identifier: AGPL-3.0-only

// The offline sandbox: one boat, stepped by the physics module in the
// page, in a weather of its own making, by the server's rules, and the sea
// it raises (localsea.ts): a steady wind that is the same everywhere, or a
// spell of one of the catalog's regimes with its shifts and gusts. No
// server corrects it. It is the game's page until the game connects to a
// server, and stays reachable with ?sandbox afterwards, as a tool.
//
// Its weather changes as a server's does at a developer's command: from the
// second after next, so a sail recorded here can be sailed on a server
// given the same commands at the same ticks.

import type { BoatPhysics, Weather } from '../catalog/types.gen';
import type { BoatDriver, Wind } from '../game/driver';
import { StatePair } from '../predict/blend';
import { RECORDS, SIZES, WEATHER } from '../predict/layout.gen';
import { loadPhysics, type Physics, type PhysicsSource } from '../predict/physics';
import { preparePhysics } from '../predict/predictor';
import { Seas } from '../predict/seas';
import {
  type BoatWind,
  heldSpell,
  newBoatWind,
  regimeIndex,
  regimeSpell,
  type Spell,
  Spells,
  steadySpell,
  takesEffect,
} from '../predict/weather';
import { LocalSea } from './localsea';
import { Recorder, type Recording, type StepWeather, type WeatherSet } from './record';

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
  /** The wind of a steady weather; of a regime's spell, only where it comes from. */
  wind: Wind;
  /** The weather: STEADY, or the id of one of the catalog's regimes. */
  weather: string;
}

/** The weather that is one wind everywhere, with no shifts or gusts. */
export const STEADY = 'steady';
/** How long the sandbox's first spell of a regime lasts, and drifts over: four hours of ticks. */
const SPELL_TICKS = 4 * 3600 * 30;

/**
 * The start: the disk's centre, at rest, heading 090°, the helm centred and
 * the sheet half out, in a steady 10 knots from the north. A beam reach in
 * a breeze the full rig carries without depowering.
 */
export const START: SandboxStart = {
  east: 0,
  north: 0,
  heading: Math.PI / 2,
  helm: 0,
  sheet: 0.5,
  wind: { speed: 10 * KNOT, from: 0 },
  weather: STEADY,
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

/**
 * Reads ?weather=steady or a regime's id: the sandbox's weather, or null
 * for none or one the catalog does not have.
 */
export function weatherFromQuery(query: URLSearchParams, weather: Weather): string | null {
  const id = query.get('weather');
  return id !== null && (id === STEADY || regimeIndex(weather, id) >= 0) ? id : null;
}

/** A direction in radians as steps of a turn, as a spell has it. */
function turnSteps(from: number): number {
  const steps = Math.round((from / (2 * Math.PI)) * WEATHER.turnSteps) % WEATHER.turnSteps;
  return steps < 0 ? steps + WEATHER.turnSteps : steps;
}

export class Sandbox implements BoatDriver {
  readonly states = new StatePair();
  readonly out = new Float64Array(SIZES.out);
  readonly wind: BoatWind = newBoatWind();
  readonly recorder = new Recorder();
  readonly start: SandboxStart;
  /** Whether the sail is being recorded (the developer panel turns it on). */
  recording = false;
  /** The sea about the boat, as the physics module holds it, and what makes it. */
  readonly seas: Seas;
  readonly sea: LocalSea;
  /** The spells of weather in play, as the physics module holds them. */
  readonly weather: Spells;
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
  readonly #catalog: Weather;
  /** A weather asked for, to make at the next step's tick. */
  #pending: ((begin: number) => { spell: Spell; set: WeatherSet | null }) | null = null;
  /** The developer's weather behind the latest change of the spells, if it was one. */
  #set: WeatherSet | null = null;
  readonly #stepWeather: StepWeather;

  constructor(physics: Physics, boat: BoatPhysics, weather: Weather, start: SandboxStart = START) {
    this.#physics = physics;
    this.#boat = boat;
    this.#catalog = weather;
    this.start = start;
    preparePhysics(physics, boat, weather);
    this.seas = new Seas(physics);
    this.sea = new LocalSea(physics, this.seas);
    this.weather = new Spells(physics);
    const self = this;
    this.#stepWeather = {
      get version() {
        return self.weather.version;
      },
      get spells() {
        return self.weather.spells;
      },
      get set() {
        return self.#set;
      },
    };
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

  /** Back to the start, at rest, in the start's weather, and a new recording. */
  reset(): void {
    this.#startWeather();
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

  /** The start's weather, as if it had blown for ever: one spell, from tick 0. */
  #startWeather(): void {
    const { wind, weather } = this.start;
    const regime = regimeIndex(this.#catalog, weather);
    const spell =
      regime < 0
        ? steadySpell(this.#physics, wind.speed, wind.from, 0)
        : regimeSpell(
            this.#physics,
            this.#catalog,
            regime,
            1,
            this.#catalog.sequence.seed,
            turnSteps(wind.from),
            0,
            SPELL_TICKS,
          );
    this.#pending = null;
    this.#set = null;
    this.weather.set([spell]);
  }

  /**
   * A steady wind of speed m/s from a direction in radians, from the second
   * after the next step's on: a server's steady weather.
   */
  setWind(speed: number, from: number): void {
    this.#pending = (begin) => {
      const spell = steadySpell(this.#physics, speed, from, begin);
      const P = RECORDS.spell;
      return {
        spell,
        set: { mode: 2, regime: 0, speed: spell[P.speed] ?? 0, dir: spell[P.from] ?? 0 },
      };
    };
  }

  /**
   * The weather of an id, from the second after the next step's on: one
   * endless spell of the catalog's regime of that id, as a server holds a
   * regime, or, for STEADY, the mean wind at the boat held steady.
   */
  setWeather(id: string): void {
    const regime = regimeIndex(this.#catalog, id);
    if (regime < 0) {
      this.setWind(this.wind.meanSpeed, this.wind.meanFrom);
      return;
    }
    this.#pending = (begin) => ({
      spell: heldSpell(this.#physics, this.#catalog, regime, begin),
      set: { mode: 1, regime, speed: 0, dir: 0 },
    });
  }

  /**
   * A spell of the sandbox's own making, in play from the second after the
   * next step's on: its begin and start are set to that tick. No server's
   * command makes one, so a recording with it sails only where its spells
   * are given.
   */
  setSpell(spell: Spell): void {
    this.#pending = (begin) => {
      const s = Float64Array.from(spell);
      const P = RECORDS.spell;
      s[P.begin] = begin;
      s[P.change] = 0;
      s[P.start] = begin;
      return { spell: s, set: null };
    };
  }

  /** The latest spell in play. */
  get spell(): Spell {
    return this.weather.latest ?? new Float64Array(SIZES.spell);
  }

  /** The id of the latest spell's weather: STEADY, or its regime's. */
  get regime(): string {
    const s = this.spell;
    const P = RECORDS.spell;
    return s[P.steady] === 1 ? STEADY : (this.#catalog.regimes[s[P.regime] ?? 0]?.id ?? STEADY);
  }

  /**
   * Raises the sea the weather and the sea's options give, at once: where a
   * boat is put, the sea is as the weather there has made it.
   */
  settleSea(): void {
    const s = this.#physics.records.state;
    this.tick = this.clock === null ? this.tick : this.clock.steps + 1;
    this.sea.settle(s[S.x] ?? 0, s[S.y] ?? 0, this.tick);
    this.weather.read(this.tick, s[S.x] ?? 0, s[S.y] ?? 0, this.wind);
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
    if (this.#pending !== null) {
      // As a server applies a developer's weather given at this tick.
      const { spell, set } = this.#pending(takesEffect(tick));
      this.#pending = null;
      this.#set = set;
      this.weather.add(spell);
    }
    const east = r.state[S.x] ?? 0;
    const north = r.state[S.y] ?? 0;
    this.sea.advance(tick, east, north);
    this.recorder.step(helm, sheet, tick, this.sea, this.#stepWeather);
    // The wind the step sails in: the wind where the boat is as it begins.
    this.weather.read(tick, east, north, this.wind);
    r.control[RECORDS.control.helm] = helm;
    r.control[RECORDS.control.sheet] = sheet;
    this.weather.use(tick);
    this.seas.use(tick);
    this.#physics.step();
    this.tick = tick;
    // The module's memory never grows while stepping, so the views stay valid.
    const after = this.#physics.records;
    this.states.push(after.state);
    this.out.set(after.out);
  }

  /**
   * Starts recording the sail from the boat as it is now, in the sea its
   * weather has raised; every reset or placing starts again. Off by default,
   * since a recording keeps every change of control.
   */
  record(): void {
    this.recording = true;
    this.settleSea();
    const r = this.#physics.records;
    this.recorder.start(r.state, r.control);
  }

  /** The sail since recording started, or the last reset or placing, as a golden scenario. */
  recorded(name: string): Recording {
    const r = this.#physics.records;
    return this.recorder.recording(name, r.seaParams, r.params, r.weatherParams, r.state);
  }

  #settle(): void {
    const r = this.#physics.records;
    this.states.hold(r.state);
    this.settleSea();
    if (this.recording) {
      this.recorder.start(r.state, r.control);
    }
  }
}

/** Compiles the physics module and starts a sandbox for a boat. */
export async function startSandbox(
  source: PhysicsSource,
  boat: BoatPhysics,
  weather: Weather,
  start: SandboxStart = START,
): Promise<Sandbox> {
  return new Sandbox(await loadPhysics(source), boat, weather, start);
}

function wrap(a: number): number {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI;
}
