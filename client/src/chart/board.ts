// SPDX-License-Identifier: AGPL-3.0-only

// The harbourmaster's board, as the inshore waters forecast is laid out
// (Met Office): the gale warning in force; the general situation, the
// latest issue's lows, fronts and squalls in plain words, from the
// forecast's own records of the systems and its spells; the port's
// outlook for the next ninety minutes; and its weather now, its box. A
// real harbour posts it at its office ("Weather forecasts will be
// displayed at the Marina Office", Whitby, 2008).

import { catalog } from '../catalog';
import type { ForecastTold } from '../net/messages';
import { issueOf, stepsOf } from '../predict/forecast';
import { RECORDS } from '../predict/layout.gen';
import type { Physics } from '../predict/physics';
import type { Forecasting } from './forecasting';
import { outlookAt, warningInForce, weatherAt } from './placeweather';
import type { ChartStore } from './store';
import { kindDraws } from './weather';
import { type Box, boxOf, generalSituation, type Situation, wordsOf } from './words';

const R = RECORDS.systemRecord;
const Y = RECORDS.system;
const H = RECORDS.forecastHead;
const P = RECORDS.spell;
const MINUTE = 60 * 30;
const TURN = 65536;

/** What the board shows. */
export interface Board {
  port: string;
  warning: string | null;
  situation: string[];
  outlook: string;
  now: Box;
}

/**
 * The general situation's lows, fronts and squalls, from an issue: its
 * storms and lows from their records, each where it is at the issue, or a
 * new low where it is born within the horizon; its fronts from its spells;
 * squalls if a squall or a squall line lives within the horizon, from the
 * spell's wind.
 */
export function situationOf(
  f: ForecastTold,
  port: { name: string; east: number; north: number },
  physics: Physics,
  pressureAt: (east: number, north: number) => number,
  reach: number,
): Situation {
  const kinds = kindDraws(catalog.weather.systems);
  const squally = catalog.weather.systems.map((k) => k.cloud.form === 'cumulonimbus');
  const zones = catalog.world.zones;
  const { steps, step } = stepsOf(f);
  const issue = issueOf(f);
  const horizon = issue + (steps - 1) * step;
  const origin = f.head[H.origin] ?? 0;
  const s: Situation = {
    port: port.name,
    centre: zones.centre * 1852,
    middle: zones.middle * 1852,
    lows: [],
    fronts: [],
    squalls: false,
    from: 0,
  };
  const n = Math.min(f.head[H.nSystems] ?? f.systems.length, f.systems.length);
  for (let i = 0; i < n; i++) {
    const x = f.systems[i] ?? [];
    const kind = x[R.kind] ?? 0;
    const born = (x[R.born] ?? 0) + origin;
    const gone = (x[R.gone] ?? 0) + origin;
    if (gone <= issue || born > horizon) {
      continue;
    }
    if (squally[kind] === true) {
      s.squalls = true;
    }
    if (!((kinds[kind]?.ring ?? 0) > 0)) {
      continue;
    }
    // Where it is at the issue, or just after it is born.
    const at = Math.max(born + 1, issue);
    const y = physics.systemAt(x, at - origin);
    const east = (y[Y.east] ?? 0) / 4;
    const north = (y[Y.north] ?? 0) / 4;
    s.lows?.push({
      forming: born > issue,
      at: (at - issue) / MINUTE,
      pressure: pressureAt(east, north),
      east,
      north,
      heading: ((y[Y.heading] ?? 0) / TURN) * 2 * Math.PI,
      speed: (y[Y.speed] ?? 0) * 0.01,
    });
  }
  let spellFrom = 0;
  for (const sp of f.spells) {
    if ((sp[P.begin] ?? 0) <= issue) {
      spellFrom = ((sp[P.from] ?? 0) / TURN) * 2 * Math.PI;
    }
    const begin = sp[P.begin] ?? 0;
    const change = sp[P.change] ?? 0;
    if ((sp[P.front] ?? 0) === 0 || !(change > 0) || begin + change < issue || begin > horizon) {
      continue;
    }
    const toward = ((sp[P.toward] ?? 0) / TURN) * 2 * Math.PI;
    const along = port.east * Math.sin(toward) + port.north * Math.cos(toward);
    const at = begin + ((along + reach) * change) / (2 * reach);
    if (at < issue) {
      // Its line has passed the port.
      continue;
    }
    s.fronts?.push({ from: toward + Math.PI, at: at <= horizon ? (at - issue) / MINUTE : -1 });
  }
  s.from = spellFrom;
  return s;
}

/** The board of a port, from the forecast held: null before the first issue. */
export async function boardOf(
  src: Forecasting,
  store: ChartStore,
  port: { name: string; east: number; north: number },
): Promise<Board | null> {
  const latest = src.forecasts.latest;
  if (latest === null) {
    return null;
  }
  const fields = await src.made();
  const words = wordsOf(catalog.weather);
  const points = pointsAbout(port.east, port.north);
  const now = boxOf(
    weatherAt(fields, src, { kind: 'now', tick: src.tick(), minutes: 0, issue: null }, points),
    words,
  );
  const outlook = outlookAt(fields, src, points).text;
  fields.forecastAt(latest, issueOf(latest));
  const situation = situationOf(
    latest,
    port,
    fields.physics,
    (e, n) => fields.physics.pressure(e, n),
    fields.physics.frontReach(),
  );
  return {
    port: port.name,
    warning: warningInForce(src, store),
    situation: generalSituation(situation, words),
    outlook,
    now,
  };
}

/** The points about a port its weather is measured at: its quay and eight a quarter of a mile about it. */
function pointsAbout(east: number, north: number): [number, number][] {
  const out: [number, number][] = [[east, north]];
  const r = 0.25 * 1852;
  for (let i = 0; i < 8; i++) {
    const a = i * (Math.PI / 4);
    out.push([east + r * Math.sin(a), north + r * Math.cos(a)]);
  }
  return out;
}
