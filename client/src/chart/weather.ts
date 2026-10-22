// SPDX-License-Identifier: AGPL-3.0-only

// The chart's weather: what the chart shows of the wind, the gusts, the
// rain, the fog, the systems and the pressure at the slider's moment, now,
// a step of the latest forecast, or a time of the last ninety minutes with
// the forecast that was issued for it. Its fields come from the forecast's
// own module (predict/forecast.ts), sampled on a grid over the whole disk,
// uncharted water and all; its systems from the forecast's steps or the
// truth's keyframes; its fronts from the spells. It is painted on a canvas
// of its own over the paper (weatherpaint.ts), so the paper is painted
// once.

import type { ForecastTold } from '../net/messages';
import { type Fields, type Forecasts, issueOf, spellsAbout, stepsOf } from '../predict/forecast';
import { RECORDS, SIZES } from '../predict/layout.gen';
import type { Keyframe } from '../predict/physics';
import type { Where } from './contour';
import type { FogRule, Risk } from './place';

const S = RECORDS.forecastSystem;
const Y = RECORDS.system;
const P = RECORDS.spell;
const H = RECORDS.forecastHead;

/** Ticks a second, and a minute. */
const SECOND = 30;
const MINUTE = 60 * SECOND;
const TURN = 65536;

/** The chart's weather layers, each with its switch; the wind is always on. */
export type Layer = 'gusts' | 'rain' | 'fog' | 'systems' | 'pressure';
export type Layers = Record<Layer, boolean>;

/** The layers at first: all but the pressure, which the barometer's lesson offers. */
export const LAYERS_AT_FIRST: Layers = {
  gusts: true,
  rain: true,
  fog: true,
  systems: true,
  pressure: false,
};

/** The slider's two ways: the forecast ahead, or what happened. */
export type TimeMode = 'forecast' | 'past';

/** How far back "what happened" goes, in its steps of ten minutes. */
export const PAST_STEPS = 9;

/** What the chart shows the weather of. */
export interface Moment {
  kind: 'now' | 'forecast' | 'past';
  /** The tick shown. */
  tick: number;
  /** The forecast drawn: the latest issue ahead, the issue of ninety minutes before in the past; null now. */
  issue: ForecastTold | null;
  /** Ahead, the forecast's step; in the past, the tens of minutes back, negative. */
  step: number;
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

/** The moment the slider shows: its mode and step. Ahead, step 0 is now; a step past the forecast's last is its last. */
export function momentOf(mode: TimeMode, step: number, src: WeatherSource): Moment {
  const now = src.tick();
  if (mode === 'past') {
    const back = Math.min(Math.max(-step, 0), PAST_STEPS);
    if (back === 0) {
      return { kind: 'now', tick: now, issue: null, step: 0 };
    }
    const tick = now - back * 10 * MINUTE;
    const issue = src.forecasts.issueAt(now - 90 * MINUTE) ?? src.forecasts.issueAt(tick);
    return { kind: 'past', tick, issue, step: -back };
  }
  const issue = src.forecasts.latest;
  if (step <= 0 || issue === null) {
    return { kind: 'now', tick: now, issue: null, step: 0 };
  }
  const { steps, step: every } = stepsOf(issue);
  const k = Math.min(step, steps - 1);
  if (k <= 0) {
    return { kind: 'now', tick: now, issue: null, step: 0 };
  }
  return { kind: 'forecast', tick: issueOf(issue) + k * every, issue, step: k };
}

/** How a system is drawn, by its cloud's form: a squall's cell, a shower's heap, a storm's low, a fog bank, a patch of light air. */
export type SystemDraw = 'cell' | 'heap' | 'low' | 'bank' | 'calm';

/** How each kind of system is drawn and named, by the catalog's index. */
export interface KindDraw {
  draw: SystemDraw;
  name: string;
}

/** The catalog's kinds of system, as the chart draws them. */
export function kindDraws(
  systems: readonly { shape: string; cloud: { form: string } }[],
): KindDraw[] {
  return systems.map((k) => {
    switch (k.cloud.form) {
      case 'cumulonimbus':
        return { draw: 'cell', name: 'Squall' };
      case 'cumulus':
        return { draw: 'heap', name: 'Shower' };
      case 'storm':
        return { draw: 'low', name: 'Storm' };
      case 'fog':
        return { draw: 'bank', name: 'Fog' };
    }
    return { draw: 'calm', name: 'Light air' };
  });
}

/** A system as the chart draws it. */
export interface SceneSystem {
  slot: number;
  kind: number;
  draw: SystemDraw;
  name: string;
  east: number;
  north: number;
  /** The direction it moves toward, rad, and how fast, m/s. */
  heading: number;
  speed: number;
  /** Its radius, m, and its strength, 0 to about 1. */
  size: number;
  strength: number;
  /** A low not yet born at the issue, forecast by its plan alone. */
  forming: boolean;
  /** Its cone's radius at this step, m; 0 for the truth. */
  cone: number;
  /** Its forecast track: each step's place it is alive at, with its cone. */
  track: { east: number; north: number; cone: number }[];
}

/** A front's line: the way it moves toward, its line's distance from the centre along it, m, and its band's half-width, m, 0 for the truth. */
export interface SceneFront {
  sin: number;
  cos: number;
  line: number;
  band: number;
}

/** A risk's marks: scattered showers, fog patches, squalls from the windward rim, calms. */
export interface SceneRisk {
  mark: string;
  points: Where[];
  /** For squalls, the direction they come from, rad. */
  from: number;
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
  risks: SceneRisk[];
  /** The gale's points at a forecast's step: the grid's side and spacing, m, and a byte each. */
  gale: { side: number; spacing: number; on: Uint8Array } | null;
  /** In the past, the old forecast's systems, and how many of those with a truth to judge lay inside their cones. */
  forecast: SceneSystem[];
  inside: number;
  judged: number;
}

/** The catalog's numbers the scene is sampled with. */
export interface SceneLook {
  lip: number;
  /** Grid points a side. */
  n: number;
  kinds: readonly KindDraw[];
  /** The cones: m an hour, a forming low's, and a front's speed's standard deviation. */
  perHour: number;
  forming: number;
  front: number;
  /** The gale grid's spacing, m. */
  galeGrid: number;
  risks: readonly Risk[];
  fog: FogRule;
  /** The light air's calm, m/s: calms are marked under it. */
  calm: number;
  /** The regimes' risks' marks, by index. */
  marks: readonly (readonly string[])[];
  /** A thing is seen while the optical depth to it is at most this: the visibility is this over the extinction. */
  contrast: number;
}

/** The standard normal's 90th percentile: a front's band holds its line four times in five. */
const BAND_Z = 1.2815515655446004;

/** Makes the fields the moment's: the forecast's at its step, the truth's in the past, the present now. False if nothing is held for it. */
export function useMoment(fields: Fields, m: Moment, src: WeatherSource): boolean {
  if (m.kind === 'forecast' && m.issue !== null) {
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

/** The truth's systems at a tick, interpolated between the two keyframes about it, as the module does. */
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
  const of = (s: ArrayLike<number>, weight: number): SceneSystem => {
    const kind = s[Y.kind] ?? 0;
    const d = kinds[kind] ?? { draw: 'calm', name: '' };
    return {
      slot: 0,
      kind,
      draw: d.draw,
      name: d.name,
      east: (s[Y.east] ?? 0) / 4,
      north: (s[Y.north] ?? 0) / 4,
      heading: ((s[Y.heading] ?? 0) / TURN) * 2 * Math.PI,
      speed: (s[Y.speed] ?? 0) * 0.01,
      size: s[Y.size] ?? 0,
      strength: ((s[Y.strength] ?? 0) / 4096) * weight,
      forming: false,
      cone: 0,
      track: [],
    };
  };
  for (let slot = 0; slot < n; slot++) {
    const sa = a.systems[slot];
    const sb = b?.systems[slot];
    const same =
      sa !== undefined &&
      sb !== undefined &&
      sa[Y.kind] === sb[Y.kind] &&
      sa[Y.seed] === sb[Y.seed];
    if (same) {
      const va = of(sa, 1);
      const vb = of(sb, 1);
      const turn = Math.atan2(Math.sin(vb.heading - va.heading), Math.cos(vb.heading - va.heading));
      out.push({
        ...va,
        slot,
        east: va.east + u * (vb.east - va.east),
        north: va.north + u * (vb.north - va.north),
        heading: va.heading + u * turn,
        speed: va.speed + u * (vb.speed - va.speed),
        strength: va.strength + u * (vb.strength - va.strength),
      });
      continue;
    }
    if (sa !== undefined && u < 1) {
      out.push({ ...of(sa, 1 - u), slot });
    }
    if (sb !== undefined && u > 0) {
      out.push({ ...of(sb, u), slot });
    }
  }
  return out.filter((s) => s.strength > 0.01);
}

/** A forecast's systems at a tick, between its steps, with their cones and tracks. */
export function systemsOfForecast(f: ForecastTold, tick: number, look: SceneLook): SceneSystem[] {
  const { steps, step } = stepsOf(f);
  const issue = issueOf(f);
  const x = Math.min(Math.max((tick - issue) / step, 0), steps - 1);
  const k = Math.floor(x);
  const u = x - k;
  const out: SceneSystem[] = [];
  for (const s of f.systems) {
    const forming = (s[S.forming] ?? 0) !== 0;
    const at = (i: number) => ({
      east: s[S.east + i] ?? 0,
      north: s[S.north + i] ?? 0,
      strength: (s[S.strength + i] ?? 0) / 256,
    });
    const cone = (lead: number) => (forming ? look.forming : (look.perHour * lead) / (60 * MINUTE));
    const a = at(k);
    const b = at(Math.min(k + 1, steps - 1));
    let strength = a.strength + u * (b.strength - a.strength);
    if (a.strength <= 0 || b.strength <= 0) {
      strength = u < 0.5 ? a.strength : b.strength;
    }
    const track: SceneSystem['track'] = [];
    for (let i = 0; i < steps; i++) {
      const p = at(i);
      if (p.strength > 0) {
        track.push({ east: p.east, north: p.north, cone: cone(i * step) });
      }
    }
    if (strength <= 0) {
      continue;
    }
    const kind = s[S.kind] ?? 0;
    const d = look.kinds[kind] ?? { draw: 'calm' as const, name: '' };
    const hk = u < 0.5 ? k : Math.min(k + 1, steps - 1);
    out.push({
      slot: s[S.slot] ?? 0,
      kind,
      draw: d.draw,
      name: d.name,
      east:
        a.strength > 0 && b.strength > 0
          ? a.east + u * (b.east - a.east)
          : u < 0.5
            ? a.east
            : b.east,
      north:
        a.strength > 0 && b.strength > 0
          ? a.north + u * (b.north - a.north)
          : u < 0.5
            ? a.north
            : b.north,
      heading: ((s[S.heading + hk] ?? 0) / TURN) * 2 * Math.PI,
      speed: (s[S.speed + hk] ?? 0) * 0.01,
      size: s[S.size] ?? 0,
      strength,
      forming,
      cone: cone(tick - issue),
      track,
    });
  }
  return out;
}

/** The fronts crossing the disk at a tick, from the spells: with their forecast bands if lead is given. */
export function frontsAt(
  spells: readonly ArrayLike<number>[],
  tick: number,
  reach: number,
  band: { sigma: number; lead: number } | null,
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
      band: band === null ? 0 : BAND_Z * band.sigma * speed * Math.max(band.lead, 0),
    });
  }
  return out;
}

/** A number in [0, 1) from i and a seed: the same scatter every paint. */
function scatter(i: number, seed: number): number {
  const x = Math.sin((i + 1) * 12.9898 + seed * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** A forecast step's risks: what the regime in effect brings that cannot be placed. */
export function risksAt(
  regime: number,
  grid: FieldGrid,
  look: SceneLook,
  spellFrom: number,
  seed: number,
  sun: (east: number, north: number) => [number, number],
): SceneRisk[] {
  const marks = look.marks[regime] ?? [];
  const out: SceneRisk[] = [];
  const lip = look.lip;
  const rim = lip * 0.93;
  // Every fourth grid point, for the marks over the water.
  const coarse = (keep: (k: number, east: number, north: number) => boolean): Where[] => {
    const pts: Where[] = [];
    const n = grid.n;
    for (let j = 2; j < n; j += 6) {
      for (let i = 2 + ((j / 6) % 2) * 3; i < n; i += 6) {
        const east = ((i + 0.5) / n - 0.5) * 2 * lip;
        const north = (0.5 - (j + 0.5) / n) * 2 * lip;
        if (Math.hypot(east, north) < rim && keep(j * n + i, east, north)) {
          pts.push([east, north]);
        }
      }
    }
    return pts;
  };
  for (const mark of marks) {
    switch (mark) {
      case 'showers': {
        const pts: Where[] = [];
        for (let i = 0; i < 28; i++) {
          const r = rim * Math.sqrt(scatter(i, seed));
          const a = 2 * Math.PI * scatter(i + 100, seed);
          pts.push([r * Math.sin(a), r * Math.cos(a)]);
        }
        out.push({ mark, points: pts, from: 0 });
        break;
      }
      case 'fog-patches':
        out.push({
          mark,
          points: coarse((k, e, n) => {
            const s = sun(e, n);
            return (grid.mean[k] ?? 0) < look.fog.calm && (s[0] < 0 || s[1] < 0);
          }),
          from: 0,
        });
        break;
      case 'calms':
        out.push({ mark, points: coarse((k) => (grid.mean[k] ?? 0) < look.calm), from: 0 });
        break;
      case 'squalls':
        out.push({ mark, points: [], from: spellFrom });
        break;
    }
  }
  return out;
}

/** The spell in effect at a tick: the last to begin by it. */
function spellAt(
  spells: readonly ArrayLike<number>[],
  tick: number,
): ArrayLike<number> | undefined {
  let s: ArrayLike<number> | undefined;
  for (const x of spells) {
    if ((x[P.begin] ?? 0) <= tick) {
      s = x;
    }
  }
  return s ?? spells[0];
}

/** The forecast's spells, each a spell record's values. */
function spellsOf(f: ForecastTold): ArrayLike<number>[] {
  return f.spells
    .slice(0, f.head[H.nSpells] ?? f.spells.length)
    .map((s) => s.slice(0, SIZES.spell));
}

/**
 * The weather at a moment, sampled from a module already set to it
 * (useMoment): the grid, the systems, the fronts, a forecast's risks and
 * its gale; in the past, the old forecast's systems and how many lay
 * inside their cones.
 */
export function sampleScene(
  fields: Fields,
  m: Moment,
  src: WeatherSource,
  look: SceneLook,
  points: Float64Array,
): WeatherScene {
  const grid = sampleGrid(fields, look, points);
  const reach = fields.physics.frontReach();
  let systems: SceneSystem[] = [];
  let fronts: SceneFront[] = [];
  let risks: SceneRisk[] = [];
  let gale: WeatherScene['gale'] = null;
  let forecast: SceneSystem[] = [];
  let inside = 0;
  let judged = 0;
  if (m.kind === 'forecast' && m.issue !== null) {
    const spells = spellsOf(m.issue);
    systems = systemsOfForecast(m.issue, m.tick, look);
    fronts = frontsAt(spells, m.tick, reach, {
      sigma: look.front,
      lead: m.tick - issueOf(m.issue),
    });
    const regime = fields.physics.regimeAt();
    const s = spellAt(spells, m.tick);
    const from = (((s?.[P.from] ?? 0) / TURN) * 2 * Math.PI) as number;
    risks = risksAt(regime, grid, look, from, issueOf(m.issue) / (10 * MINUTE), (e, n) => [
      src.sun(m.tick, e, n),
      src.sun(m.tick - look.fog.dawn, e, n),
    ]);
    const g = fields.galeAt(m.issue, m.tick);
    gale = { side: fields.physics.galeSide(), spacing: look.galeGrid, on: Uint8Array.from(g.on) };
  } else {
    const truth = m.kind === 'past' ? src.forecasts.truthAt(m.tick) : null;
    const keys = truth?.keys ?? src.present().keys;
    const spells = truth?.spells ?? src.present().spells;
    systems = systemsOfKeys(keys, m.tick, look.kinds);
    fronts = frontsAt(spells, m.tick, reach, null);
    if (m.kind === 'past' && m.issue !== null) {
      forecast = systemsOfForecast(m.issue, m.tick, look);
      for (const f of forecast) {
        const t = systems.find((s) => s.slot === f.slot && s.kind === f.kind);
        if (t === undefined) {
          continue;
        }
        judged++;
        if (Math.hypot(t.east - f.east, t.north - f.north) <= f.cone) {
          inside++;
        }
      }
    }
  }
  return { moment: m, grid, systems, fronts, risks, gale, forecast, inside, judged };
}

/** The spells a forecast holds about a tick, for whoever asks the module of them. */
export function forecastSpellsAbout(f: ForecastTold, tick: number): Float64Array[] {
  return spellsAbout(
    spellsOf(f).map((s) => Float64Array.from(s)),
    tick,
  );
}
