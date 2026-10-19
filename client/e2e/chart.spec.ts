// SPDX-License-Identifier: AGPL-3.0-only

// The chart in a real browser, in the sandbox on seed 1's world and its
// chart (the files go run ./tools/dev -world 1 writes): charted whole, it
// is drawn in the sea's place within its budget of draws and triangles, in
// the chart's own materials, its land's names upright and its water's
// sloping, a tap opening the box of what is tapped; the boat sails on and
// the sea is not drawn while it is open; the pocket chart says how far the
// edge is and opens it; its list puts the nearest first; a notice is a
// status, dismissed by its button; and charted by sight, an island the boat
// sails up to is charted, the sailor's, with a notice.

import { existsSync, readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { openScene } from './helpers';

const chartFile = new URL('../../.dev/worlds/1.chart', import.meta.url);
const catalogFile = new URL('../src/catalog/catalog.gen.json', import.meta.url);

test.skip(!existsSync(chartFile), 'no chart for seed 1: run go run ./tools/dev -world 1');

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
    expect(
      near.labels.find((l) => l.text === water)?.italic,
      JSON.stringify([water, near.labels]),
    ).toBe(true);
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
    const caption = page.locator('.pocket-caption');
    await expect(caption).toHaveText(/^Chart · edge \d\.\d NM$/);
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

  test('its list puts the nearest first, and a tap shows it on the chart', async ({ page }) => {
    await openScene(page, 'world=1', true);
    await page.evaluate(() => globalThis.keel.openChart('list'));
    const where = await page
      .locator('.chart-list ul')
      .first()
      .locator('.chart-list-where')
      .allTextContents();
    const metres = where.map((w) => {
      const [, n, unit] = /(\d+(?:\.\d+)?) (NM|m)$/.exec(w) ?? [];
      return Number(n) * (unit === 'NM' ? 1852 : 1);
    });
    expect(metres.length).toBeGreaterThan(10);
    expect(metres).toEqual([...metres].sort((a, b) => a - b));
    await page.locator('.chart-list li button').first().click();
    const info = await page.evaluate(() => globalThis.keel.chartInfo());
    expect(info.mode).toBe('chart');
    expect(info.picked).not.toBeNull();
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
});
