// SPDX-License-Identifier: AGPL-3.0-only

// The chart made from the catalog, for the game online and the sandbox: its
// store, its view drawn in the sea's place, the notices and the screens'
// needs; and, offline, the sandbox's chart, read from the file go run
// ./tools/dev -world writes beside the world file, charted whole or by the
// lookout as the boat sails.

import { catalog } from '../catalog';
import type { ChartEntry } from '../net/messages';
import { type Physics, VISIBILITY, WIND_VALUE, WIND_VALUES } from '../predict/physics';
import type { SeaScene } from '../render/scene';
import { type ChartSea, chartNews, type NewsSource } from '../ui/chart';
import { type NoticeKind, Notices } from '../ui/notices';
import { Chart } from './chart';
import type { Forecasting } from './forecasting';
import { Models } from './model';
import { type Air, chartedWith, look, type SightExport } from './sight';
import { ChartStore } from './store';
import { type ChartLook, ChartView, type WindSampler } from './view';
import { ChartWeather } from './weatherlayer';

/** The marks of the kinds of place on the chart, by their sites. */
const PLACE_MARKS: Record<string, string> = {
  harbour: '■',
  village: '•',
  anchorage: '⚓',
  reef: '✳',
  bar: '∴',
  wreck: '⋕',
};

/** The marks of the kinds of feature, by the chart's symbol for each. */
const FEATURE_MARKS: Record<string, string> = {
  cave: '◖',
  arch: '⌒',
  blowhole: '⊙',
  fall: '≋',
  spring: '◦',
  crater: '◎',
  smoke: '♨',
  ruin: '⌂',
  birds: '⋎',
};

/** The chart's look, from the catalog. */
export function chartLook(): ChartLook {
  const w = catalog.world;
  const l = w.chart.look;
  return {
    paper: l.paper,
    ink: l.ink,
    sea: l.sea,
    mist: l.mist,
    boat: l.boat,
    light: l.light,
    parallels: l.parallels,
    meridians: l.meridians,
    fps: l.fps,
    wind: l.wind,
    streaks: { ...l.weather.streaks, fade: (l.weather.streaks.fade * 1852) / 3600 },
    lip: w.disk.radius,
    band: w.disk.mist * 1852,
    scale: catalog.sky.scale,
    heights: w.chart.model.heights,
    tops: w.surfaces.map((s) => s.look.top),
    sides: w.surfaces.map((s) => s.look.side),
    characters: w.lights.characters.map((c) => c.notation),
    places: w.places.kinds.map((k) => ({
      water: k.water === true,
      mark: PLACE_MARKS[k.site] ?? '',
      news: k.news === true,
    })),
    great: w.chart.worth.great,
    // A medium island of the centre, or a small one further out.
    middling: 5,
    features: w.features.kinds.map((k) => FEATURE_MARKS[k.symbol ?? ''] ?? ''),
  };
}

/**
 * The mean wind over the disk at the slider's moment, from the weather's
 * scene, whose grid is the streaks' own, rows from the north; before its
 * first scene, as the boat's physics module has it now.
 */
function windOf(world: SeaScene, weather: ChartWeather | null): WindSampler {
  let out = new Float64Array(0);
  return (points, speeds, froms) => {
    const g = weather?.scene?.grid;
    const side = Math.round(Math.sqrt(points.length / 2));
    if (g !== undefined && g.n === side) {
      for (let j = 0; j < side; j++) {
        for (let i = 0; i < side; i++) {
          speeds[j * side + i] = g.mean[(side - 1 - j) * side + i] ?? 0;
          froms[j * side + i] = g.from[(side - 1 - j) * side + i] ?? 0;
        }
      }
      return true;
    }
    const physics = world.ocean.source?.physics;
    if (physics === undefined || world.ocean.source?.weather !== true) {
      return false;
    }
    const n = points.length >> 1;
    if (out.length !== n * WIND_VALUES) {
      out = new Float64Array(n * WIND_VALUES);
    }
    physics.windDrawAt(world.ticks);
    physics.windSample(points, out, n);
    for (let i = 0; i < n; i++) {
      speeds[i] = out[i * WIND_VALUES + WIND_VALUE.meanSpeed] ?? 0;
      froms[i] = out[i * WIND_VALUES + WIND_VALUE.meanFrom] ?? 0;
    }
    return true;
  };
}

/** Everything the chart is made of. */
export interface ChartParts {
  chart: Chart;
  sea: ChartSea;
  notices: Notices;
  /** The chart's weather, null without a forecast. */
  weather: ChartWeather | null;
}

/**
 * Makes the chart, drawn by the world's renderer in the sea's place, its
 * models fetched by models, its weather from the forecast, if any.
 */
export function makeChart(
  world: SeaScene,
  models: Models,
  news: NewsSource | null,
  forecasting: Forecasting | null = null,
): ChartParts {
  const w = catalog.world;
  const store = new ChartStore({
    places: w.places.kinds,
    features: w.features.kinds.map((k) => ({
      name: k.name,
      ...(k.symbol === undefined ? {} : { symbol: k.symbol }),
    })),
    scale: catalog.sky.scale,
    lip: w.disk.radius,
    great: w.chart.worth.great,
  });
  const boat = () => ({
    east: world.pose.east,
    north: world.pose.north,
    heading: world.pose.heading,
  });
  let weather: ChartWeather | null = null;
  const choice = () => ({
    mode: chart.timeMode.value,
    minutes: chart.minutes.value,
    layers: chart.layers.value,
  });
  if (forecasting !== null) {
    weather = new ChartWeather(forecasting, choice, w.chart.look.weather.canvas);
  }
  const view = new ChartView(store, models, chartLook(), boat, windOf(world, weather));
  const notices = new Notices(
    catalog.notices.kinds as unknown as NoticeKind[],
    catalog.notices.queue,
  );
  const chart = new Chart(store, view, notices);
  if (weather !== null) {
    view.attachWeather(weather);
    view.streaksOn = () => chart.layers.value.streaks;
    for (const s of [chart.timeMode, chart.minutes, chart.layers]) {
      s.subscribe(() => view.weatherChanged());
    }
  }
  world.cover = view;
  const motion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  if (motion !== undefined) {
    view.reducedMotion = motion.matches;
    motion.addEventListener('change', () => {
      view.reducedMotion = motion.matches;
    });
  }
  const placeNews = w.places.kinds.map((k) => k.news === true);
  const sea: ChartSea = {
    chart,
    boat,
    scale: catalog.sky.scale,
    lip: w.disk.radius,
    characters: w.lights.characters.map((c) => c.notation),
    columns: catalog.news.columns.map((c) => ({ id: c.id, title: c.title, of: c.of })),
    news:
      news ??
      chartNews(
        store,
        (e) => e.subject === 'island' || (e.subject === 'place' && placeNews[e.sort] === true),
      ),
    forecasting,
    speed: () => 0,
    sunUp: () => world.sky.now.sunHeight > 0,
    steer: null,
  };
  return { chart, sea, notices, weather };
}

/** The sandbox's chart file. */
interface SandboxFile {
  entries: ChartEntry[];
  models: string[];
  known: number[];
  sight: SightExport;
}

/** Fetches the sandbox's chart for a seed: null without one. */
export async function fetchSandboxChart(seed: string): Promise<SandboxFile | null> {
  if (!/^\d+$/.test(seed)) {
    return null;
  }
  const res = await fetch(`/dev-worlds/${seed}.chart`);
  return res.ok ? ((await res.json()) as SandboxFile) : null;
}

/** The sandbox's models, inline in its chart file. */
export function sandboxModels(file: SandboxFile | null): Models {
  const inline = (file?.models ?? []).map((b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));
  return new Models(inline);
}

/** Where the sandbox's lookout is and what it sees by. */
export interface SandboxLookout {
  east: number;
  north: number;
  /** The sun's height at the boat, rad. */
  sun: number;
  /** The boat's physics module, its weather drawn at tick; null for none yet. */
  physics: Physics | null;
  tick: number;
}

/** The sun's last degree below the horizon, rad, across which a light's threshold goes from the day's to night's. */
const LAST_DEGREE = Math.PI / 180;

/**
 * Charts the sandbox's world: whole (?chart=all, and by default), or as the
 * boat's lookout sees it, every half second, by the server's own sight
 * table through the module's weather (?chart=sight), what is known from the
 * start charted at once. A subject sighted is the sailor's, "You". Returns
 * a function that stops it.
 */
export function chartSandbox(
  file: SandboxFile,
  store: ChartStore,
  how: 'all' | 'sight',
  where: () => SandboxLookout,
): () => void {
  const now = Date.now();
  const at = (e: ChartEntry, by: string): ChartEntry => ({ ...e, by, at: now });
  if (how === 'all') {
    store.receive(
      file.entries.map((e) => at(e, '')),
      true,
    );
    return () => {};
  }
  store.me = 'You';
  const charted = new Set<number>(file.known);
  store.receive(
    file.known
      .map((k) => file.entries[k])
      .filter((e) => e !== undefined)
      .map((e) => at(e, '')),
    true,
  );
  const lights = catalog.world.lights;
  const night = Math.log(lights.threshold);
  const day = Math.log(lights.dayThreshold);
  const t = setInterval(() => {
    const p = where();
    const physics = p.physics;
    if (physics === null) {
      return;
    }
    physics.windDrawAt(p.tick);
    const air: Air = {
      depth: (x0, y0, h0, x1, y1, h1) => physics.opticalDepth(x0, y0, h0, x1, y1, h1),
      contrast: catalog.weather.visibility.contrast,
    };
    // Lit while the sun is down, or in poor visibility or worse; seen
    // against the day's threshold while the sun is up, night's a degree
    // below, and between them across the last degree.
    const lit = file.sight.lights.map(
      (l) => p.sun < 0 || physics.visibilityWord(physics.visibilityAt(l.X, l.Y)) >= VISIBILITY.poor,
    );
    const share = Math.min(Math.max((p.sun + LAST_DEGREE) / LAST_DEGREE, 0), 1);
    const thresholds = file.sight.lights.map(() => night + share * (day - night));
    const seen = look(file.sight, p.east, p.north, 2, charted, air, lit, thresholds);
    const out: ChartEntry[] = [];
    for (const s of seen) {
      charted.add(s);
      const e = file.entries[s];
      if (e !== undefined) {
        out.push({ ...at(e, 'You') });
      }
      for (const w of chartedWith(file.sight, s)) {
        const we = file.entries[w];
        if (!charted.has(w) && we !== undefined) {
          charted.add(w);
          out.push({ ...at(we, ''), withSubject: e?.subject ?? null, withNumber: e?.number ?? 0 });
        }
      }
    }
    if (out.length > 0) {
      store.receive(out, false);
    }
  }, 500);
  return () => clearInterval(t);
}
