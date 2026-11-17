// SPDX-License-Identifier: AGPL-3.0-only

// What the map is drawn with, all from the game's catalog (shared/catalog,
// as tools/catalog writes it for the client), read when the Worker is
// built: the chart's paper and ink, its weather's colours and figures, the
// disk, the kinds of place and of boat. The same values the chart screen
// takes in chartLook (client/src/chart/make.ts) and weatherLooks
// (client/src/chart/weatherlayer.ts): a change there is made here too.

import catalogJson from '../../../../client/src/catalog/catalog.gen.json';
import type { PaperLook } from '../../../../client/src/chart/paper.ts';
import type { WeatherLook } from '../../../../client/src/chart/weatherpaint.ts';

interface Catalog {
  world: {
    disk: { radius: number; mist: number };
    chart: {
      look: {
        paper: string;
        ink: string;
        sea: string;
        mist: string;
        parallels: number;
        meridians: number;
        wind: number;
        weather: {
          barbs: number;
          gusts: number;
          rain: string;
          fog: string;
          cold: string;
          warm: string;
          squall: string;
          storm: string;
          wash: { colour: string; forces: number[]; tints: number[] };
        };
      };
      model: { heights: number };
    };
    surfaces: { id: string; cover?: unknown[]; look: { top: string; side: string } }[];
    places: { kinds: { id: string; site: string; water?: boolean; news?: boolean }[] };
  };
  weather: {
    clouds: { rainWords: number[] };
    visibility: { words: number[] };
  };
  sky: { scale: number };
  boats: {
    id: string;
    name: string;
    lengthOverall: number;
    capacity: number;
    physics: {
      hulls: { hullSpacing: number };
      headsails: { headsailArea: number };
      square: { squareForeArea: number; squareAfterArea: number };
    };
  }[];
}

const catalog = catalogJson as unknown as Catalog;
const w = catalog.world;
const l = w.chart.look;

/** The disk's radius, the lip, m. */
export const LIP = w.disk.radius;

/** The paper, as the chart paints it. */
export const PAPER: PaperLook = {
  paper: l.paper,
  ink: l.ink,
  sea: l.sea,
  mist: l.mist,
  parallels: l.parallels,
  meridians: l.meridians,
  lip: LIP,
  band: w.disk.mist * 1852,
  scale: catalog.sky.scale,
};

/** The weather, as the chart paints it. */
export const WEATHER: WeatherLook = {
  ink: l.ink,
  rain: l.weather.rain,
  fog: l.weather.fog,
  cold: l.weather.cold,
  warm: l.weather.warm,
  squall: l.weather.squall,
  storm: l.weather.storm,
  paper: l.paper,
  wash: l.weather.wash,
  barbs: l.weather.barbs * 1852,
  gusts: (l.weather.gusts * 1852) / 3600,
  lip: LIP,
  rainWords: catalog.weather.clouds.rainWords,
  visibility: catalog.weather.visibility.words,
};

/** The chart's grid of the wind, points a side. */
export const GRID = l.wind;

/**
 * The land's green: the mean of the top colours of every surface plants
 * cover, as the chart's models of the land read from afar.
 */
export const GREEN: string = (() => {
  const tops = w.surfaces.filter((s) => (s.cover?.length ?? 0) > 0).map((s) => s.look.top);
  if (tops.length === 0) {
    return l.paper;
  }
  let out = '#';
  for (const shift of [16, 8, 0]) {
    const sum = tops.reduce((n, t) => n + ((Number.parseInt(t.slice(1), 16) >> shift) & 255), 0);
    out += Math.round(sum / tops.length)
      .toString(16)
      .padStart(2, '0');
  }
  return out;
})();

/** The kinds of place: whether lettered as water, and whether its charting is news. */
export const PLACE_KINDS = w.places.kinds;

/** The boats: each one's length overall, m. */
export const BOATS = catalog.boats;

/** A boat's figures for the map: its hulls, its masts and how it is rigged. */
export interface Rig {
  hulls: 1 | 2;
  /** Fore-and-aft sails: main, and a jib before the mast. */
  jib: boolean;
  /** Square-rigged masts, or 0 for a fore-and-aft rig. */
  masts: number;
}

/**
 * A boat's rig, from its physics: two hulls where they stand apart, a jib
 * where it has headsails, and square sails on a fore mast and the masts of
 * an after group (two, as a ship's main and mizzen) where it carries them.
 */
export function rigOf(id: string): Rig {
  const p = catalog.boats.find((k) => k.id === id)?.physics;
  if (p === undefined) {
    return { hulls: 1, jib: false, masts: 0 };
  }
  const fore = p.square.squareForeArea > 0 ? 1 : 0;
  const after = p.square.squareAfterArea > 0 ? 2 : 0;
  return {
    hulls: p.hulls.hullSpacing > 0 ? 2 : 1,
    jib: p.headsails.headsailArea > 0,
    masts: fore + after,
  };
}
