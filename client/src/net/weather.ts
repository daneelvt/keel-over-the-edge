// SPDX-License-Identifier: AGPL-3.0-only

// A spell of weather and a keyframe of the weather systems off the wire,
// as the physics module's spell and system records have them: every field
// a whole number, in the record's order, so the page writes it into the
// module as it came.

import { RECORDS, SIZES } from '../predict/layout.gen';
import type { ComingFront, Keyframe, Spell } from './gen/keel/v1/game_pb';
import type { WeatherKeyframe } from './messages';

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
