// SPDX-License-Identifier: AGPL-3.0-only

// The chart's weather: what the chart shows of the wind, the gusts, the
// rain, the fog, the systems and the pressure at the slider's moment: now,
// from the keyframes the phone holds; a minute ahead, from the latest
// forecast, which is the truth for its reach, every system placed where it
// will be; or a minute of the last ninety, from the truth kept. Its fields
// come from the forecast's own module (predict/forecast.ts), sampled on a
// grid over the whole disk, uncharted water and all; its systems from the
// keyframes of the moment; its fronts from the spells. It is painted on a
// canvas of its own over the paper (weatherpaint.ts), so the paper is
// painted once.

import type { ForecastTold } from '../net/messages';
import { type Fields, type Forecasts, issueOf } from '../predict/forecast';
import { RECORDS, SIZES } from '../predict/layout.gen';
import type { Keyframe, Physics } from '../predict/physics';

const Y = RECORDS.system;
const P = RECORDS.spell;
const H = RECORDS.forecastHead;
const R = RECORDS.systemRecord;

/** Ticks a second, and a minute. */
const SECOND = 30;
const MINUTE = 60 * SECOND;
const TURN = 65536;

/**
 * The chart's weather layers, each with its switch: under "Wind" its wash
 * by force, its barbs and its streaks; the gusts, the rain, the fog, the
 * systems and the pressure's isobars.
 */
export type Layer =
  | 'wash'
  | 'barbs'
  | 'streaks'
  | 'gusts'
  | 'rain'
  | 'fog'
  | 'systems'
  | 'pressure';
export type Layers = Record<Layer, boolean>;

/** The layers at first: every one, the isobars too. */
export const LAYERS_AT_FIRST: Layers = {
  wash: true,
  barbs: true,
  streaks: true,
  gusts: true,
  rain: true,
  fog: true,
  systems: true,
  pressure: true,
};

/** The slider's two ways: ahead, or what happened. */
export type TimeMode = 'forecast' | 'past';

/** How far ahead the slider goes, minutes, and how far back. */
export const AHEAD_MINUTES = 90;
export const PAST_MINUTES = 90;

/**
 * What the chart shows the weather of: now, the live weather from the
 * keyframes; a minute ahead, the latest forecast's truth then; or a minute
 * of the last ninety, from the truth kept.
 */
export interface Moment {
  kind: 'now' | 'ahead' | 'past';
  /** The tick shown. */
  tick: number;
  /** Minutes from now: ahead positive, in the past negative, 0 now. */
  minutes: number;
  /** The forecast it is read from ahead, the latest; null now and in the past. */
  issue: ForecastTold | null;
}

/** What the chart's weather is read from. */
export interface WeatherSource {
  /** The world's tick now. */
  tick(): number;
  readonly forecasts: Forecasts;
  /** The forecast's module, or null until it is made. */
  fields(): Fields | null;
  /** The present: the spells in play and the keyframes held. */
  present(): { keys: readonly Keyframe[]; spells: readonly ArrayLike<number>[] };
  /** The sun's height at a point at a tick, rad. */
  sun(tick: number, east: number, north: number): number;
  /** The world's last tick, 0 for none known. */
  end(): number;
}

/**
 * How a system is drawn, the catalog's symbol: a squall's dark cell, a
 * shower's heap, a storm's spiral, a low's spiral lettered L, a fog bank, a
 * patch of calm, a squall line's dash, dot, dot, a trough's dashes.
 */
export type SystemDraw =
  | 'cell'
  | 'heap'
  | 'spiral'
  | 'low'
  | 'bank'
  | 'calm'
  | 'dash-dot'
  | 'dashed';

/**
 * How each kind of system is drawn and named, by the catalog's index: its
 * symbol, its name and its key's line; whether it is a line, a low (a
 * storm's shape, with a ring of strongest wind its width of its size
 * out), and whether it flashes.
 */
export interface KindDraw {
  draw: SystemDraw;
  name: string;
  key: string;
  line: boolean;
  /** A low's ring of strongest wind as a share of its size; 0 for no low. */
  ring: number;
  lightning: boolean;
}

/** The catalog's kinds of system, as the chart draws them. */
export function kindDraws(
  systems: readonly {
    name: string;
    key: string;
    symbol: string;
    shape: string;
    width: number;
    lightning?: unknown;
  }[],
): KindDraw[] {
  return systems.map((k) => ({
    draw: k.symbol as SystemDraw,
    name: k.name,
    key: k.key,
    line: k.shape === 'line',
    ring: k.shape === 'low' ? k.width : 0,
    lightning: k.lightning !== undefined,
  }));
}

/** A system as the chart draws it, at the moment. */
export interface SceneSystem {
  slot: number;
  kind: number;
  /** Its seed: with its slot, which system it is from one moment to the next. */
  seed: number;
  draw: SystemDraw;
  name: string;
  east: number;
  north: number;
  /** The direction it moves toward, rad, and how fast, m/s. */
  heading: number;
  speed: number;
  /** Its radius, m, a line's half its depth; its strength, 0 to about 1. */
  size: number;
  strength: number;
  /** A line's length across its motion, m; 0 for any other. */
  length: number;
  /** A low's ring of strongest wind, its radius, m; 0 for any other. */
  ring: number;
  /** The strongest mean wind it blows on the water now and its typical strongest gust, m/s. */
  wind: number;
  gust: number;
  /** Where it will be 30 minutes on, by the forecast, or null if it is gone by then or not known. */
  ahead: { east: number; north: number } | null;
  /** The tick it is gone at, by the forecast's record of it; null if not known. */
  gone: number | null;
}

/**
 * A front's line: the way it moves toward, its line's distance from the
 * centre along it, m; whether it is a warm front, its rain ahead of its
 * line; and how fast it moves, m/s.
 */
export interface SceneFront {
  sin: number;
  cos: number;
  line: number;
  warm: boolean;
  speed: number;
}

/**
 * A grid of the whole disk's fields at the moment: n a side, cell centres
 * from −lip to lip. Its fog is the visibility the fog banks leave in the
 * clear air, 2 m up, the rain's and the mist band's aside, which the rain's
 * stipple and the paper's hatching show.
 */
export interface FieldGrid {
  n: number;
  lip: number;
  mean: Float32Array;
  from: Float32Array;
  gust: Float32Array;
  rain: Float32Array;
  fog: Float32Array;
  pressure: Float32Array;
}

/** All the chart draws of the weather at a moment. */
export interface WeatherScene {
  moment: Moment;
  grid: FieldGrid;
  systems: SceneSystem[];
  fronts: SceneFront[];
  /** The gale's points at the moment ahead: the grid's side and spacing, m, and a byte each; null now and in the past. */
  gale: { side: number; spacing: number; on: Uint8Array } | null;
}

/** The catalog's numbers the scene is sampled with. */
export interface SceneLook {
  lip: number;
  /** Grid points a side. */
  n: number;
  kinds: readonly KindDraw[];
  /** The gale grid's spacing, m. */
  galeGrid: number;
  /** A thing is seen while the optical depth to it is at most this: the visibility is this over the extinction. */
  contrast: number;
}

/** How far on a system's place ahead is told: half an hour. */
const AHEAD = 30 * MINUTE;

/** The whole minute a tick is in: the moments ahead and behind are whole minutes from it, so each holds still for its minute. */
function minuteOf(tick: number): number {
  return Math.floor(tick / MINUTE) * MINUTE;
}

/** The last tick an issue knows its systems to: its until, or its issue for one that knows none. */
export function untilOf(f: ForecastTold): number {
  return Math.max(f.head[H.until] ?? 0, issueOf(f));
}

/**
 * How far ahead the slider reaches, whole minutes: ninety, or less where
 * the latest issue's reach or the world's end comes first; 0 before the
 * first issue.
 */
export function aheadReach(src: WeatherSource): number {
  const issue = src.forecasts.latest;
  if (issue === null) {
    return 0;
  }
  let last = untilOf(issue);
  const end = src.end();
  if (end > 0) {
    last = Math.min(last, end);
  }
  const m = Math.floor((last - minuteOf(src.tick())) / MINUTE);
  return Math.min(Math.max(m, 0), AHEAD_MINUTES);
}

/** How far back the slider reaches, whole minutes: ninety, or less where the truth kept begins later; 0 with none kept. */
export function pastReach(src: WeatherSource): number {
  const from = src.forecasts.truthFrom;
  if (from === null) {
    return 0;
  }
  const m = Math.floor((minuteOf(src.tick()) - from) / MINUTE);
  return Math.min(Math.max(m, 0), PAST_MINUTES);
}

/**
 * The moment the slider shows: its way and its minutes from now, ahead
 * positive, back negative. Ahead it is the latest issue's, back the truth
 * kept's, each as far as it reaches; 0, or nothing held for it, is now.
 */
export function momentOf(mode: TimeMode, minutes: number, src: WeatherSource): Moment {
  const now = src.tick();
  const whole = minuteOf(now);
  const nowMoment: Moment = { kind: 'now', tick: now, minutes: 0, issue: null };
  if (mode === 'past') {
    const back = Math.min(Math.round(-minutes), pastReach(src));
    if (back <= 0) {
      return nowMoment;
    }
    return { kind: 'past', tick: whole - back * MINUTE, minutes: -back, issue: null };
  }
  const issue = src.forecasts.latest;
  const ahead = Math.min(Math.round(minutes), aheadReach(src));
  if (ahead <= 0 || issue === null) {
    return nowMoment;
  }
  return { kind: 'ahead', tick: whole + ahead * MINUTE, minutes: ahead, issue };
}

/** Makes the fields the moment's: the latest forecast's ahead, the truth's in the past, the present now. False if nothing is held for it. */
export function useMoment(fields: Fields, m: Moment, src: WeatherSource): boolean {
  if (m.kind === 'ahead' && m.issue !== null) {
    fields.forecastAt(m.issue, m.tick);
    return true;
  }
  if (m.kind === 'past') {
    const truth = src.forecasts.truthAt(m.tick);
    if (truth === null) {
      return false;
    }
    fields.truthAt(truth.keys, truth.spells, m.tick);
    return true;
  }
  const p = src.present();
  fields.truthAt(p.keys, p.spells, m.tick);
  return true;
}

/** A grid of n a side over the disk: its cell centres' points, east and north of each. */
export function gridPoints(n: number, lip: number): Float64Array {
  const out = new Float64Array(2 * n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      out[2 * (j * n + i)] = ((i + 0.5) / n - 0.5) * 2 * lip;
      out[2 * (j * n + i) + 1] = (0.5 - (j + 0.5) / n) * 2 * lip;
    }
  }
  return out;
}

/** Samples the fields over the disk from a module set to the moment: rows from the north. */
export function sampleGrid(fields: Fields, look: SceneLook, points: Float64Array): FieldGrid {
  const n = look.n;
  const p = fields.physics;
  const typical = p.typicalSample(points, new Float64Array(3 * n * n));
  const rain = p.rainSample(points, new Float64Array(n * n));
  const g: FieldGrid = {
    n,
    lip: look.lip,
    mean: new Float32Array(n * n),
    from: new Float32Array(n * n),
    gust: new Float32Array(n * n),
    rain: new Float32Array(n * n),
    fog: new Float32Array(n * n),
    pressure: new Float32Array(n * n),
  };
  const lip2 = look.lip * look.lip;
  for (let k = 0; k < n * n; k++) {
    const x = points[2 * k] ?? 0;
    const y = points[2 * k + 1] ?? 0;
    g.mean[k] = typical[3 * k] ?? 0;
    g.from[k] = typical[3 * k + 1] ?? 0;
    g.gust[k] = typical[3 * k + 2] ?? 0;
    g.rain[k] = rain[k] ?? 0;
    if (x * x + y * y > lip2) {
      g.fog[k] = Number.NaN;
      g.pressure[k] = Number.NaN;
      continue;
    }
    const air = p.airAt(x, y, 2);
    g.fog[k] = look.contrast / Math.max((air[0] ?? 0) + (air[1] ?? 0), 1e-9);
    g.pressure[k] = p.pressure(x, y);
  }
  return g;
}

/** A system's place on the water at a moment: where it is, which way it moves and how fast, how big and how strong. */
export interface SystemPlace {
  east: number;
  north: number;
  heading: number;
  speed: number;
  size: number;
  length: number;
  strength: number;
}

/** A system record's values as a place, its strength times weight. */
function placeOf(s: ArrayLike<number>, weight: number): SystemPlace {
  return {
    east: (s[Y.east] ?? 0) / 4,
    north: (s[Y.north] ?? 0) / 4,
    heading: ((s[Y.heading] ?? 0) / TURN) * 2 * Math.PI,
    speed: (s[Y.speed] ?? 0) * 0.01,
    size: s[Y.size] ?? 0,
    length: s[Y.length] ?? 0,
    strength: ((s[Y.strength] ?? 0) / 4096) * weight,
  };
}

/** u of the way from a to b, the heading the shorter way round. */
function between(a: SystemPlace, b: SystemPlace, u: number): SystemPlace {
  const turn = Math.atan2(Math.sin(b.heading - a.heading), Math.cos(b.heading - a.heading));
  return {
    east: a.east + u * (b.east - a.east),
    north: a.north + u * (b.north - a.north),
    heading: a.heading + u * turn,
    speed: a.speed + u * (b.speed - a.speed),
    size: a.size + u * (b.size - a.size),
    length: a.length + u * (b.length - a.length),
    strength: a.strength + u * (b.strength - a.strength),
  };
}

/** A system of a slot as the chart draws it at a place, its wind, its course ahead and its end not yet known. */
function sceneOf(
  s: ArrayLike<number>,
  slot: number,
  at: SystemPlace,
  kinds: readonly KindDraw[],
): SceneSystem {
  const kind = s[Y.kind] ?? 0;
  const d = kinds[kind];
  return {
    slot,
    kind,
    seed: s[Y.seed] ?? 0,
    draw: d?.draw ?? 'calm',
    name: d?.name ?? '',
    ...at,
    length: d?.line === true ? at.length : 0,
    ring: (d?.ring ?? 0) * at.size,
    wind: 0,
    gust: 0,
    ahead: null,
    gone: null,
  };
}

/**
 * The systems of the keyframes about a tick, interpolated between them as
 * the module does: the same system in both moves between its two places; one
 * in only one fades in or out with the tick. Their winds, their places
 * ahead and their ends are left for systemWinds and trackSystems.
 */
export function systemsOfKeys(
  keys: readonly Keyframe[],
  tick: number,
  kinds: readonly KindDraw[],
): SceneSystem[] {
  const a = keys[0];
  if (a === undefined) {
    return [];
  }
  const b = keys[1];
  const u =
    b === undefined || b.tick === a.tick
      ? 0
      : Math.min(Math.max((tick - a.tick) / (b.tick - a.tick), 0), 1);
  const out: SceneSystem[] = [];
  const n = Math.max(a.systems.length, b?.systems.length ?? 0);
  for (let slot = 0; slot < n; slot++) {
    const sa = a.systems[slot];
    const sb = b?.systems[slot];
    if (
      sa !== undefined &&
      sb !== undefined &&
      sa[Y.kind] === sb[Y.kind] &&
      sa[Y.seed] === sb[Y.seed]
    ) {
      out.push(sceneOf(sa, slot, between(placeOf(sa, 1), placeOf(sb, 1), u), kinds));
      continue;
    }
    if (sa !== undefined && u < 1) {
      out.push(sceneOf(sa, slot, placeOf(sa, 1 - u), kinds));
    }
    if (sb !== undefined && u > 0) {
      out.push(sceneOf(sb, slot, placeOf(sb, u), kinds));
    }
  }
  return out.filter((s) => s.strength > 0.01);
}

/**
 * The points a system's strongest wind is looked for at: round a low's
 * ring; along a line's leading edge and halfway to it; a cell's centre and
 * its gust front ahead of it, and round it.
 */
export function windPoints(s: SceneSystem): [number, number][] {
  const ux = Math.sin(s.heading);
  const uy = Math.cos(s.heading);
  const out: [number, number][] = [];
  if (s.ring > 0) {
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      out.push([s.east + s.ring * Math.sin(a), s.north + s.ring * Math.cos(a)]);
    }
    return out;
  }
  if (s.length > 0) {
    // Its length runs along (uy, −ux).
    for (const along of [-1 / 3, 0, 1 / 3]) {
      for (const ahead of [0.5, 1]) {
        const l = along * s.length;
        const d = ahead * s.size;
        out.push([s.east + ux * d + uy * l, s.north + uy * d - ux * l]);
      }
    }
    return out;
  }
  out.push([s.east, s.north]);
  for (const d of [0.5, 1]) {
    out.push([s.east + ux * d * s.size, s.north + uy * d * s.size]);
  }
  for (let i = 0; i < 4; i++) {
    const a = s.heading + Math.PI / 4 + (i * Math.PI) / 2;
    out.push([s.east + 0.7 * s.size * Math.sin(a), s.north + 0.7 * s.size * Math.cos(a)]);
  }
  return out;
}

/** Sets each system's strongest mean wind and gust at its points, from a module set to the moment. */
export function systemWinds(physics: Physics, systems: SceneSystem[]): void {
  const each = systems.map(windPoints);
  const flat = each.flat(2);
  if (flat.length === 0) {
    return;
  }
  const typical = physics.typicalSample(flat, new Float64Array((3 * flat.length) / 2));
  let k = 0;
  systems.forEach((s, i) => {
    let wind = 0;
    let gust = 0;
    for (let j = 0; j < (each[i]?.length ?? 0); j++, k++) {
      wind = Math.max(wind, typical[3 * k] ?? 0);
      gust = Math.max(gust, typical[3 * k + 2] ?? 0);
    }
    s.wind = wind;
    s.gust = Math.max(gust, wind);
  });
}

/** A forecast's record of the system in a slot of a seed, or null if it holds none. */
export function recordOf(f: ForecastTold, slot: number, seed: number): ArrayLike<number> | null {
  const n = Math.min(f.head[H.nSystems] ?? f.systems.length, f.systems.length);
  for (let i = 0; i < n; i++) {
    const r = f.systems[i];
    if (r !== undefined && (f.head[H.slots + i] ?? -1) === slot && (r[R.seed] ?? 0) === seed) {
      return r;
    }
  }
  return null;
}

/**
 * Where a forecast's system is at a tick, from its record: between the two
 * keyframes about the tick the module makes of it, as the server's are
 * interpolated; null when it is not alive then, or the forecast does not
 * reach the tick.
 */
export function recordAt(
  physics: Physics,
  f: ForecastTold,
  r: ArrayLike<number>,
  tick: number,
): SystemPlace | null {
  if (tick < issueOf(f) || tick > untilOf(f)) {
    return null;
  }
  const every = Math.max(f.head[H.every] ?? 0, 1);
  const origin = f.head[H.origin] ?? 0;
  const a = Math.floor(tick / every) * every;
  const u = (tick - a) / every;
  const at = (t: number, weight: number): SystemPlace | null => {
    const s = physics.systemAt(r, t - origin);
    return (s[Y.on] ?? 0) === 0 ? null : placeOf(s, weight);
  };
  const pa = at(a, 1);
  const pb = at(a + every, 1);
  let p: SystemPlace | null = null;
  if (pa !== null && pb !== null) {
    p = between(pa, pb, u);
  } else if (pa !== null) {
    p = { ...pa, strength: pa.strength * (1 - u) };
  } else if (pb !== null) {
    p = { ...pb, strength: pb.strength * u };
  }
  return p !== null && p.strength > 0.01 ? p : null;
}

/**
 * A system's track by the latest forecast, from its record: its place at
 * any tick the forecast reaches, null once it is gone. A system the
 * forecast does not hold is carried on as it moves, to the forecast's
 * reach.
 */
export function systemTrack(
  physics: Physics | null,
  f: ForecastTold | null,
  s: SceneSystem,
  from: number,
): { at: (tick: number) => SystemPlace | null; until: number } {
  const r = f === null ? null : recordOf(f, s.slot, s.seed);
  if (physics !== null && f !== null && r !== null) {
    const gone = (r[R.gone] ?? 0) + (f.head[H.origin] ?? 0);
    return {
      at: (tick) => (tick >= gone ? null : recordAt(physics, f, r, tick)),
      until: Math.min(untilOf(f), gone),
    };
  }
  const until = f === null ? from + AHEAD_MINUTES * MINUTE : untilOf(f);
  return {
    at: (tick) => {
      if (tick > until) {
        return null;
      }
      const d = (s.speed * Math.max(tick - from, 0)) / SECOND;
      return {
        ...s,
        east: s.east + d * Math.sin(s.heading),
        north: s.north + d * Math.cos(s.heading),
      };
    },
    until,
  };
}

/**
 * Sets each system's end and its place half an hour after the tick, from
 * the forecast's record of it, matched by its slot and its seed: left
 * unknown for one the forecast does not hold, its place ahead for one gone
 * by then or past the forecast's reach.
 */
export function trackSystems(
  physics: Physics,
  systems: SceneSystem[],
  f: ForecastTold | null,
  tick: number,
): void {
  if (f === null) {
    return;
  }
  const origin = f.head[H.origin] ?? 0;
  for (const s of systems) {
    const r = recordOf(f, s.slot, s.seed);
    if (r === null) {
      continue;
    }
    s.gone = (r[R.gone] ?? 0) + origin;
    const p = tick + AHEAD < s.gone ? recordAt(physics, f, r, tick + AHEAD) : null;
    s.ahead = p === null ? null : { east: p.east, north: p.north };
  }
}

/** The fronts crossing the disk at a tick, from the spells: each line where it is, warm or cold, and how fast it moves. */
export function frontsAt(
  spells: readonly ArrayLike<number>[],
  tick: number,
  reach: number,
): SceneFront[] {
  const out: SceneFront[] = [];
  for (const s of spells) {
    const begin = s[P.begin] ?? 0;
    const change = s[P.change] ?? 0;
    if ((s[P.front] ?? 0) === 0 || !(change > 0) || tick < begin || tick > begin + change) {
      continue;
    }
    const a = ((s[P.toward] ?? 0) / TURN) * 2 * Math.PI;
    const speed = (2 * reach) / change;
    out.push({
      sin: Math.sin(a),
      cos: Math.cos(a),
      line: speed * (tick - begin) - reach,
      warm: (s[P.warm] ?? 0) !== 0,
      speed: speed * SECOND,
    });
  }
  return out;
}

/** The forecast's spells, each a spell record's values. */
function spellsOf(f: ForecastTold): ArrayLike<number>[] {
  return f.spells
    .slice(0, f.head[H.nSpells] ?? f.spells.length)
    .map((s) => s.slice(0, SIZES.spell));
}

/**
 * The weather at a moment, sampled from a module already set to it
 * (useMoment): the grid; the systems of the moment's keyframes, the
 * forecast's ahead, the truth's behind, the present's now, each with its
 * strongest wind, its place half an hour on and its end by the latest
 * forecast; the fronts; and ahead, the gale.
 */
export function sampleScene(
  fields: Fields,
  m: Moment,
  src: WeatherSource,
  look: SceneLook,
  points: Float64Array,
): WeatherScene {
  const grid = sampleGrid(fields, look, points);
  const physics = fields.physics;
  let keys: readonly Keyframe[];
  let spells: readonly ArrayLike<number>[];
  if (m.kind === 'ahead' && m.issue !== null) {
    keys = fields.keys();
    spells = spellsOf(m.issue);
  } else {
    const held = (m.kind === 'past' ? src.forecasts.truthAt(m.tick) : null) ?? src.present();
    keys = held.keys;
    spells = held.spells;
  }
  const systems = systemsOfKeys(keys, m.tick, look.kinds);
  systemWinds(physics, systems);
  trackSystems(physics, systems, m.issue ?? src.forecasts.latest, m.tick);
  const fronts = frontsAt(spells, m.tick, physics.frontReach());
  let gale: WeatherScene['gale'] = null;
  if (m.kind === 'ahead' && m.issue !== null) {
    const g = fields.galeAt(m.issue, m.tick);
    gale = { side: physics.galeSide(), spacing: look.galeGrid, on: Uint8Array.from(g.on) };
  }
  return { moment: m, grid, systems, fronts, gale };
}
