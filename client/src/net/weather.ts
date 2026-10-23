// SPDX-License-Identifier: AGPL-3.0-only

// A spell of weather and a keyframe of the weather systems off the wire,
// as the physics module's spell and system records have them: every field
// a whole number, in the record's order, so the page writes it into the
// module as it came.

import { RECORDS, SIZES } from '../predict/layout.gen';
import {
  ChartSubject,
  type ComingFront,
  type Forecast,
  type ForecastPast,
  type GaleWarning,
  type Keyframe,
  type Spell,
} from './gen/keel/v1/game_pb';
import type { ForecastTold, GaleTold, PastTold, WeatherKeyframe } from './messages';

const P = RECORDS.spell;
const Y = RECORDS.system;

/** A WeatherSystems's spell as a spell record's values. */
export function spellRecord(s: Spell): number[] {
  const r = new Array<number>(SIZES.spell).fill(0);
  r[P.begin] = Number(s.begin);
  r[P.change] = s.change;
  r[P.start] = Number(s.start);
  r[P.length] = Number(s.length);
  r[P.regime] = s.regime;
  r[P.steady] = s.steady ? 1 : 0;
  r[P.speed] = s.speed;
  r[P.from] = s.from;
  r[P.drift] = s.drift;
  r[P.gust] = s.gust;
  for (let i = 0; i < 2; i++) {
    r[P.shift + i] = s.shift[i] ?? 0;
    r[P.period + i] = s.period[i] ?? 0;
    r[P.phase + i] = s.phase[i] ?? 0;
  }
  r[P.across] = s.across;
  r[P.axis] = s.axis;
  r[P.axisPeriod] = s.axisPeriod;
  r[P.seed] = s.seed;
  r[P.pressure] = s.pressure;
  r[P.front] = s.front ? 1 : 0;
  r[P.toward] = s.toward;
  r[P.trough] = s.trough;
  r[P.still] = s.still ? 1 : 0;
  return r;
}

/** A WeatherSystems's coming front as a coming record's values: all nought for none. */
export function comingRecord(c: ComingFront | undefined): number[] {
  const r = new Array<number>(SIZES.coming).fill(0);
  if (c !== undefined) {
    const C = RECORDS.coming;
    r[C.on] = 1;
    r[C.begin] = Number(c.begin);
    r[C.change] = c.change;
    r[C.toward] = c.toward;
  }
  return r;
}

/** A WeatherSystems's keyframe, each system as a system record's values. */
export function keyframeRecord(k: Keyframe): WeatherKeyframe {
  return {
    tick: Number(k.tick),
    systems: k.systems.map((s) => {
      const r = new Array<number>(SIZES.system).fill(0);
      r[Y.on] = 1;
      r[Y.kind] = s.kind;
      r[Y.seed] = s.seed;
      r[Y.stage] = s.stage;
      r[Y.east] = s.east;
      r[Y.north] = s.north;
      r[Y.heading] = s.heading;
      r[Y.speed] = s.speed;
      r[Y.strength] = s.strength;
      r[Y.size] = s.size;
      r[Y.peak] = s.peak;
      r[Y.depth] = s.depth;
      return [s.slot, r];
    }),
  };
}

const H = RECORDS.forecastHead;
const S = RECORDS.forecastSystem;

/** A Forecast as the module's records' values: its head, spells and systems, and its gale warning. */
export function forecastTold(f: Forecast): ForecastTold {
  const head = new Array<number>(SIZES.forecastHead).fill(0);
  head[H.issue] = Number(f.issue);
  head[H.steps] = f.steps;
  head[H.step] = f.step;
  head[H.nSpells] = f.spells.length;
  head[H.nSystems] = f.systems.length;
  f.shifts.forEach((s, i) => {
    head[H.shifts + i] = s;
  });
  const systems = f.systems.map((s) => {
    const r = new Array<number>(SIZES.forecastSystem).fill(0);
    r[S.slot] = s.slot;
    r[S.kind] = s.kind;
    r[S.seed] = s.seed;
    r[S.size] = s.size;
    r[S.peak] = s.peak;
    r[S.depth] = s.depth;
    r[S.forming] = s.forming ? 1 : 0;
    r[S.crosses] = Number(s.crosses);
    r[S.crossEast] = s.crossEast;
    r[S.crossNorth] = s.crossNorth;
    for (let k = 0; k < f.steps; k++) {
      r[S.east + k] = s.east[k] ?? 0;
      r[S.north + k] = s.north[k] ?? 0;
      r[S.heading + k] = s.heading[k] ?? 0;
      r[S.speed + k] = s.speed[k] ?? 0;
      r[S.strength + k] = s.strength[k] ?? 0;
    }
    return r;
  });
  return { head, spells: f.spells.map(spellRecord), systems, gale: galeTold(f.gale) };
}

/** A gale warning off the wire, or null for none. */
export function galeTold(g: GaleWarning | undefined): GaleTold | null {
  if (g === undefined) {
    return null;
  }
  const subject =
    g.subject === ChartSubject.ISLAND
      ? 'island'
      : g.subject === ChartSubject.PLACE
        ? 'place'
        : null;
  return {
    key: Number(g.key),
    steps: g.steps,
    first: g.first,
    force: g.force,
    from: (g.from / 65536) * 2 * Math.PI,
    east: g.east,
    north: g.north,
    place: subject === null ? null : { subject, number: g.number },
  };
}

/** What has been, off the wire, or null. */
export function pastTold(p: ForecastPast | undefined): PastTold | null {
  if (p === undefined || p.issue === undefined) {
    return null;
  }
  return {
    issue: forecastTold(p.issue),
    truth: p.truth.map(keyframeRecord),
    spells: p.spells.map(spellRecord),
  };
}
