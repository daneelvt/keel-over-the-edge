// SPDX-License-Identifier: AGPL-3.0-only

// The weather about the boat, as the server sends it: the spells in play,
// each a record of whole numbers, held in the physics module, which
// computes the wind at the boat from them exactly as the server does. The
// server sends a spell ten seconds before its change from the one before
// begins and keeps the one before in play ten seconds past the change's
// end, so the prediction, which steps a fraction of a second ahead and
// replays a fraction behind, always holds the spells of the tick it steps.
// internal/client/predict.go is its twin.
//
// A client with no server makes its own spells here, by the server's rules:
// a steady wind, or a spell drawn from one of the catalog's regimes.

import type { Weather } from '../catalog/types.gen';
import { RECORDS, SIZES, WEATHER } from './layout.gen';
import { writeRegime } from './params.gen';
import type { Physics } from './physics';

const P = RECORDS.spell;
const W = RECORDS.wind;

/** A spell of weather: the spell record's values, whole numbers all. */
export type Spell = Float64Array;

/** The wind at the boat, in full. */
export interface BoatWind {
  /** The true wind 10 m above the sea, m/s, and where it comes from, radians clockwise from north. */
  speed: number;
  from: number;
  /**
   * The wind with the shadow of the boats near: what an anemometer at the
   * masthead reads. The speed and direction above, in clean air.
   */
  shadowSpeed: number;
  shadowFrom: number;
  /** The wind without its gusts: what the Beaufort scale reads. */
  meanSpeed: number;
  meanFrom: number;
  /** The gust field, from −1 in the deepest lull to 1 in the strongest gust, and the gust factor. */
  gust: number;
  factor: number;
}

export function newBoatWind(): BoatWind {
  return {
    speed: 0,
    from: 0,
    shadowSpeed: 0,
    shadowFrom: 0,
    meanSpeed: 0,
    meanFrom: 0,
    gust: 0,
    factor: 1,
  };
}

/** Ticks in a second, and how many a developer's weather waits before it blows: to the second after next. */
const SECOND = 30;

/** Mixes the bits of x (Wellons's lowbias32), as the server's draws do. */
export function mix(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The tick a weather set at a tick takes effect from: the first of the second after next. */
export function takesEffect(tick: number): number {
  return (Math.floor(tick / SECOND) + 2) * SECOND;
}

export class Spells {
  /** The spells in play, ascending by the tick each begins at. */
  spells: Spell[] = [];
  /** Counts the changes, so that whoever draws the gusts knows to read them again. */
  version = 0;

  readonly #physics: Physics;

  constructor(physics: Physics) {
    this.#physics = physics;
  }

  /** Forgets what was sent: no wind. */
  reset(): void {
    this.set([]);
  }

  /**
   * Takes the spells in play, each a spell record's values: they replace
   * those held. Reports false, and keeps what it held, if they are not
   * spells: too many, or not of a record's length.
   */
  receive(spells: readonly ArrayLike<number>[]): boolean {
    if (spells.length > WEATHER.spells || spells.some((s) => s.length !== SIZES.spell)) {
      return false;
    }
    this.set(spells.map((s) => Float64Array.from(s)));
    return true;
  }

  /** Makes spells the spells in play. */
  set(spells: Spell[]): void {
    this.spells = spells.slice(-WEATHER.spells);
    this.#physics.setSpells(this.spells);
    this.version++;
  }

  /** One more spell in play, after the others; the oldest goes if there is no room. */
  add(spell: Spell): void {
    // One that begins when another does replaces it, as the server's does.
    const kept = this.spells.filter((s) => (s[P.begin] ?? 0) < (spell[P.begin] ?? 0));
    this.set([...kept, spell]);
  }

  /** Sets the module's env to the wind at its boat at a tick, before a step into it. */
  use(tick: number): void {
    this.#physics.windAt(tick);
  }

  /** Reads into wind the wind at (east, north) at a time, in ticks. */
  read(tick: number, east: number, north: number, wind: BoatWind): BoatWind {
    this.#physics.windDrawAt(tick);
    const r = this.#physics.windPoint(east, north);
    wind.speed = r[W.speed] ?? 0;
    wind.from = r[W.from] ?? 0;
    wind.shadowSpeed = wind.speed;
    wind.shadowFrom = wind.from;
    wind.meanSpeed = r[W.meanSpeed] ?? 0;
    wind.meanFrom = r[W.meanFrom] ?? 0;
    wind.gust = r[W.gust] ?? 0;
    wind.factor = r[W.factor] ?? 1;
    return wind;
  }

  /** The latest spell in play, or null. */
  get latest(): Spell | null {
    return this.spells[this.spells.length - 1] ?? null;
  }
}

/**
 * A steady wind from begin on: speed m/s from a direction in radians, in
 * the steps the server rounds a wind to, the same everywhere.
 */
export function steadySpell(physics: Physics, speed: number, from: number, begin: number): Spell {
  const steps = physics.seaInputOf(speed, from, 0, [0, 0, 0]);
  const s = new Float64Array(SIZES.spell);
  s[P.begin] = begin;
  s[P.start] = begin;
  s[P.steady] = 1;
  s[P.speed] = steps[0] ?? 0;
  s[P.from] = steps[1] ?? 0;
  s[P.gust] = 1000;
  return s;
}

/**
 * A spell of the catalog's regime of an index, drawn from its number and a
 * seed as the server draws its own: beginning at begin, drifting over
 * length ticks, its wind from a direction in 65536ths of a turn.
 */
export function regimeSpell(
  physics: Physics,
  weather: Weather,
  regime: number,
  number: number,
  seed: number,
  from: number,
  begin: number,
  length: number,
): Spell {
  const kind = weather.regimes[regime];
  if (kind === undefined) {
    throw new Error(`the catalog has no regime ${regime}`);
  }
  const r = physics.records;
  writeRegime(r.regime, kind.wind);
  r.spell.fill(0);
  r.spell[P.begin] = begin;
  r.spell[P.start] = begin;
  r.spell[P.length] = length;
  r.spell[P.regime] = regime;
  r.spell[P.from] = from;
  physics.spellDraw(number, seed);
  return Float64Array.from(physics.records.spell);
}

/**
 * The spell a developer's held regime gives from a tick on, as the server
 * makes it: one endless spell, with no drift, from a direction of its own.
 */
export function heldSpell(physics: Physics, weather: Weather, regime: number, from: number): Spell {
  const number = (from ^ 0x5bd1e995) >>> 0;
  const seed = weather.sequence.seed >>> 0;
  const s = regimeSpell(physics, weather, regime, number, seed, 0, from, 0);
  s[P.drift] = 0;
  s[P.from] = mix(number ^ seed) % WEATHER.turnSteps;
  return s;
}

/** The index of the catalog's regime of an id, or −1. */
export function regimeIndex(weather: Weather, id: string): number {
  return weather.regimes.findIndex((r) => r.id === id);
}
