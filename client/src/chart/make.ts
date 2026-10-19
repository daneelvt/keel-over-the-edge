// SPDX-License-Identifier: AGPL-3.0-only

// The chart made from the catalog, for the game online and the sandbox: its
// store, its view drawn in the sea's place, the notices and the screens'
// needs; and, offline, the sandbox's chart, read from the file go run
// ./tools/dev -world writes beside the world file, charted whole or by the
// lookout as the boat sails.

import { catalog } from '../catalog';
import type { ChartEntry } from '../net/messages';
import { WIND_VALUE, WIND_VALUES } from '../predict/physics';
import type { SeaScene } from '../render/scene';
import { type ChartSea, chartNews, type NewsSource } from '../ui/chart';
import { type NoticeKind, Notices } from '../ui/notices';
import { Chart } from './chart';
import { Models } from './model';
import { chartedWith, look, type SightExport } from './sight';
import { ChartStore } from './store';
import { type ChartLook, ChartView, type WindSampler } from './view';

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

/** The mean wind over the disk, as the boat's physics module has it. */
function windOf(world: SeaScene): WindSampler {
  let out = new Float64Array(0);
  return (points, speeds, froms) => {
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
}

/** Makes the chart, drawn by the world's renderer in the sea's place, its models fetched by models. */
export function makeChart(world: SeaScene, models: Models, news: NewsSource | null): ChartParts {
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
  const view = new ChartView(store, models, chartLook(), boat, windOf(world));
  const notices = new Notices(
    catalog.notices.kinds as unknown as NoticeKind[],
    catalog.notices.queue,
  );
  const chart = new Chart(store, view, notices);
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
    news:
      news ??
      chartNews(
        store,
        (e) => e.subject === 'island' || (e.subject === 'place' && placeNews[e.sort] === true),
      ),
  };
  return { chart, sea, notices };
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

/**
 * Charts the sandbox's world: whole (?chart=all, and by default), or as the
 * boat's lookout sees it, every half second, by the server's own sight
 * table (?chart=sight), what is known from the start charted at once. A
 * subject sighted is the sailor's, "You". Returns a function that stops it.
 */
export function chartSandbox(
  file: SandboxFile,
  store: ChartStore,
  how: 'all' | 'sight',
  where: () => { east: number; north: number; night: boolean },
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
  const t = setInterval(() => {
    const p = where();
    const lit = file.sight.lights.map(() => p.night);
    const seen = look(file.sight, p.east, p.north, 2, charted, lit);
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
