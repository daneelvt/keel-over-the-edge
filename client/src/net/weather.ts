// SPDX-License-Identifier: AGPL-3.0-only

// A spell of weather off the wire, as the physics module's spell record
// has it: every field a whole number, in the record's order, so the page
// writes it into the module as it came.

import { RECORDS, SIZES } from '../predict/layout.gen';
import type { Spell } from './gen/keel/v1/game_pb';

const P = RECORDS.spell;

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
  return r;
}
