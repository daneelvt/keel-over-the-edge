// SPDX-License-Identifier: AGPL-3.0-only

// The harbourmaster's board, as the inshore waters forecast is laid out
// (Met Office): the gale warning in force; the general situation, the
// latest issue's lows, fronts and squalls in plain words; the port's
// outlook for the next ninety minutes; and its weather now, its box. A
// real harbour posts it at its office ("Weather forecasts will be
// displayed at the Marina Office", Whitby, 2008).

import { catalog } from '../catalog';
import type { ForecastTold } from '../net/messages';
import { issueOf, stepsOf } from '../predict/forecast';
import { RECORDS } from '../predict/layout.gen';
import type { Forecasting } from './forecasting';
import { outlookAt, warningInForce, weatherAt } from './placeweather';
import type { ChartStore } from './store';
import { kindDraws } from './weather';
import { type Box, boxOf, generalSituation, type Situation, wordsOf } from './words';

const S = RECORDS.forecastSystem;
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

/** The general situation's lows, fronts and squalls, from an issue. */
export function situationOf(
  f: ForecastTold,
  port: { name: string; east: number; north: number },
  pressureAt: (east: number, north: number) => number,
  reach: number,
  regime: number,
): Situation {
  const kinds = kindDraws(catalog.weather.systems);
  const zones = catalog.world.zones;
  const { steps, step } = stepsOf(f);
  const issue = issueOf(f);
  const s: Situation = {
    port: port.name,
    centre: zones.centre * 1852,
    middle: zones.middle * 1852,
    lows: [],
    fronts: [],
    squalls: false,
    from: 0,
  };
  for (const x of f.systems) {
    if (kinds[x[S.kind] ?? 0]?.draw !== 'low') {
      continue;
    }
    let k = 0;
    while (k < steps && !((x[S.strength + k] ?? 0) > 0)) {
      k++;
    }
    if (k >= steps) {
      continue;
    }
    const east = x[S.east + k] ?? 0;
    const north = x[S.north + k] ?? 0;
    s.lows?.push({
      forming: (x[S.forming] ?? 0) !== 0,
      at: (k * step) / MINUTE,
      pressure: pressureAt(east, north),
      east,
      north,
      heading: ((x[S.heading + k] ?? 0) / TURN) * 2 * Math.PI,
      speed: (x[S.speed + k] ?? 0) * 0.01,
    });
  }
  const horizon = issue + (steps - 1) * step;
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
  const marks: readonly string[] =
    catalog.weather.forecast.risks.find((r) => r.regime === catalog.weather.regimes[regime]?.id)
      ?.marks ?? [];
  s.squalls = marks.includes('squalls');
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
    weatherAt(fields, src, { kind: 'now', tick: src.tick(), issue: null, step: 0 }, points),
    words,
  );
  const outlook = outlookAt(fields, src, points).text;
  fields.forecastAt(latest, issueOf(latest));
  const regime = fields.physics.regimeAt();
  const situation = situationOf(
    latest,
    port,
    (e, n) => fields.physics.pressure(e, n),
    fields.physics.frontReach(),
    regime,
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
