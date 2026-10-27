// SPDX-License-Identifier: AGPL-3.0-only

// The chart's weather drawn, in the sandbox on seed 1's world: every kind
// of system on the disk at once, a warm front and a cold front crossing
// it, the wind's wash and barbs and the isobars, pictured on a phone and on
// a desktop; how long its painting takes with every layer on; and the
// picture under each colour vision deficiency and in grey, kept for the
// owner to judge.

import { existsSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { openScene } from './helpers';

const chartFile = new URL('../../.dev/worlds/1.chart', import.meta.url);

test.skip(!existsSync(chartFile), 'no chart for seed 1: run go run ./tools/dev -world 1');

/** Draws the chart a few times, its frames apart. */
async function drawChart(page: Page, n = 6): Promise<void> {
  for (let i = 0; i < n; i++) {
    await page.evaluate(() => globalThis.keel.render());
    await page.waitForTimeout(40);
  }
}

/**
 * The chart open on the whole disk with every kind of system on it, now,
 * its letters in their own face; the streaks off, which are scattered
 * afresh each time.
 */
async function openEveryKind(page: Page): Promise<void> {
  await openScene(page, 'world=1', true);
  await page.evaluate(() => {
    globalThis.keel.setSky(12);
    globalThis.keel.everyKind();
    globalThis.keel.render();
    globalThis.keel.openChart('chart');
    globalThis.keel.fitChart();
    globalThis.keel.chartLayers({ streaks: false });
  });
  await page.evaluate(() => document.fonts.ready);
  // Painted again once the face is had.
  await page.evaluate(() => globalThis.keel.chartLayers({ gusts: false }));
  await drawChart(page, 2);
  await page.evaluate(() => globalThis.keel.chartLayers({ gusts: true }));
  await drawChart(page);
}

const SIZES = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 960, height: 600 },
] as const;

test.describe('every kind of system on the chart', () => {
  test.beforeEach(() => {
    test.skip(
      test.info().project.name !== 'webgl2',
      'a canvas of its own, the same on either back end',
    );
  });

  test('the chart holds every symbol, both fronts and its letters', async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 600 });
    await openEveryKind(page);
    const w = await page.evaluate(() => globalThis.keel.chartWeather());
    expect(w.moment?.kind).toBe('now');
    const draws = new Set(w.systems.map((s) => s.draw));
    for (const d of ['spiral', 'low', 'dash-dot', 'dashed', 'cell', 'heap', 'bank', 'calm']) {
      expect(draws.has(d as never), d).toBe(true);
    }
    expect(w.fronts).toBe(2);
    expect(w.inked).toBeGreaterThan(0);
  });

  for (const size of SIZES) {
    test(`pictured on a ${size.name}`, async ({ page }) => {
      test.skip(process.platform !== 'darwin', 'the pictures are taken on the Mac');
      await page.setViewportSize({ width: size.width, height: size.height });
      await openEveryKind(page);
      await expect(page).toHaveScreenshot(`weather-chart-${size.name}.png`);
    });
  }

  test('its paint each second with every layer on, timed', async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 600 });
    await openEveryKind(page);
    await page.evaluate(() => globalThis.keel.chartLayers({ streaks: true }));
    const took: { sample: number; paint: number }[] = [];
    for (let i = 0; i < 8; i++) {
      // Now is painted afresh each second.
      await page.waitForTimeout(1050);
      await drawChart(page, 1);
      const w = await page.evaluate(() => globalThis.keel.chartWeather());
      if (w.took !== null) {
        took.push(w.took);
      }
    }
    expect(took.length).toBeGreaterThan(0);
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
    const sample = median(took.map((t) => t.sample));
    const paint = median(took.map((t) => t.paint));
    test.info().annotations.push({
      type: 'measured',
      description: JSON.stringify({ sample, paint, paints: took.length }),
    });
    process.stdout.write(
      `the chart's weather each second: sampled in ${sample.toFixed(1)} ms, painted in ${paint.toFixed(1)} ms\n`,
    );
  });

  test('under each colour vision deficiency and in grey, for the owner', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 800 });
    await openEveryKind(page);
    const cdp = await page.context().newCDPSession(page);
    for (const type of ['none', 'protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia']) {
      await cdp.send('Emulation.setEmulatedVisionDeficiency', { type: type as 'none' });
      await drawChart(page, 2);
      await test.info().attach(`weather-chart-${type}.png`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
    }
  });
});
