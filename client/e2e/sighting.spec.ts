// SPDX-License-Identifier: AGPL-3.0-only

// The chart in a real browser, in the sandbox on seed 1's world and its
// chart (the files go run ./tools/dev -world 1 writes): charted whole, it
// is drawn in the sea's place within its budget of draws and triangles, in
// the chart's own materials, its land's names upright and its water's
// sloping, a tap opening the box of what is tapped; the boat sails on and
// the sea is not drawn while it is open; two fingers twisted turn it the
// way they twist; the pocket chart says how far the edge is and opens it;
// its list puts the nearest first, and lists its island courses; a notice
// is a status, dismissed by its button; what a sailor's certificates came
// to raises its notices, See opening the log's Certificates; and charted by sight, an island the boat sails up to is charted,
// the sailor's, with a notice. A course set on a charted place from its
// box puts its distance in the compass's window once the chart is shut; a
// tap on open water drops a pin whose box sets the course, and past the
// rim says it is beyond the edge. A shipmate sailed to from their row's ⋯
// is the course once the server says where their boat is, their distance
// in the compass's window; ended, the notice says so and the course goes.

import { existsSync, readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { openScene } from './helpers';
import { standInLogs } from './logs';

const chartFile = new URL('../../.dev/worlds/1.chart', import.meta.url);
const catalogFile = new URL('../src/catalog/catalog.gen.json', import.meta.url);

test.skip(!existsSync(chartFile), 'no chart for seed 1: run go run ./tools/dev -world 1');

// Small pages: a software renderer draws the open chart, which redraws as
// its wind drifts, for every pixel, and the specs after these share it.
test.use({ viewport: { width: 480, height: 300 } });

/** The chart's budget, charted whole. */
const DRAWS = 40;
const TRIANGLES = 250_000;

interface Entry {
  subject: string;
  number: number;
  sort: number;
  name: string;
  east: number;
  north: number;
  worth: number;
  bounds: number[] | null;
  island: number;
  light: number;
}

function entries(): { entries: Entry[]; known: number[] } {
  return JSON.parse(readFileSync(chartFile, 'utf8')) as { entries: Entry[]; known: number[] };
}

/** Draws the chart a few times, its frames apart. */
async function drawChart(page: Page, n = 12): Promise<void> {
  for (let i = 0; i < n; i++) {
    await page.evaluate(() => globalThis.keel.render());
    await page.waitForTimeout(40);
  }
}

test.describe('the chart', () => {
  test('charted whole, it is drawn in its budget, lettered as charts are, and a tap opens a box', async ({
    page,
  }) => {
    await openScene(page, 'world=1', true);
    await page.evaluate(() => {
      globalThis.keel.setSky(12);
      globalThis.keel.openChart('chart');
      globalThis.keel.fitChart();
    });
    await drawChart(page);
    const whole = await page.evaluate(() => globalThis.keel.chartInfo());
    expect(whole.size).toBe(entries().entries.length);
    expect(whole.draws).toBeGreaterThan(0);
    expect(whole.meshes).toBeLessThanOrEqual(DRAWS);
    expect(whole.triangles).toBeLessThanOrEqual(TRIANGLES);
    expect(whole.problems).toEqual([]);
    // From afar, the main port and the great islands alone, upright.
    const port = whole.labels.find((l) => l.text === 'Port Royal');
    expect(port?.italic).toBe(false);
    expect(whole.labels.length).toBeLessThan(20);
    // Close to a lagoon or a cove, its name slopes.
    const kinds = JSON.parse(readFileSync(catalogFile, 'utf8')) as {
      world: { places: { kinds: { water?: boolean }[] } };
    };
    const lagoon = entries().entries.find(
      (e) =>
        e.subject === 'place' && kinds.world.places.kinds[e.sort]?.water === true && e.name !== '',
    );
    expect(lagoon).toBeDefined();
    const water = lagoon?.name;
    await page.evaluate((n) => globalThis.keel.chartAt('place', n), lagoon?.number ?? 0);
    await drawChart(page);
    const near = await page.evaluate(() => globalThis.keel.chartInfo());
    // Water's names slope, land's stand upright; on a small page the place
    // looked at may give way to a neighbour's name.
    const waters = near.labels.filter((l) => l.kind.includes('chart-water'));
    expect(waters.length, JSON.stringify([water, near.labels])).toBeGreaterThan(0);
    expect(waters.every((l) => l.italic)).toBe(true);
    expect(near.labels.filter((l) => l.kind.includes('chart-island')).every((l) => !l.italic)).toBe(
      true,
    );
    // A tap on Port Royal's island opens its box.
    await page.evaluate(() => {
      globalThis.keel.chartAt('island', 0);
      globalThis.keel.chartInfo();
    });
    await drawChart(page, 4);
    const at = await page.evaluate(() => globalThis.keel.chartPoint('island', 0));
    expect(at).not.toBeNull();
    const picked = await page.evaluate(
      ({ x, y }) => globalThis.keel.pickChart(x, y),
      at ?? { x: 0, y: 0 },
    );
    expect(picked).toBe('Port Royal');
    await expect(page.locator('.chart-box h2')).toHaveText('Port Royal');
  });

  test('the boat sails on and the sea is not drawn while it is open; the pocket opens it', async ({
    page,
  }) => {
    await openScene(page, 'world=1', true);
    await page.evaluate(() => globalThis.keel.thaw());
    const caption = page.locator('.pocket-line').first();
    await expect(caption).toHaveText(/^edge \d\.\d NM$/);
    await page.locator('.pocket-chart').click();
    expect(await page.evaluate(() => globalThis.keel.chartInfo().open)).toBe(true);
    const t0 = await page.evaluate(() => globalThis.keel.game.clock.time);
    const sea0 = await page.evaluate(() => globalThis.keel.seaFrames());
    // A software renderer draws a frame or two a second: wait for the
    // world's time to move, as it does while the chart is drawn.
    await expect
      .poll(() => page.evaluate(() => globalThis.keel.game.clock.time), { timeout: 30_000 })
      .toBeGreaterThan(t0 + 0.5);
    expect(await page.evaluate(() => globalThis.keel.seaFrames())).toBe(sea0);
    const sea1 = sea0;
    expect(await page.evaluate(() => globalThis.keel.chartInfo().draws)).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Back to sea' }).click();
    await expect
      .poll(() => page.evaluate(() => globalThis.keel.seaFrames()), { timeout: 30_000 })
      .toBeGreaterThan(sea1);
  });

  test('two fingers twisted clockwise turn the chart clockwise under them', async ({ page }) => {
    await openScene(page, 'world=1', true);
    await page.evaluate(() => {
      globalThis.keel.openChart('chart');
      globalThis.keel.fitChart();
      globalThis.keel.render();
    });
    // The way the east runs on the screen, rad, y down: clockwise is more.
    const east = () =>
      page.evaluate(() => {
        globalThis.keel.render();
        const a = globalThis.keel.chartScreenOf(0, 0);
        const b = globalThis.keel.chartScreenOf(3000, 0);
        return a === null || b === null ? Number.NaN : Math.atan2(b.y - a.y, b.x - a.x);
      });
    const before = await east();
    // The chart's pointers are listened to once the screen is painted.
    await expect(page.locator('.chart-surface')).toBeVisible();
    await page.waitForTimeout(200);
    // Two fingers about the middle of the chart, one on a place's name,
    // twisted 30° clockwise.
    const cdp = await page.context().newCDPSession(page);
    const fingers = (deg: number) => {
      const r = (deg * Math.PI) / 180;
      const [dx, dy] = [60 * Math.cos(r), 60 * Math.sin(r)];
      return [
        { x: 240 + dx, y: 150 + dy, id: 0 },
        { x: 240 - dx, y: 150 - dy, id: 1 },
      ];
    };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(0) });
    for (let deg = 5; deg <= 30; deg += 5) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: fingers(deg) });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const turned = (await east()) - before;
    const wrapped = Math.atan2(Math.sin(turned), Math.cos(turned));
    // Tilted, the paper's turn on the screen is near the fingers', not the same.
    expect(wrapped).toBeGreaterThan(0.25);
    expect(wrapped).toBeLessThan(0.9);
    // A finger was on a name: twisted, it opened no box; a tap on one does.
    await expect(page.locator('.chart-box')).toHaveCount(0);
    await page.locator('.chart-label', { hasText: 'Port Royal' }).first().click();
    await expect(page.locator('.chart-box h2')).toHaveText('Port Royal');
  });

  test('its list puts the nearest first, and a tap shows it on the chart', async ({ page }) => {
    await openScene(page, 'world=1', true);
    await page.evaluate(() => globalThis.keel.openChart('list'));
    const islands = page.locator('.chart-list div', {
      has: page.locator('h3', { hasText: 'Islands' }),
    });
    const where = await islands.locator('.chart-list-where').allTextContents();
    const metres = where.map((w) => {
      const [, n, unit] = /(\d+(?:\.\d+)?) (NM|m)$/.exec(w) ?? [];
      return Number(n) * (unit === 'NM' ? 1852 : 1);
    });
    expect(metres.length).toBeGreaterThan(10);
    expect(metres).toEqual([...metres].sort((a, b) => a - b));
    await islands.locator('li button').first().click();
    const info = await page.evaluate(() => globalThis.keel.chartInfo());
    expect(info.mode).toBe('chart');
    expect(info.picked).not.toBeNull();
  });

  test('charted whole, its island courses are listed, and a tap shows one on the chart', async ({
    page,
  }) => {
    const file = JSON.parse(readFileSync(chartFile, 'utf8')) as { courses?: { name: string }[] };
    const names = (file.courses ?? []).map((c) => c.name);
    expect(names.length).toBeGreaterThanOrEqual(3);
    await openScene(page, 'world=1', true);
    await page.evaluate(() => globalThis.keel.openChart('list'));
    const courses = page.locator('.chart-list div', {
      has: page.locator('h3', { hasText: 'Courses' }),
    });
    await expect(courses.locator('li')).toHaveCount(names.length);
    const listed = await courses.locator('.chart-list-name').allTextContents();
    expect([...listed].sort()).toEqual([...names].sort());
    for (const w of await courses.locator('.chart-list-where').allTextContents()) {
      expect(w).toMatch(/^\d{3}° \d+(\.\d)? (NM|m) · \d+\.\d NM long$/);
    }
    expect(await courses.locator('.chart-credit').first().textContent()).toMatch(/ \d+ min/);
    await courses.locator('li button').first().click();
    const info = await page.evaluate(() => globalThis.keel.chartInfo());
    expect(info.mode).toBe('chart');
    expect(info.courses).toHaveLength(names.length);
    expect(info.problems).toEqual([]);
  });

  test('a notice is a status: dismissed by its button, the focus left where it was', async ({
    page,
  }) => {
    await openScene(page, 'world=1', true);
    const status = page.locator('.notice-line[role="status"]');
    await expect(status).toHaveCount(1);
    await expect(status).toBeEmpty();
    const before = await page.evaluate(() => document.activeElement?.tagName ?? '');
    await page.evaluate(() => globalThis.keel.raiseNotice('charted-own', { name: 'Keyhole Rock' }));
    await expect(status).toHaveText(/You charted Keyhole Rock/);
    expect(await page.evaluate(() => document.activeElement?.tagName ?? '')).toBe(before);
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(status).toBeEmpty();
  });

  test('what a sailor’s certificates came to raises its notices: how far the next has come on going to sea and a task done passing, a certificate earned staying with See, which opens the log’s Certificates, and the bell rung twice', async ({
    page,
  }) => {
    await standInLogs(page);
    await openScene(page, 'world=1', true);
    const status = page.locator('.notice-line[role="status"]');
    // On going to sea, how far the next one has come: a passing line, which
    // a task done takes the place of, never folded with it.
    await page.evaluate(() => globalThis.keel.towardAtSea({ name: 'Helm', done: 1, needs: 4 }));
    await expect(page.locator('.notice-passive')).toHaveText(/^Toward Helm · 1 of 4/);
    // A task of the log done: a passing notice, its words the catalog's.
    const rung = await page.evaluate(() =>
      globalThis.keel.certified({ certificate: 1, task: 3, done: 2, of: 4, way: 'log' }),
    );
    expect(rung).toBe(0);
    await expect(page.locator('.notice-passive')).toHaveText(
      /^Toward Helm: A night at sea ✓ · 2 of 4/,
    );
    // A second folds into it.
    await page.evaluate(() =>
      globalThis.keel.certified({ certificate: 1, task: 2, done: 3, of: 4, way: 'log' }),
    );
    await expect(page.locator('.notice-passive')).toHaveText(/^Toward Helm: 2 tasks done · 3 of 4/);
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(status).toBeEmpty();
    // Helm earned: a notice that stays, with See, and the bell rung, twice.
    expect(
      await page.evaluate(() =>
        globalThis.keel.certified({
          certificate: 1,
          task: -1,
          done: 4,
          of: 4,
          earned: true,
          byHand: true,
        }),
      ),
    ).toBe(1);
    await expect(page.locator('.notice-active')).toHaveText(
      /You're a Helm! The beach cat is yours to take/,
    );
    await page.locator('.notice-act').click();
    // See: the log, on its Certificates, every one in order and the next
    // open to its tasks.
    await expect(page.locator('.log-sheet [role=tab][aria-selected=true]')).toHaveText(
      'Certificates',
    );
    await expect(page.locator('.log-cert-item')).toHaveCount(5);
    await expect(page.locator('.log-cert-item[data-state=next] .log-task').first()).toBeVisible();
    await expect(status).toBeEmpty();
    await page.evaluate(() => globalThis.keel.openChart(null));
  });

  test('charted by sight: an island the boat comes up to is charted, the sailor’s, with a notice', async ({
    page,
  }) => {
    const { entries: all, known } = entries();
    const isle = all.find(
      (e, i) => e.subject === 'island' && !known.includes(i) && e.bounds !== null && e.worth >= 3,
    );
    expect(isle).toBeDefined();
    await openScene(page, 'world=1&chart=sight', true);
    await page.evaluate(() => globalThis.keel.thaw());
    expect(await page.evaluate(() => globalThis.keel.chartInfo().size)).toBe(known.length);
    const east = isle?.bounds?.[2] ?? 0;
    await page.evaluate(({ e, n }) => globalThis.keel.placeBoat(e + 60, n, 0), {
      e: east,
      n: isle?.north ?? 0,
    });
    await expect
      .poll(() => page.evaluate(() => globalThis.keel.chartInfo().mine), { timeout: 10_000 })
      .toContain(isle?.name);
    await expect(page.locator('.notice-line')).toHaveText(/You charted/);
  });

  test('a course set on a charted place from its box: its distance in the compass’s window at sea', async ({
    page,
  }) => {
    await openScene(page, 'world=1', true);
    // A lighthouse a mile or more off, so the boat is not there already.
    const boat = await page.evaluate(() => globalThis.keel.boatAt());
    const light = entries()
      .entries.filter((e) => e.subject === 'place' && e.light >= 0 && e.name !== '')
      .map((e) => ({ e, d: Math.hypot(e.east - boat.east, e.north - boat.north) }))
      .filter(({ d }) => d > 1852)
      .sort((a, b) => a.d - b.d)[0]?.e;
    expect(light).toBeDefined();
    await page.evaluate((n) => globalThis.keel.chartAt('place', n), light?.number ?? 0);
    const box = page.locator('.chart-box');
    await expect(box.locator('h2')).toHaveText(light?.name ?? '');
    await box.getByRole('button', { name: 'Set course' }).click();
    await expect(box.getByRole('button', { name: 'Clear course' })).toBeVisible();
    await page.getByRole('button', { name: 'Back to sea' }).click();
    await page.evaluate(() => globalThis.keel.render());
    const course = await page.evaluate(() => globalThis.keel.course());
    expect(course.course).toEqual({ kind: 'entry', subject: 'place', number: light?.number });
    const nm = ((course.aim?.distance ?? 0) / 1852).toFixed(1);
    await expect(page.locator('[data-readout=course-distance]')).toHaveText(`${nm}NM`);
    expect(course.words).toMatch(new RegExp(`^Course to ${light?.name}: \\d{3}°, ${nm} NM$`));
    // The mark, turned at the next frame once it is on the card.
    await expect
      .poll(() =>
        page.evaluate(() => {
          globalThis.keel.render();
          return globalThis.keel.course().mark;
        }),
      )
      .toMatch(/^rotate\(-?\d+\.\ddeg\)$/);
  });

  test('a tap on open water drops a pin whose box sets the course; past the rim, beyond the edge', async ({
    page,
  }) => {
    await openScene(page, 'world=1', true);
    // Open water: near the boat, well clear of everything charted and of
    // the courses' starts; the weather's systems off the chart, whose box
    // a tap within one would open.
    const boat = await page.evaluate(() => globalThis.keel.boatAt());
    const file = JSON.parse(readFileSync(chartFile, 'utf8')) as {
      entries: Entry[];
      courses?: { way: [number, number][] }[];
    };
    const points = [
      ...file.entries.map((e) => [e.east, e.north] as const),
      ...(file.courses ?? []).map((c) => c.way[0] ?? [0, 0]),
    ];
    let water: { east: number; north: number } | null = null;
    for (let r = 600; r < 3000 && water === null; r += 200) {
      for (let a = 0; a < 360 && water === null; a += 15) {
        const east = boat.east + r * Math.sin((a * Math.PI) / 180);
        const north = boat.north + r * Math.cos((a * Math.PI) / 180);
        if (points.every(([e, n]) => Math.hypot(e - east, n - north) > 500)) {
          water = { east, north };
        }
      }
    }
    expect(water).not.toBeNull();
    await page.evaluate(() => {
      const k = globalThis.keel;
      k.setSky(12);
      k.chartLayers({ systems: false });
      k.openChart('chart');
      k.chartFromBoat(7000);
    });
    await drawChart(page);
    await expect(page.locator('.chart-surface')).toBeVisible();
    await page.waitForTimeout(200);
    const at = await page.evaluate(
      ({ east, north }) => globalThis.keel.chartScreenOf(east, north),
      water ?? { east: 0, north: 0 },
    );
    expect(at).not.toBeNull();
    await page.mouse.click(at?.x ?? 0, at?.y ?? 0);
    const box = page.locator('[data-readout=pin-box]');
    await expect(box.locator('h2')).toHaveText('Pin');
    await expect(box).toContainText(/\d+°\d\d′N \d{3}°\d\d′/);
    await drawChart(page, 3);
    expect((await page.evaluate(() => globalThis.keel.course())).dropped).toBe(true);
    await box.getByRole('button', { name: 'Set course' }).click();
    const set = await page.evaluate(() => globalThis.keel.course());
    expect(set.course?.kind).toBe('pin');
    expect(
      Math.hypot(
        (set.course as { east: number }).east - (water?.east ?? 0),
        (set.course as { north: number }).north - (water?.north ?? 0),
      ),
    ).toBeLessThan(150);
    // The course on the chart: its pin, named, and the pencil line to it.
    await drawChart(page, 3);
    const drawn = await page.evaluate(() => globalThis.keel.course());
    expect(drawn.pin).toBe('Pin');
    expect(drawn.line).toBe(true);
    expect(drawn.dropped).toBe(false);
    await box.getByRole('button', { name: 'Close' }).click();
    await expect(box).toHaveCount(0);
    // A tap past the rim, in the falls, is no pin.
    await page.evaluate(() => globalThis.keel.fitChart());
    await drawChart(page, 3);
    // On the bare paper, not under the strip or the slider, nothing charted near.
    let beyond: { x: number; y: number } | null = null;
    for (let a = 0; a < 360 && beyond === null; a += 15) {
      const east = 9200 * Math.sin((a * Math.PI) / 180);
      const north = 9200 * Math.cos((a * Math.PI) / 180);
      // Farther than a tap's reach from the whole disk's view.
      if (points.some(([e, n]) => Math.hypot(e - east, n - north) < 1200)) {
        continue;
      }
      beyond = await page.evaluate(
        ([e, n]) => {
          const p = globalThis.keel.chartScreenOf(e, n);
          const on = p === null ? null : document.elementFromPoint(p.x, p.y);
          return on?.classList.contains('chart-surface') === true ? p : null;
        },
        [east, north] as const,
      );
    }
    expect(beyond).not.toBeNull();
    await page.waitForTimeout(400);
    await page.mouse.click(beyond?.x ?? 0, beyond?.y ?? 0);
    await expect(box).toHaveText(/^Beyond the edge\.Close$/);
    await expect(box.getByRole('button', { name: 'Set course' })).toHaveCount(0);
  });

  test('a shipmate sailed to from their row’s ⋯: their boat’s distance in the compass’s window; ended, said', async ({
    page,
  }) => {
    await openScene(page, 'world=1', true);
    await page.evaluate(() => globalThis.keel.deckScene('shipmates-more', 'Anne Bonny'));
    const more = page.locator('.shipmates-panel .deck-row-more');
    await more.getByRole('button', { name: 'Sail to: Anne Bonny' }).click();
    await expect(page.locator('.shipmates-panel')).toHaveCount(0);
    const set = await page.evaluate(() => globalThis.keel.course());
    expect(set.course).toEqual({
      kind: 'boat',
      sailor: 'iron',
      name: 'Anne Bonny',
      machine: false,
    });
    // Nowhere until the server says where the boat is.
    expect(set.aim).toBeNull();
    const boat = await page.evaluate(() => globalThis.keel.boatAt());
    await page.evaluate(
      ({ east, north }) =>
        globalThis.keel.courseBoatAt({ sailor: 'iron', name: 'Anne Bonny', east, north }),
      { east: boat.east, north: boat.north + 1.5 * 1852 },
    );
    await expect
      .poll(() =>
        page.evaluate(() => {
          globalThis.keel.render();
          return document.querySelector('[data-readout=course-distance]')?.textContent ?? '';
        }),
      )
      .toBe('1.5NM');
    expect((await page.evaluate(() => globalThis.keel.course())).words).toMatch(
      /^Course to Anne Bonny: \d{3}°, 1\.5 NM$/,
    );
    // Appearing offline, say: refused, never why.
    await page.evaluate(() => globalThis.keel.courseBoatEnded('iron', 'refused'));
    await expect(page.locator('.notice-line')).toHaveText(/You can't sail to Anne Bonny now/);
    expect((await page.evaluate(() => globalThis.keel.course())).course).toBeNull();
    await page.evaluate(() => globalThis.keel.deckScene(null));
  });
});
