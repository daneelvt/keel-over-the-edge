// SPDX-License-Identifier: AGPL-3.0-only

// What a frame costs, measured by hand on a developer's machine (not in CI):
// the GPU's, the main thread's, and what the page asks of the GPU. It starts
// its own Vite, opens the offline sandbox in the installed Chrome (seed 1's
// world, the jolly boat off Port Royal: go run ./tools/dev -world 1 first),
// and prints Markdown tables, ready for a pull request.
//
//	node e2e/framecost.ts                     every section, three runs each
//	node e2e/framecost.ts --only gpu,counts   some sections
//	node e2e/framecost.ts --json after.json --compare before.json
//
// The sections, each of which can be run alone:
//
//   - ladder: each rung of the ladders' pixel ratio, at device pixel ratios
//     1, 1.25, 1.5, 2 and 3. No browser: quality.ts is loaded through Vite.
//   - gpu: each rung's median interval between drawn frames with the
//     frame rate limit and vsync off, the frame cap drawing every frame,
//     at a fixed 5,120 × 2,880 device pixels. A GPU fast enough to hold 60
//     on every rung still shows each rung's cost so: the interval is the
//     frame's cost, not the display's.
//   - parts: the high tier's frame and the low tier's at the same size,
//     with its parts hidden one after another (PARTS below), each step's
//     interval, and the share of the part it hid.
//   - layers: the sea's layers (seamaterial.ts's SEA_LAYERS) and the
//     sky's (sky.ts's SKY_LAYERS) at the parts section's size, on the high
//     tier's first rung and the low tier's, each left out alone, its shader
//     built without it, and the rest drawn; then the sea and the sky each
//     built bare and each hidden, and the antialiasing off. A layer's share
//     is the frame with everything less the frame without it.
//   - cpu: the main thread's work a drawn frame (the scene's update and
//     three.js's draw), median and 90th percentile, at 1,366 × 768 under
//     Chrome's 4× CPU throttle, in the jolly boat and in the tall ship
//     sailed alone, on the high tier and the low.
//   - counts: on each tier, the buffer writes and their bytes, the texture
//     writes, the render passes, the compute dispatches, the draws and the
//     triangles a frame over 60 frames, the largest writes by what they
//     were written for, and three.js's passes.
//
// Options: --port (Vite's, default 5292), --runs (default 3: each number is
// the median of the runs' medians), --backend webgl2 (WebGPU by default),
// --headed, --settle and --measure (ms, each step's), --rungs (the gpu
// section's, as 0,5,6,10; all by default), --boats, --layers (the layers
// section's, as glints,foam; all by default), --tiers (the parts and
// layers sections', as low; high,low by default), --json (writes every
// number), --md (writes the tables), --compare (an earlier --json, printed
// before → after; with --after, two files compared and nothing run).
//
// Timings vary run to run and with whatever else the machine is doing:
// measure before and after in one sitting, with nothing else running.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Browser, Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import type { FrameReport } from '../src/dev/counts.ts';
import type { KeelHooks } from '../src/dev/hooks.ts';
import {
  COUNT_NAMES,
  type CountName,
  type CountsResult,
  type CountsRow,
  type CpuResult,
  type CpuRow,
  compare,
  type GpuResult,
  type GpuRow,
  type LadderResult,
  type LayersResult,
  measured,
  median,
  type PartStep,
  type PartsResult,
  type Results,
  report,
} from './framestats.ts';

declare global {
  // The hooks the game's page puts on window with ?test.
  var keel: KeelHooks;
}

/**
 * A part of the frame, hidden as well as every part above it in PARTS: hide
 * runs in the page (as page.evaluate runs it, so it reaches the page only
 * through globalThis.keel). To measure a new part, add it here; a part the
 * shader draws (one of the sea's layers) is turned off by its uniform or
 * define from its hook.
 */
export interface Part {
  name: string;
  hide: () => void | Promise<void>;
}

export const PARTS: Part[] = [
  {
    name: 'Antialiasing off',
    hide: () => globalThis.keel.world.stage.setAntialias('none'),
  },
  {
    name: 'Land hidden',
    hide: () => globalThis.keel.keepHidden(globalThis.keel.world.land?.group, true),
  },
  {
    name: 'Clouds hidden',
    hide: () => {
      const k = globalThis.keel;
      k.keepHidden(k.world.weather.clouds.mesh, true);
      k.keepHidden(k.world.weather.curtains.mesh, true);
    },
  },
  {
    name: 'Near sea tiles hidden',
    hide: () => globalThis.keel.keepHidden(globalThis.keel.world.ocean.tiles.mesh, true),
  },
  {
    name: 'Far sea hidden',
    hide: () => globalThis.keel.keepHidden(globalThis.keel.world.ocean.far.mesh, true),
  },
  {
    name: 'Sky hidden',
    hide: () => globalThis.keel.keepHidden(globalThis.keel.world.sky.mesh, true),
  },
  {
    name: 'Own boat hidden',
    hide: () => globalThis.keel.keepHidden(globalThis.keel.world.boat?.root, true),
  },
];

const SECTIONS = ['ladder', 'gpu', 'parts', 'layers', 'cpu', 'counts'] as const;
type Section = (typeof SECTIONS)[number];

/** The device pixel ratios the ladder is read at. */
const DPRS = [1, 1.25, 1.5, 2, 3];
/** The fixed canvas of the gpu and parts sections: a viewport at a device pixel ratio, drawn at that ratio. */
const BIG = { width: 2560, height: 1440, dpr: 2 };
/** The cpu and counts sections' window, a common laptop's, and the CPU throttle. */
const LAPTOP = { width: 1366, height: 768, dpr: 1 };
const THROTTLE = 4;
const COUNT_FRAMES = 60;

const here = dirname(fileURLToPath(import.meta.url));
const client = join(here, '..');

interface Options {
  only: Section[];
  port: number;
  runs: number;
  backend: 'webgpu' | 'webgl2';
  headed: boolean;
  settle: number;
  measure: number;
  rungs: number[] | null;
  boats: string[];
  layers: string[] | null;
  tiers: string[] | null;
  json: string | null;
  md: string | null;
  compare: string | null;
  after: string | null;
}

function options(): Options {
  const { values } = parseArgs({
    options: {
      only: { type: 'string' },
      port: { type: 'string' },
      runs: { type: 'string' },
      backend: { type: 'string' },
      headed: { type: 'boolean' },
      settle: { type: 'string' },
      measure: { type: 'string' },
      rungs: { type: 'string' },
      boats: { type: 'string' },
      layers: { type: 'string' },
      tiers: { type: 'string' },
      json: { type: 'string' },
      md: { type: 'string' },
      compare: { type: 'string' },
      after: { type: 'string' },
    },
  });
  const only = (values.only ?? SECTIONS.join(',')).split(',').filter((s) => s !== '');
  for (const s of only) {
    if (!(SECTIONS as readonly string[]).includes(s)) {
      throw new Error(`no section ${s}: ${SECTIONS.join(', ')}`);
    }
  }
  const backend = values.backend ?? 'webgpu';
  if (backend !== 'webgpu' && backend !== 'webgl2') {
    throw new Error(`--backend is webgpu or webgl2, not ${backend}`);
  }
  return {
    only: only as Section[],
    port: Number(values.port ?? 5292),
    runs: Math.max(1, Number(values.runs ?? 3)),
    backend,
    headed: values.headed ?? false,
    settle: Number(values.settle ?? 2000),
    measure: Number(values.measure ?? 3000),
    rungs: values.rungs === undefined ? null : values.rungs.split(',').map(Number),
    boats: (values.boats ?? 'jolly-boat,tall-ship').split(','),
    layers: values.layers === undefined ? null : values.layers.split(','),
    tiers: values.tiers === undefined ? null : values.tiers.split(','),
    json: values.json ?? null,
    md: values.md ?? null,
    compare: values.compare ?? null,
    after: values.after ?? null,
  };
}

function say(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** Whether nothing listens on the port. */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = netServer();
    s.once('error', () => resolve(false));
    s.listen(port, () => s.close(() => resolve(true)));
  });
}

/** Vite on the port, from the client's own config, as the browser tests run it. */
async function startVite(port: number): Promise<ViteDevServer> {
  if (!(await portFree(port))) {
    throw new Error(`port ${port} is taken: give another with --port`);
  }
  const { createServer } = await import('vite');
  process.chdir(client);
  const server = await createServer({
    configFile: join(client, 'vite.config.ts'),
    root: client,
    logLevel: 'warn',
    server: { port, strictPort: true },
  });
  await server.listen();
  return server;
}

/** The ladders' pixel ratios, from quality.ts as it is in this tree. */
async function ladderSection(vite: ViteDevServer | null): Promise<LadderResult> {
  let own: ViteDevServer | null = null;
  if (vite === null) {
    const { createServer } = await import('vite');
    own = await createServer({
      configFile: false,
      root: client,
      logLevel: 'warn',
      appType: 'custom',
      server: { middlewareMode: true, hmr: false },
    });
  }
  const server = (vite ?? own) as ViteDevServer;
  try {
    const q = (await server.ssrLoadModule('/src/render/quality.ts')) as {
      ladder(top: string): object[];
      pixelRatioOf(rung: object, dpr: number, ...rest: unknown[]): number;
      rungName(rung: object): string;
    };
    const ladders = ['high', 'medium', 'low'].map((top) => ({
      top,
      rows: q.ladder(top).map((rung, index) => ({
        index,
        name: q.rungName(rung),
        // A display's height in CSS pixels, for a ladder that keeps to a
        // least number of lines: a common laptop's.
        ratios: DPRS.map((dpr) => q.pixelRatioOf(rung, dpr, LAPTOP.height)),
      })),
    }));
    return { dprs: DPRS, ladders };
  } finally {
    await own?.close();
  }
}

async function launch(o: Options, unlimited: boolean): Promise<Browser> {
  const { chromium } = await import('@playwright/test');
  const args = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'];
  if (unlimited) {
    args.push('--disable-frame-rate-limit', '--disable-gpu-vsync');
  }
  return chromium.launch({ channel: 'chrome', headless: !o.headed, args });
}

/**
 * Opens the sandbox in a page of its own at a size, with the test hooks,
 * the screen's panels hidden, the chase camera, the frame cap drawing every
 * animation frame, and the frame loop drawing as a player's does.
 */
async function openSandbox(
  browser: Browser,
  o: Options,
  base: string,
  size: { width: number; height: number; dpr: number },
  query = '',
): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: size.dpr,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const backend = o.backend === 'webgl2' ? '&backend=webgl2' : '';
  await page.goto(`${base}/?sandbox&test&world=1${backend}${query}`);
  await page.waitForFunction(() => globalThis.keel !== undefined, null, { timeout: 60_000 });
  await page.evaluate(() => globalThis.keel.ready());
  if (errors.length > 0) {
    throw new Error(`the page failed: ${errors.join('; ')}`);
  }
  const info = await page.evaluate(() => globalThis.keel.info());
  if (info.backend !== o.backend) {
    throw new Error(`the page draws on ${info.backend}, not ${o.backend}`);
  }
  await page.addStyleTag({ content: '.hud { visibility: hidden; }' });
  await page.evaluate(() => {
    const k = globalThis.keel;
    k.camera('chase');
    k.capFrames(1);
    k.thaw();
  });
  return page;
}

async function closePage(page: Page): Promise<void> {
  await page.context().close();
}

/** The frames drawn over ms, after settle ms: the main thread's work and the intervals. */
async function timed(page: Page, settle: number, ms: number): Promise<FrameReport> {
  await page.waitForTimeout(settle);
  return page.evaluate(async (ms) => {
    const k = globalThis.keel;
    k.countStart({ gpu: false });
    await new Promise((r) => setTimeout(r, ms));
    return k.countStop() as FrameReport;
  }, ms);
}

/** The index of the first rung of a tier on the page's ladder. */
async function firstOf(page: Page, tier: string): Promise<{ index: number; name: string }> {
  const rungs = await page.evaluate(() => globalThis.keel.info().rungs);
  const index = rungs.findIndex((r) => r.startsWith(`${tier} `));
  if (index < 0) {
    throw new Error(`no rung of the ${tier} tier on this ladder: ${rungs.join('; ')}`);
  }
  return { index, name: rungs[index] as string };
}

async function setRung(page: Page, index: number): Promise<void> {
  await page.evaluate((i) => globalThis.keel.setRung(i), index);
}

/** Holds the canvas at BIG's device pixels whatever the rung's own ratio. */
async function holdBig(page: Page): Promise<void> {
  await page.evaluate((dpr) => globalThis.keel.world.stage.setScale(dpr), BIG.dpr);
}

interface Seen {
  chrome: string;
  dpr: Record<string, number>;
}

async function gpuSection(o: Options, base: string, seen: Seen): Promise<GpuResult> {
  const browser = await launch(o, true);
  seen.chrome = browser.version();
  const runs = new Map<number, { name: string; values: number[]; means: number[] }>();
  let width = 0;
  let height = 0;
  try {
    for (let run = 0; run < o.runs; run++) {
      const page = await openSandbox(browser, o, base, BIG);
      seen.dpr.gpu = await page.evaluate(() => window.devicePixelRatio);
      await holdBig(page);
      const rungs = await page.evaluate(() => globalThis.keel.info().rungs);
      for (const index of o.rungs ?? rungs.map((_, i) => i)) {
        await setRung(page, index);
        const r = await timed(page, o.settle, o.measure);
        width = r.width;
        height = r.height;
        const name = rungs[index] ?? `rung ${index}`;
        const row = runs.get(index) ?? { name, values: [], means: [] };
        row.values.push(r.interval.median);
        row.means.push(r.interval.mean);
        runs.set(index, row);
        say(
          `gpu run ${run + 1}: rung ${index} ${name}: ${r.interval.median.toFixed(2)} ms (mean ${r.interval.mean.toFixed(2)}) over ${r.frames} frames, ${r.width} × ${r.height}`,
        );
      }
      await closePage(page);
    }
  } finally {
    await browser.close();
  }
  const rows: GpuRow[] = [...runs.entries()].map(([index, r]) => ({
    index,
    name: r.name,
    ...measured(r.values),
    mean: measured(r.means),
  }));
  return { width, height, rows };
}

async function partsSection(o: Options, base: string, seen: Seen): Promise<PartsResult> {
  const browser = await launch(o, true);
  seen.chrome = browser.version();
  const tiers = o.tiers ?? (o.backend === 'webgl2' ? ['low'] : ['high', 'low']);
  const found = new Map<string, { rung: string; steps: Map<string, number[]> }>();
  let width = 0;
  let height = 0;
  try {
    for (let run = 0; run < o.runs; run++) {
      for (const tier of tiers) {
        const page = await openSandbox(browser, o, base, BIG);
        seen.dpr.parts = await page.evaluate(() => window.devicePixelRatio);
        await holdBig(page);
        const { index, name } = await firstOf(page, tier);
        await setRung(page, index);
        const t = found.get(tier) ?? { rung: name, steps: new Map<string, number[]>() };
        found.set(tier, t);
        const step = async (label: string): Promise<void> => {
          const r = await timed(page, o.settle, o.measure);
          width = r.width;
          height = r.height;
          const v = t.steps.get(label) ?? [];
          v.push(r.interval.median);
          t.steps.set(label, v);
          say(
            `parts run ${run + 1}, ${tier}: ${label}: ${r.interval.median.toFixed(2)} ms over ${r.frames} frames`,
          );
        };
        await step('Everything');
        for (const part of PARTS) {
          await page.evaluate(part.hide);
          await step(part.name);
        }
        await closePage(page);
      }
    }
  } finally {
    await browser.close();
  }
  return {
    width,
    height,
    tiers: [...found.entries()].map(([tier, t]) => ({
      tier,
      rung: t.rung,
      steps: [...t.steps.entries()].map(([name, v]): PartStep => ({ name, ...measured(v) })),
    })),
  };
}

/** A step of the layers section: what it leaves out, done in the page, and put back after. */
interface LayerStep {
  name: string;
  off: () => Promise<void>;
  on: () => Promise<void>;
}

async function layerSteps(page: Page, only: string[] | null): Promise<LayerStep[]> {
  const names = await page.evaluate(() => globalThis.keel.layerNames());
  const pick = (all: string[]): string[] =>
    only === null ? all : all.filter((l) => only.includes(l));
  const sea =
    (off: string[] | null, apart: boolean | null = null) =>
    (): Promise<void> =>
      page.evaluate(([off, apart]) => globalThis.keel.seaLayers(off, apart), [off, apart] as const);
  const sky = (off: string[]) => () => page.evaluate((off) => globalThis.keel.skyLayers(off), off);
  const hide =
    (what: 'sea' | 'sky', on: boolean): (() => Promise<void>) =>
    () =>
      page.evaluate(
        ([what, on]) => {
          const k = globalThis.keel;
          const w = k.world;
          for (const m of what === 'sea' ? [w.ocean.tiles.mesh, w.ocean.far.mesh] : [w.sky.mesh]) {
            k.keepHidden(m, on);
          }
        },
        [what, on] as const,
      );
  const aa = (a: 'fxaa' | 'none') => () =>
    page.evaluate((a) => globalThis.keel.world.stage.setAntialias(a), a);
  return [
    // The whole look, every tile in one draw; and the tiles a hull may
    // reach drawn apart, with the hulls' cut in their shader alone.
    { name: 'Sea: whole, in one', off: sea([], false), on: sea(null) },
    { name: 'Sea: whole, hulls apart', off: sea([], true), on: sea(null) },
    ...pick(names.sea).map((l) => ({ name: `Sea: ${l} left out`, off: sea([l]), on: sea(null) })),
    { name: 'Sea: every layer left out', off: sea(names.sea), on: sea(null) },
    { name: 'Sea hidden', off: hide('sea', true), on: hide('sea', false) },
    ...pick(names.sky).map((l) => ({ name: `Sky: ${l} left out`, off: sky([l]), on: sky([]) })),
    { name: 'Sky: every layer left out', off: sky(names.sky), on: sky([]) },
    { name: 'Sky hidden', off: hide('sky', true), on: hide('sky', false) },
    { name: 'Antialiasing off', off: aa('none'), on: aa('fxaa') },
  ];
}

async function layersSection(o: Options, base: string, seen: Seen): Promise<LayersResult> {
  const browser = await launch(o, true);
  seen.chrome = browser.version();
  const tiers = o.tiers ?? (o.backend === 'webgl2' ? ['low'] : ['high', 'low']);
  const found = new Map<string, { rung: string; steps: Map<string, number[]> }>();
  let width = 0;
  let height = 0;
  try {
    for (let run = 0; run < o.runs; run++) {
      for (const tier of tiers) {
        const page = await openSandbox(browser, o, base, BIG);
        seen.dpr.layers = await page.evaluate(() => window.devicePixelRatio);
        await holdBig(page);
        const { index, name } = await firstOf(page, tier);
        await setRung(page, index);
        const t = found.get(tier) ?? { rung: name, steps: new Map<string, number[]>() };
        found.set(tier, t);
        const step = async (label: string): Promise<void> => {
          const r = await timed(page, o.settle, o.measure);
          width = r.width;
          height = r.height;
          const v = t.steps.get(label) ?? [];
          v.push(r.interval.median);
          t.steps.set(label, v);
          say(
            `layers run ${run + 1}, ${tier}: ${label}: ${r.interval.median.toFixed(2)} ms over ${r.frames} frames`,
          );
        };
        await step('Everything');
        for (const s of await layerSteps(page, o.layers)) {
          await s.off();
          await step(s.name);
          await s.on();
        }
        await closePage(page);
      }
    }
  } finally {
    await browser.close();
  }
  return {
    width,
    height,
    tiers: [...found.entries()].map(([tier, t]) => ({
      tier,
      rung: t.rung,
      steps: [...t.steps.entries()].map(([name, v]): PartStep => ({ name, ...measured(v) })),
    })),
  };
}

async function cpuSection(o: Options, base: string, seen: Seen): Promise<CpuResult> {
  const browser = await launch(o, false);
  seen.chrome = browser.version();
  const tiers = o.backend === 'webgl2' ? ['low'] : ['high', 'low'];
  const found = new Map<
    string,
    { boat: string; tier: string; rung: string; work: number[]; p90: number[]; interval: number[] }
  >();
  try {
    for (let run = 0; run < o.runs; run++) {
      for (const boat of o.boats) {
        for (const tier of tiers) {
          const page = await openSandbox(
            browser,
            o,
            base,
            LAPTOP,
            boat === 'jolly-boat' ? '' : `&boat=${boat}`,
          );
          seen.dpr.cpu = await page.evaluate(() => window.devicePixelRatio);
          // The cap as a player's: the display's own rate, at most 60.
          await page.evaluate(() => globalThis.keel.capFrames(null));
          const { index, name } = await firstOf(page, tier);
          await setRung(page, index);
          const cdp = await page.context().newCDPSession(page);
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
          const r = await timed(page, o.settle * 2, o.measure * 2);
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
          const key = `${boat}/${tier}`;
          const row = found.get(key) ?? { boat, tier, rung: name, work: [], p90: [], interval: [] };
          row.work.push(r.work.median);
          row.p90.push(r.work.p90);
          row.interval.push(r.interval.median);
          found.set(key, row);
          say(
            `cpu run ${run + 1}, ${boat}, ${name}: work ${r.work.median.toFixed(2)} / ${r.work.p90.toFixed(2)} ms, interval ${r.interval.median.toFixed(1)} ms, ${r.frames} frames`,
          );
          await closePage(page);
        }
      }
    }
  } finally {
    await browser.close();
  }
  const rows: CpuRow[] = [...found.values()].map((r) => ({
    boat: r.boat,
    tier: r.tier,
    rung: r.rung,
    work: measured(r.work),
    workP90: measured(r.p90),
    interval: measured(r.interval),
  }));
  return { width: LAPTOP.width, height: LAPTOP.height, throttle: THROTTLE, rows };
}

async function countsSection(o: Options, base: string, seen: Seen): Promise<CountsResult> {
  const browser = await launch(o, false);
  seen.chrome = browser.version();
  const tiers = o.backend === 'webgl2' ? ['low'] : ['high', 'medium', 'low'];
  const found = new Map<string, { rung: string; reports: FrameReport[] }>();
  let width = 0;
  let height = 0;
  try {
    for (let run = 0; run < o.runs; run++) {
      const page = await openSandbox(browser, o, base, LAPTOP);
      seen.dpr.counts = await page.evaluate(() => window.devicePixelRatio);
      for (const tier of tiers) {
        const { index, name } = await firstOf(page, tier);
        await setRung(page, index);
        await page.waitForTimeout(o.settle);
        const r = await page.evaluate(
          (n) => globalThis.keel.countFrames(n, { detail: true }),
          COUNT_FRAMES,
        );
        width = r.width;
        height = r.height;
        const t = found.get(tier) ?? { rung: name, reports: [] };
        t.reports.push(r);
        found.set(tier, t);
        say(
          `counts run ${run + 1}, ${name}: ${r.writes.median} writes, ${(r.bytes.median / 1024).toFixed(0)} KB, ${r.passes.median} passes, ${r.dispatches.median} dispatches, ${r.draws.median} draws a frame`,
        );
      }
      await closePage(page);
    }
  } finally {
    await browser.close();
  }
  const rows: CountsRow[] = [...found.entries()].map(([tier, t]) => {
    const counts = {} as CountsRow['counts'];
    for (const name of COUNT_NAMES) {
      counts[name as CountName] = {
        median: median(t.reports.map((r) => r[name].median)),
        max: median(t.reports.map((r) => r[name].max)),
      };
    }
    const last = t.reports[t.reports.length - 1] as FrameReport;
    return {
      tier,
      rung: t.rung,
      frames: last.frames,
      counts,
      largest: last.largest,
      passList: last.passList,
    };
  });
  return { width, height, rows };
}

function commit(): string {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: client })
      .toString()
      .trim();
    const dirty =
      execFileSync('git', ['status', '--porcelain', '--', '.'], { cwd: client })
        .toString()
        .trim() !== '';
    return dirty ? `${sha} with changes` : sha;
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const o = options();
  if (o.compare !== null && o.after !== null) {
    const before = JSON.parse(readFileSync(o.compare, 'utf8')) as Results;
    const after = JSON.parse(readFileSync(o.after, 'utf8')) as Results;
    process.stdout.write(compare(before, after));
    return;
  }
  const browsing = o.only.some((s) => s !== 'ladder');
  const vite = browsing ? await startVite(o.port) : null;
  const base = `http://localhost:${o.port}`;
  const seen: Seen = { chrome: '', dpr: {} };
  const results: Results = {
    meta: {
      date: new Date().toISOString(),
      commit: commit(),
      chrome: '',
      backend: o.backend,
      dpr: {},
      runs: o.runs,
      args: process.argv.slice(2),
    },
  };
  try {
    for (const s of o.only) {
      const started = Date.now();
      say(`${s}…`);
      if (s === 'ladder') {
        results.ladder = await ladderSection(vite);
      } else if (s === 'gpu') {
        results.gpu = await gpuSection(o, base, seen);
      } else if (s === 'parts') {
        results.parts = await partsSection(o, base, seen);
      } else if (s === 'layers') {
        results.layers = await layersSection(o, base, seen);
      } else if (s === 'cpu') {
        results.cpu = await cpuSection(o, base, seen);
      } else {
        results.counts = await countsSection(o, base, seen);
      }
      say(`${s} took ${((Date.now() - started) / 1000).toFixed(0)} s`);
    }
  } finally {
    await vite?.close();
  }
  results.meta.chrome = seen.chrome;
  results.meta.dpr = seen.dpr;
  const md = report(results);
  process.stdout.write(md);
  if (o.json !== null) {
    writeFileSync(o.json, `${JSON.stringify(results, null, 1)}\n`);
  }
  if (o.md !== null) {
    writeFileSync(o.md, md);
  }
  if (o.compare !== null) {
    const before = JSON.parse(readFileSync(o.compare, 'utf8')) as Results;
    process.stdout.write(`\n${compare(before, results)}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
  // Vite's watchers and Playwright's pipes may hold the loop open.
  process.exit(0);
}
