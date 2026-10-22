// SPDX-License-Identifier: AGPL-3.0-only

// A place's weather as its box and its harbourmaster's board give it: its
// lines at the slider's moment, now, a step of the forecast or a time of
// the past; its outlook for the latest issue's horizon, in the words of the
// shipping forecast; and the gale warning in force at its head when the
// place's own outlook reaches a gale.

import { catalog } from '../catalog';
import type { ChartEntry, GaleTold } from '../net/messages';
import type { Fields } from '../predict/forecast';
import { issueOf, stepsOf } from '../predict/forecast';
import type { Forecasting } from './forecasting';
import { placeAt, placePoints, risksOf } from './place';
import type { ChartStore } from './store';
import { type Moment, useMoment } from './weather';
import {
  type Box,
  boxOf,
  forceOf,
  type OutlookSample,
  outlook,
  type PlaceWeather,
  type Warning,
  warningText,
  wordsOf,
} from './words';

const MINUTE = 60 * 30;

/** A place's weather, its outlook and the gale warning at its head, if any. */
export interface PlaceWords {
  box: Box;
  outlook: string;
  warning: string | null;
}

/** Where a charted entry's weather is measured. */
export function pointsOf(
  e: Pick<ChartEntry, 'east' | 'north' | 'bounds' | 'subject'>,
): [number, number][] {
  return placePoints(e.east, e.north, e.subject === 'island' ? e.bounds : null);
}

/** The pressure at a point at a tick, the fields set to the moment's kind at that tick. */
function pressureAt(
  fields: Fields,
  src: Forecasting,
  m: Moment,
  tick: number,
  east: number,
  north: number,
): number {
  const at: Moment = { ...m, tick };
  if (m.kind === 'now') {
    // Before now, the truth kept; now itself, the present.
    const truth = tick < m.tick ? src.forecasts.truthAt(tick) : null;
    if (truth !== null) {
      fields.truthAt(truth.keys, truth.spells, tick);
    } else {
      useMoment(fields, at, src);
    }
  } else if (!useMoment(fields, at, src)) {
    useMoment(fields, { ...m, kind: 'now', tick: src.tick() }, src);
  }
  return fields.physics.pressure(east, north);
}

/** A place's weather at a moment, from the fields: its points', its pressures then and before, its risk. */
export function weatherAt(
  fields: Fields,
  src: Forecasting,
  m: Moment,
  points: [number, number][],
): PlaceWeather {
  const [cx, cy] = points[0] ?? [0, 0];
  const pressures: [number, number, number] = [
    pressureAt(fields, src, m, m.tick, cx, cy),
    pressureAt(fields, src, m, m.tick - 5 * MINUTE, cx, cy),
    pressureAt(fields, src, m, m.tick - 15 * MINUTE, cx, cy),
  ];
  useMoment(fields, m, src);
  const { risks, fog } = risksOf(catalog.weather);
  const sun: [number, number] = [src.sun(m.tick, cx, cy), src.sun(m.tick - fog.dawn, cx, cy)];
  return placeAt(fields.physics, points, pressures, risks, fog, sun);
}

/** A place's outlook for the latest issue's horizon, and whether it reaches a gale. */
export function outlookAt(
  fields: Fields,
  src: Forecasting,
  points: [number, number][],
): { text: string; gale: boolean } {
  const issue = src.forecasts.latest;
  if (issue === null) {
    return { text: '', gale: false };
  }
  const words = wordsOf(catalog.weather);
  const { risks, fog } = risksOf(catalog.weather);
  const [cx, cy] = points[0] ?? [0, 0];
  const at = issueOf(issue);
  const { steps, step } = stepsOf(issue);
  const last = at + (steps - 1) * step;
  const samples: OutlookSample[] = [];
  let gale = false;
  for (const minutes of catalog.weather.forecast.outlook.samples) {
    const tick = at + minutes * MINUTE;
    if (tick > last) {
      break;
    }
    fields.forecastAt(issue, tick);
    const sun: [number, number] = [src.sun(tick, cx, cy), src.sun(tick - fog.dawn, cx, cy)];
    const w = placeAt(fields.physics, points, [0, 0, 0], risks, fog, sun);
    samples.push({ ...w, at: minutes });
    const means = w.points.map((p) => p.mean).sort((a, b) => a - b);
    const gusts = w.points.map((p) => p.gust).sort((a, b) => a - b);
    const p80 = (a: number[]) => a[Math.floor(0.8 * (a.length - 1) + 0.5)] ?? 0;
    gale ||=
      forceOf(p80(means)) >= 8 || p80(gusts) >= (catalog.weather.forecast.gale.gust * 1852) / 3600;
  }
  const end = src.end();
  return { text: outlook(samples, end > 0 && end <= last, words), gale };
}

/** A gale warning in the page's words, its place named from the chart. */
export function warningOf(g: GaleTold, store: ChartStore): Warning {
  const place = g.place === null ? undefined : store.get(g.place.subject, g.place.number);
  return {
    from: g.from,
    force: g.force,
    first: g.first * catalog.weather.forecast.step,
    east: g.east,
    north: g.north,
    place: place?.name ?? '',
    placeEast: place?.east ?? 0,
    placeNorth: place?.north ?? 0,
  };
}

/** The gale warning in force, in a sentence, or null. */
export function warningInForce(src: Forecasting, store: ChartStore): string | null {
  const g = src.forecasts.latest?.gale ?? null;
  return g === null ? null : warningText(warningOf(g, store), wordsOf(catalog.weather));
}

/** A place's words at a moment: its box's lines, its outlook, and the warning at its head if its outlook reaches a gale. */
export async function placeWords(
  src: Forecasting,
  m: Moment,
  points: [number, number][],
  store: ChartStore,
): Promise<PlaceWords> {
  const fields = await src.made();
  const words = wordsOf(catalog.weather);
  const box = boxOf(weatherAt(fields, src, m, points), words);
  const o = outlookAt(fields, src, points);
  const w = warningInForce(src, store);
  return { box, outlook: o.text, warning: o.gale ? w : null };
}
