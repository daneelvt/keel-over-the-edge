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
  r[P.warm] = s.warm ? 1 : 0;
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
      r[Y.length] = s.length;
      return [s.slot, r];
    }),
  };
}

const H = RECORDS.forecastHead;
const R = RECORDS.systemRecord;

/** A Forecast as the module's records' values: its head, spells and systems' records, and its gale warning. */
export function forecastTold(f: Forecast): ForecastTold {
  const head = new Array<number>(SIZES.forecastHead).fill(0);
  head[H.issue] = Number(f.issue);
  head[H.steps] = f.steps;
  head[H.step] = f.step;
  head[H.until] = Number(f.until);
  head[H.every] = f.every;
  head[H.origin] = Number(f.origin);
  head[H.nSpells] = f.spells.length;
  head[H.nSystems] = f.systems.length;
  f.shifts.forEach((s, i) => {
    head[H.shifts + i] = s;
  });
  const systems = f.systems.map((s, i) => {
    head[H.slots + i] = s.slot;
    const r = new Array<number>(SIZES.systemRecord).fill(0);
    r[R.kind] = s.kind;
    r[R.seed] = s.seed;
    r[R.born] = Number(s.born);
    r[R.mature] = Number(s.mature);
    r[R.decays] = Number(s.decays);
    r[R.gone] = Number(s.gone);
    r[R.track] = s.track;
    r[R.east] = s.east;
    r[R.north] = s.north;
    r[R.heading] = s.heading;
    r[R.speed] = s.speed;
    r[R.radius] = s.radius;
    r[R.angle] = s.angle;
    r[R.sense] = s.sense;
    r[R.inward] = s.inward;
    r[R.size] = s.size;
    r[R.peak] = s.peak;
    r[R.depth] = s.depth;
    r[R.length] = s.length;
    r[R.wobble] = s.wobble;
    for (let k = 0; k < 2; k++) {
      r[R.wobblePeriod + k] = s.wobblePeriod[k] ?? 0;
      r[R.wobblePhase + k] = s.wobblePhase[k] ?? 0;
    }
    r[R.throb] = s.throb;
    r[R.throbPeriod] = s.throbPeriod;
    r[R.throbPhase] = s.throbPhase;
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
