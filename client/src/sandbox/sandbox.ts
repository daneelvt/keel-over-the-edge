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
//
// With an edge, it keeps the server's rules at the lip too: a boat whose
// centre crosses it is held there, unstepped, for the fall, then starts
// again at the sandbox's start, at rest. Its current runs the world's way
// round the disk: a world file's, or clockwise.

import type { BoatPhysics, Weather } from '../catalog/types.gen';
import type { BoatDriver, Wind } from '../game/driver';
import { PILOT_IDLE, type PilotControl } from '../input/pilot';
import { StatePair } from '../predict/blend';
import { RECORDS, SEA_SPEED_STEP, SIZES, WEATHER } from '../predict/layout.gen';
import { loadPhysics, type Physics, type PhysicsSource } from '../predict/physics';
import { preparePhysics } from '../predict/predictor';
import { Seas } from '../predict/seas';
import {
  type BoatWind,
  heldSpell,
  kindIndex,
  newBoatWind,
  placedRecord,
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

/** A weather as it is made at a tick: the spell, the spell before any tuning, and the server's command for it, if there is one. */
interface Made {
  spell: Spell;
  made: Spell;
  set: WeatherSet | null;
}

/** The weather that is one wind everywhere, with no shifts or gusts. */
export const STEADY = 'steady';
/** The start's weather of ?weather=front: a front crossing the boat three minutes in. */
export const FRONT = 'front';
/** A system of ?weather=<kind> and a front reach the boat this many ticks in. */
const ARRIVE_TICKS = 3 * 60 * 30;
/** And a front moves at this, m/s: six knots. */
const FRONT_SPEED = (6 * 1852) / 3600;
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
  return id !== null &&
    (id === STEADY || id === FRONT || regimeIndex(weather, id) >= 0 || kindIndex(weather, id) >= 0)
    ? id
    : null;
}

/** The weather a sailor meets most: the id of the regime with the greatest share of the time. */
export function commonestWeather(weather: Weather): string {
  let best = weather.regimes[0];
  for (const r of weather.regimes) {
    if (best === undefined || r.share > best.share) {
      best = r;
    }
  }
  return best?.id ?? STEADY;
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
  /** How many steps pushed the boat off the ground. */
  pushes = 0;
  /**
   * The edge's rules, or null for none: how many ticks a boat that has
   * gone over the lip falls before it starts again (the catalog's fall).
   */
  edge: { fall: number } | null = null;
  /** The tick the boat went over the lip, 0 while it is afloat; and how many times it has started again since. */
  over = 0;
  restarts = 0;
  /** The boat stays where it is while the free camera flies: not stepped, as a server keeps it. */
  stays = false;

  readonly #physics: Physics;
  readonly #boat: BoatPhysics;
  readonly #catalog: Weather;
  /** What of a regime's spell is on: its gusts, and its shifts and its difference across the disk. */
  readonly tuning = { gusts: true, shifts: true };
  /** A weather asked for, to make at the next step's tick. */
  #pending: ((begin: number) => Made) | null = null;
  /** The latest spell as its weather made it, before any tuning. */
  #made: Spell = new Float64Array(SIZES.spell);
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
    this.#startWeather();
    this.setCirculation(1);
    this.reset();
  }

  /** Sets the world's way round the disk for the current: 1 clockwise, −1 the other way, 0 none. */
  setCirculation(way: number): void {
    this.#physics.circulation(way);
  }

  /** The physics module, for whoever draws its sea. */
  get physics(): Physics {
    return this.#physics;
  }

  /** The physics module's records, for the developer panel and the tests. */
  get records(): Physics['records'] {
    return this.#physics.records;
  }

  /** Back to the start, at rest, in the weather as it is, and a new recording. */
  reset(): void {
    this.over = 0;
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
    this.over = 0;
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

  /**
   * The start's weather, as if it had blown for ever: one spell, from tick
   * 0; for a front, the commonest regime's spell and a front crossing the
   * boat three minutes in; for a kind of system, the spell of the commonest
   * regime, or of the lightest for a kind of light winds, and a system of
   * it reaching the boat three minutes in.
   */
  #startWeather(): void {
    const { wind, weather } = this.start;
    const kind = kindIndex(this.#catalog, weather);
    if (weather === FRONT || kind >= 0) {
      this.#startSystem(kind);
      return;
    }
    this.#physics.setRecords([]);
    const regime = regimeIndex(this.#catalog, weather);
    const spell =
      regime < 0
        ? steadySpell(this.#physics, wind.speed, wind.from, 0)
        : regimeSpell(
            this.#physics,
            this.#catalog,
            regime,
            1,
            this.#catalog.week.seed,
            turnSteps(wind.from),
            0,
            SPELL_TICKS,
          );
    this.#pending = null;
    this.#set = null;
    this.#made = spell;
    this.tuning.gusts = true;
    this.tuning.shifts = true;
    this.weather.set([spell]);
  }

  #startSystem(kind: number): void {
    const c = this.#catalog;
    const calm = kind >= 0 && (c.systems[kind]?.calmBelow ?? 0) > 0;
    let regime = regimeIndex(c, commonestWeather(c));
    if (calm) {
      regime = c.regimes.reduce(
        (best, r, i) => ((r.wind.speed[1] ?? 0) < (c.regimes[best]?.wind.speed[1] ?? 0) ? i : best),
        0,
      );
    }
    const base = regimeSpell(
      this.#physics,
      c,
      regime,
      1,
      c.week.seed,
      turnSteps(this.start.wind.from),
      0,
      SPELL_TICKS,
    );
    // At the start's place, where the boat begins and begins again.
    const { east, north } = this.start;
    const spells = [base];
    const records: Float64Array[] = [];
    if (kind >= 0) {
      records.push(placedRecord(c, kind, east, north, 0, ARRIVE_TICKS, base));
    } else {
      // A front of the first frontal regime, its line moving with that
      // regime's wind, to cross the boat three minutes in.
      const frontal = Math.max(
        0,
        c.regimes.findIndex((r) => r.frontal),
      );
      const reach = this.#physics.frontReach();
      const change = 2 * Math.round((reach / FRONT_SPEED) * 30);
      const P = RECORDS.spell;
      const spell = heldSpell(this.#physics, c, frontal, 0);
      // Veering the wind as a week's fronts do, by the middle of their veer.
      const veer = Math.round((((c.week.veer[0] ?? 0) + (c.week.veer[1] ?? 0)) / 2 / 360) * WEATHER.turnSteps);
      spell[P.from] = ((base[P.from] ?? 0) + veer) % WEATHER.turnSteps;
      const toward = (((spell[P.from] ?? 0) + WEATHER.turnSteps / 2) % WEATHER.turnSteps) as number;
      const a = (toward / WEATHER.turnSteps) * 2 * Math.PI;
      const along = east * Math.sin(a) + north * Math.cos(a);
      const begin = Math.round(ARRIVE_TICKS - ((along + reach) / FRONT_SPEED) * 30);
      spell[P.begin] = begin;
      spell[P.start] = begin;
      spell[P.change] = change;
      spell[P.front] = 1;
      spell[P.toward] = toward;
      spell[P.trough] = Math.round(
        50 * ((c.week.frontTrough[0] ?? 0) + (c.week.frontTrough[1] ?? 0)),
      );
      spell[P.still] = 0;
      // The spell before it begins before it does.
      base[P.begin] = Math.min(0, begin - 1);
      base[P.start] = base[P.begin] ?? 0;
      spells.push(spell);
    }
    this.#pending = null;
    this.#set = null;
    this.#made = base;
    this.tuning.gusts = true;
    this.tuning.shifts = true;
    this.#physics.setRecords(records);
    this.weather.set(spells);
  }

  /**
   * A steady wind at once, as if it had blown for ever: the weather is that
   * one spell, from tick 0. Not what a server does, whose weather changes
   * from the second after next; the sea follows within two seconds, or at
   * once with settleSea.
   */
  steadyNow(speed: number, from: number): void {
    this.#physics.setRecords([]);
    const spell = steadySpell(this.#physics, speed, from, 0);
    this.#pending = null;
    this.#set = null;
    this.#made = spell;
    this.weather.set([spell]);
    const s = this.#physics.records.state;
    this.weather.read(this.tick, s[S.x] ?? 0, s[S.y] ?? 0, this.wind);
  }

  /**
   * A steady wind of speed m/s from a direction in radians, from the second
   * after the next step's on: a server's steady weather.
   */
  setWind(speed: number, from: number): void {
    this.#pending = (begin) => {
      const spell = steadySpell(this.#physics, speed, from, begin);
      const P = RECORDS.spell;
      // A developer's weather stills the world's own systems while it blows.
      spell[P.still] = 1;
      return {
        spell,
        made: spell,
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
    this.tuning.gusts = true;
    this.tuning.shifts = true;
    this.#pending = (begin) => {
      const spell = heldSpell(this.#physics, this.#catalog, regime, begin);
      return { spell, made: spell, set: { mode: 1, regime, speed: 0, dir: 0 } };
    };
  }

  /**
   * Changes the latest spell: its wind at mid-disk, in m/s, where that
   * comes from, in radians, and whether its gusts and its shifts are on. A
   * steady wind has neither. The spell is the sandbox's own from then on,
   * which no server's command makes.
   */
  tune(change: { speed?: number; from?: number; gusts?: boolean; shifts?: boolean }): void {
    const P = RECORDS.spell;
    const made = Float64Array.from(this.#pending?.(0).made ?? this.#made);
    if (made[P.steady] === 1) {
      this.setWind(
        change.speed ?? (made[P.speed] ?? 0) * SEA_SPEED_STEP,
        change.from ?? ((made[P.from] ?? 0) / WEATHER.turnSteps) * 2 * Math.PI,
      );
      return;
    }
    if (change.speed !== undefined) {
      made[P.speed] = Math.round(Math.max(0, change.speed) / SEA_SPEED_STEP);
    }
    if (change.from !== undefined) {
      made[P.from] = turnSteps(change.from);
    }
    this.tuning.gusts = change.gusts ?? this.tuning.gusts;
    this.tuning.shifts = change.shifts ?? this.tuning.shifts;
    const { gusts, shifts } = this.tuning;
    this.#pending = (begin) => {
      const s = Float64Array.from(made);
      s[P.begin] = begin;
      s[P.change] = 0;
      s[P.start] = begin;
      if (!gusts) {
        // A gust factor of 1: no gusts, and none of their veer.
        s[P.gust] = 1000;
      }
      if (!shifts) {
        s[P.shift] = 0;
        s[P.shift + 1] = 0;
        s[P.across] = 0;
        s[P.drift] = 0;
      }
      return { spell: s, made, set: null };
    };
  }

  /** The latest spell: the one asked for, if it is still to be made. */
  get spell(): Spell {
    if (this.#pending !== null) {
      return this.#pending(takesEffect(this.tick + 1)).spell;
    }
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

  stay(on: boolean): void {
    this.stays = on;
  }

  step(helm: number, sheet: number, pilot: PilotControl = PILOT_IDLE): void {
    const r = this.#physics.records;
    const tick = this.clock === null ? this.tick + 1 : this.clock.steps + 2;
    if (this.#pending !== null) {
      // As a server applies a developer's weather given at this tick.
      const { spell, made, set } = this.#pending(takesEffect(tick));
      this.#pending = null;
      // A system the sandbox placed goes with the weather it came in.
      this.#physics.setRecords([]);
      this.#set = set;
      this.#made = made;
      this.weather.add(spell);
    }
    if (this.stays) {
      this.tick = tick;
      this.states.push(r.state);
      return;
    }
    if (this.over !== 0 && this.edge !== null) {
      if (tick < this.over + this.edge.fall) {
        // Over the lip, falling: held as it went over.
        this.tick = tick;
        this.states.push(r.state);
        return;
      }
      // The fall is over: back at the start, as a server starts it again.
      this.restarts++;
      this.reset();
    }
    const east = r.state[S.x] ?? 0;
    const north = r.state[S.y] ?? 0;
    this.sea.advance(tick, east, north);
    this.recorder.step(helm, sheet, tick, this.sea, this.#stepWeather, pilot);
    // The wind the step sails in: the wind where the boat is as it begins.
    this.weather.read(tick, east, north, this.wind);
    r.control[RECORDS.control.helm] = helm;
    r.control[RECORDS.control.sheet] = sheet;
    r.control[RECORDS.control.pilot] = pilot.mode;
    r.control[RECORDS.control.target] = pilot.target;
    r.control[RECORDS.control.order] = pilot.order;
    r.control[RECORDS.control.way] = pilot.way;
    this.weather.use(tick);
    this.seas.use(tick);
    this.#physics.step();
    this.tick = tick;
    if (this.edge !== null && this.#physics.over()) {
      this.over = tick;
    }
    // The module's memory never grows while stepping, so the views stay valid.
    const after = this.#physics.records;
    this.out.set(after.out);
    if ((after.out[RECORDS.out.pushedOff] ?? 0) !== 0) {
      // Pushed off: drawn at once where the sailor put it.
      this.pushes++;
      this.states.hold(after.state);
    } else {
      this.states.push(after.state);
    }
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
