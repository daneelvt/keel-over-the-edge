// SPDX-License-Identifier: AGPL-3.0-only

// The game kept on the phone by its service worker (src/sw/), on the built
// page as keel serves it, opened at / with no test hooks: one sailor, one
// page, in order.
//
// - A return visit: the worker registered at the reveal, the same browser
//   reloads and sets sail again. The page was answered through the worker,
//   and under 100 KB came over the wire before the reveal, the game's
//   connection and the land's chunks (the mesh worker keeps those it has
//   fetched) apart. Both visits' bytes and times go to the job's summary.
//   Neither visit throws an error: a worker started from a file the
//   service worker answers is not as one started from the network (the
//   sailors' texture transcoder once threw there, and no sailor was drawn).
// - A deploy: keel restarted on the next build (e2e/nextbuild.ts: none of
//   the first build's files), the page still running the first opens the
//   log and the news, from the worker's copy; reloaded, it runs the next
//   build, and the first build's code is kept as the previous build's.
// - The off switch: keel restarted on a build made with KEEL_SW=off; after
//   a navigation, no worker and none of its caches, and none again later.
//
// keel is left serving client/dist again afterwards.

import { execFileSync } from 'node:child_process';
import { appendFileSync, rmSync } from 'node:fs';
import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { sailor } from './helpers';
import { writeNextBuild } from './nextbuild';
import {
  kb,
  markPage,
  measure,
  NETWORKS,
  type Response,
  readMarks,
  record,
  revealed,
  s,
  throttle,
  unreadFiles,
} from './wire';

/** A return visit's budget, bytes on the wire to the reveal. */
const RETURN_BUDGET = 100 * 1024;

/** tools/e2e's control: a restart of keel, on another build. */
const CONTROL = 'http://127.0.0.1:19099';
/** The build tools/e2e serves first, from the repository's root. */
const DIST = 'client/dist';

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }, info) => {
  // The project's phone, in a context of the spec's own, kept across its tests.
  const u = info.project.use;
  const phone = {
    baseURL: u.baseURL,
    viewport: u.viewport,
    deviceScaleFactor: u.deviceScaleFactor,
    isMobile: u.isMobile,
    hasTouch: u.hasTouch,
    userAgent: u.userAgent,
  };
  context = await browser.newContext(
    Object.fromEntries(Object.entries(phone).filter(([, v]) => v !== undefined)),
  );
  page = await context.newPage();
  await markPage(page);
  // Every error a visit throws, its workers' too: they reach the window.
  await page.addInitScript(() => {
    const thrown: string[] = [];
    Reflect.set(globalThis, 'keptErrors', thrown);
    addEventListener('error', (e) => thrown.push(e.message));
  });
  await sailor(context, 'Kept');
});

/** The builds the tests wrote, each a copy of the game's files: taken away afterwards. */
const written: string[] = [];

test.afterAll(async ({ request }) => {
  await context?.close();
  await restartOn(request, DIST);
  for (const dir of written) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Restarts keel serving the built page in dir (absolute, or from the repository's root). */
async function restartOn(request: APIRequestContext, dir: string): Promise<void> {
  const res = await request.post(`${CONTROL}/restart?client=${encodeURIComponent(dir)}`, {
    timeout: 180_000,
  });
  expect(res.status(), await res.text()).toBe(204);
}

/** Taps Set sail on the player's own sailor, and waits for the reveal. */
async function setSail(): Promise<void> {
  await page.getByRole('button', { name: /^Set sail/ }).click({ timeout: 90_000 });
  await revealed(page);
}

/** The errors the visit has thrown, its workers' too. */
function thrown(): Promise<string[]> {
  return page.evaluate(() => (Reflect.get(globalThis, 'keptErrors') as string[] | undefined) ?? []);
}

/** The worker's caches, by name, with the paths each holds. */
function cachesOf(): Promise<Record<string, string[]>> {
  return page.evaluate(async () => {
    const out: Record<string, string[]> = {};
    for (const name of await caches.keys()) {
      if (name.startsWith('keel-')) {
        const c = await caches.open(name);
        out[name] = (await c.keys()).map((r) => new URL(r.url).pathname);
      }
    }
    return out;
  });
}

/**
 * The build whose worker controls the page, by its code cache, once the
 * worker has settled: none installing or waiting, the active one
 * activated and in control.
 */
async function workerBuild(): Promise<string> {
  // Polled from here: waitForFunction takes an async predicate's promise as
  // a truthy answer at once, without waiting for what it resolves to.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const reg = await navigator.serviceWorker.getRegistration();
          return (
            reg !== undefined &&
            reg.installing === null &&
            reg.waiting === null &&
            reg.active?.state === 'activated' &&
            navigator.serviceWorker.controller !== null
          );
        }),
      { timeout: 90_000, intervals: [250] },
    )
    .toBe(true);
  const url = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? '');
  expect(new URL(url).pathname).toBe('/sw.js');
  const names = Object.keys(await cachesOf()).filter((n) => n.startsWith('keel-code-'));
  return names[names.length - 1]?.slice('keel-code-'.length) ?? '';
}

/** The page's entry script, as its index.html names it. */
function entry(): Promise<string> {
  return page.evaluate(
    () => document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src ?? '',
  );
}

/** Every request since the last visit's tally. */
let finished: ReturnType<typeof record> = [];

/** A visit's bytes on the wire to the reveal, without the game's connection or the land's chunks; and its table's lines. */
async function visit(title: string): Promise<{ total: number; lines: string[] }> {
  const { marks, origin } = await readMarks(page);
  const reveal = marks.reveal ?? 0;
  const tap = marks.taps.at(-1) ?? 0;
  // Let the requests that ended before the reveal be told.
  await page.waitForTimeout(1000);
  const all = (await Promise.all(finished.map((r) => measure(r, origin)))).filter(
    (r): r is Response => r !== null && r.end <= reveal,
  );
  expect(unreadFiles(all), 'files whose bytes could not be read').toEqual([]);
  finished.length = 0;
  const land = all.filter((r) => r.kind === 'land');
  const rest = all.filter((r) => r.kind !== 'land');
  const sum = (rs: Response[]) => rs.reduce((n, r) => n + r.sent, 0);
  const total = sum(rest);
  return {
    total,
    lines: [
      `#### ${title}`,
      '',
      `**${kb(total)}** on the wire to the reveal in ${rest.length} responses (the land's chunks apart: ${land.length}, ${kb(sum(land))}); Set sail tapped at ${s(tap)}, the reveal at ${s(reveal)}, from the navigation's start.`,
      '',
      '| Ended | Path | As sent |',
      '|---|---|---|',
      ...rest
        .sort((a, b) => a.end - b.end)
        .map((r) => `| ${s(r.end)} | ${r.path} | ${kb(r.sent)} |`),
      '',
    ],
  };
}

test('a return visit comes from the phone: under 100 KB on the wire before the reveal', async () => {
  const network = NETWORKS.fast4g;
  await throttle(context, page, network);
  finished = record(context);
  await page.goto('/');
  await setSail();
  const first = await visit(`The first visit of a sailor already made, ${network.name}`);
  expect(await thrown(), 'errors thrown on the first visit').toEqual([]);
  // Registered at the reveal: installed, it takes the page over.
  const build = await workerBuild();
  expect(build).not.toBe('');
  const kept = await cachesOf();
  expect(kept[`keel-code-${build}`]).toContain('/');
  expect(kept[`keel-code-${build}`]?.length ?? 0).toBeGreaterThan(100);

  finished.length = 0;
  await page.reload();
  await setSail();
  const again = await visit(`Its return visit, ${network.name}`);
  // Under the worker, the page's own workers started as on the first visit.
  expect(await thrown(), 'errors thrown on the return visit').toEqual([]);
  // The page came through the worker, and was its build's.
  expect(
    await page.evaluate(
      () =>
        (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).workerStart,
    ),
  ).toBeGreaterThan(0);
  const table = [`### The return visit`, '', ...first.lines, ...again.lines].join('\n');
  process.stdout.write(`${table}\n`);
  await test.info().attach('return visit', { body: table, contentType: 'text/markdown' });
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined && summary !== '') {
    appendFileSync(summary, `${table}\n`);
  }
  expect(again.total, `the return visit took ${kb(again.total)}`).toBeLessThan(RETURN_BUDGET);
});

test('a deploy: the open page opens its late screens from the phone, and reloads into the new build', async ({
  request,
}) => {
  const first = await workerBuild();
  const before = await entry();
  // The next build: none of this build's files, and its id the worker's
  // with "-next".
  const next = test.info().outputPath('next');
  written.push(next);
  writeNextBuild('dist', next, first, `${first}-next`);
  await restartOn(request, next);

  // The page, still the first build, opens the log and the news: their
  // code is gone from the server, and comes from the worker.
  const late: { path: string; worker: boolean; status: number }[] = [];
  page.on('response', (r) => {
    const path = new URL(r.url()).pathname;
    if (/^\/assets\/(log|news)-[^/]*\.js$/.test(path)) {
      late.push({ path, worker: r.fromServiceWorker(), status: r.status() });
    }
  });
  await page.locator('.pocket-chart').click();
  await page.getByRole('button', { name: 'Log', exact: true }).click();
  await expect(page.locator('.log-name')).toBeVisible();
  await page.getByRole('button', { name: /^News/ }).click();
  await expect(page.locator('.news-sheet')).toBeVisible();
  await expect(page.locator('.update-line')).toHaveCount(0);
  await expect
    .poll(() => late.map((l) => l.path.slice('/assets/'.length).split('-')[0]).sort(), {
      message: 'the log’s and the news’s code',
    })
    .toEqual(['log', 'news']);
  for (const l of late) {
    expect(l, 'answered by the worker').toMatchObject({ worker: true, status: 200 });
  }
  // The server has none of them.
  const gone = await request.get(late[0]?.path ?? '/assets/');
  expect(gone.status()).toBe(404);

  // Reloaded: the next build, under its own worker, the first's code kept.
  await page.reload();
  await setSail();
  expect(await entry()).not.toBe(before);
  expect(new URL(await entry()).pathname).toMatch(/-next\.js$/);
  await expect
    .poll(async () => Object.keys(await cachesOf()).filter((n) => n.startsWith('keel-code-')), {
      timeout: 60_000,
    })
    .toEqual([`keel-code-${first}`, `keel-code-${first}-next`]);
  await expect.poll(() => workerBuild()).toBe(`${first}-next`);
});

test('the off switch: a build with KEEL_SW=off takes the worker and its caches away', async ({
  request,
}) => {
  test.setTimeout(240_000);
  expect(Object.keys(await cachesOf()).length).toBeGreaterThan(0);
  const off = test.info().outputPath('off');
  written.push(off);
  execFileSync('npx', ['--no-install', 'vite', 'build', '--outDir', off, '--logLevel', 'warn'], {
    env: { ...process.env, KEEL_SW: 'off' },
    // Quiet: its warnings are the first build's; a failure throws with them.
    stdio: 'pipe',
  });
  await restartOn(request, off);
  const none = async () => ({
    registrations: await page.evaluate(
      async () => (await navigator.serviceWorker.getRegistrations()).length,
    ),
    caches: Object.keys(await cachesOf()),
  });
  // A navigation: the browser finds the worker changed, and the page is
  // the build without one.
  await page.reload();
  await expect.poll(none, { timeout: 60_000 }).toEqual({ registrations: 0, caches: [] });
  // At sea again, past the reveal and its registration: still none.
  await page.reload();
  await setSail();
  await page.waitForTimeout(2000);
  expect(await none()).toEqual({ registrations: 0, caches: [] });
});
