// SPDX-License-Identifier: AGPL-3.0-only

// Sailing to a storm by the chart, in the sandbox on seed 1's world: the
// chart opens at now, which shows a storm the developer's weather placed
// at once and follows it as it moves; the slider half an hour ahead shows
// it where the world puts it then; Play runs the slider on to ninety
// minutes and stops; and a tap on the storm opens its box, whose Steer
// sets the autopilot to the course to meet it, closes the chart, and the
// boat, with a breeze it can hold that course in, turns to it.

import { existsSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { openScene } from './helpers';

const chartFile = new URL('../../.dev/worlds/1.chart', import.meta.url);

test.skip(!existsSync(chartFile), 'no chart for seed 1: run go run ./tools/dev -world 1');

// A small page, as the chart's other tests have it: a software renderer
// draws the open chart for every pixel.
test.use({ viewport: { width: 640, height: 480 } });

const MINUTE = 1800;

/** Draws the chart a few times, its frames apart. */
async function drawChart(page: Page, n = 4): Promise<void> {
  for (let i = 0; i < n; i++) {
    await page.evaluate(() => globalThis.keel.render());
    await page.waitForTimeout(40);
  }
}

/** Sails the world's time on by ticks, a minute at a time, the forecast issued and the truth kept as it goes. */
async function pass(page: Page, ticks: number): Promise<void> {
  for (let left = ticks; left > 0; left -= MINUTE) {
    await page.evaluate(
      (n) => {
        globalThis.keel.advance(n);
        globalThis.keel.weatherNow();
      },
      Math.min(left, MINUTE),
    );
  }
  await drawChart(page, 2);
}

/** The storm on the chart's weather as last painted: the strongest system, or undefined. */
async function storm(page: Page) {
  const w = await page.evaluate(() => globalThis.keel.chartWeather());
  const s = [...w.systems].sort((a, b) => b.ring - a.ring)[0];
  return { moment: w.moment, s, paints: w.paints };
}

/** Draws the chart until its weather is painted at the world's tick now, as now is once a second. */
async function paintedNow(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        await drawChart(page, 1);
        return page.evaluate(() => {
          const m = globalThis.keel.chartWeather().moment;
          return m?.kind === 'now' && m.tick === globalThis.keel.forecast()?.tick;
        });
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

test.describe('sailing to a storm by the chart', () => {
  test('now follows it, the slider ahead shows it where it will be, Play runs on and stops', async ({
    page,
  }) => {
    await openScene(page, 'world=1', true);
    await page.evaluate(() => {
      globalThis.keel.setSky(12);
      // Out in the open water, a storm to reach the boat in half an hour.
      globalThis.keel.placeBoat(-3500, -5000, 0);
      globalThis.keel.galeIn(30);
    });
    // A couple of minutes for it to grow past a trace.
    await pass(page, 2 * MINUTE);
    await page.evaluate(() => {
      globalThis.keel.openChart('chart');
      globalThis.keel.fitChart();
    });
    await paintedNow(page);
    await expect(page.locator('[data-readout="chart-time"]')).toHaveText('Now');
    const first = await storm(page);
    expect(first.moment?.kind).toBe('now');
    expect(first.s).toBeDefined();
    expect(first.s?.ring).toBeGreaterThan(0);
    // Now is live: a minute on, it has moved as it moves, with no new issue.
    await page.evaluate((n) => globalThis.keel.advance(n), MINUTE);
    await paintedNow(page);
    const next = await storm(page);
    const s0 = first.s;
    const s1 = next.s;
    if (s0 === undefined || s1 === undefined) {
      throw new Error('no storm on the chart');
    }
    const dt = ((next.moment?.tick ?? 0) - (first.moment?.tick ?? 0)) / 30;
    const run = Math.hypot(s1.east - s0.east, s1.north - s0.north);
    expect(run).toBeGreaterThan(0.5 * s0.speed * dt);
    expect(run).toBeLessThan(2 * s0.speed * dt + 20);
    // Half an hour ahead: where it will be, which the world then agrees with.
    await page.evaluate(() => globalThis.keel.chartTime(30));
    await drawChart(page);
    const ahead = await storm(page);
    expect(ahead.moment?.kind).toBe('ahead');
    expect(ahead.moment?.minutes).toBe(30);
    await expect(page.locator('[data-readout="chart-time"]')).toContainText('In 30 min · ');
    const then = ahead.moment?.tick ?? 0;
    const sa = ahead.s;
    if (sa === undefined) {
      throw new Error('no storm ahead');
    }
    await page.evaluate(() => globalThis.keel.chartTime(0));
    const now = (await page.evaluate(() => globalThis.keel.forecast()))?.tick ?? 0;
    await pass(page, Math.round(then - now));
    await paintedNow(page);
    const there = await storm(page);
    expect(there.moment?.kind).toBe('now');
    expect(there.moment?.tick).toBe(then);
    expect(
      Math.hypot((there.s?.east ?? 0) - sa.east, (there.s?.north ?? 0) - sa.north),
    ).toBeLessThan(1);
    // Play: on from now to ninety minutes, then it stops.
    const before = there.paints;
    await page.getByRole('button', { name: 'Play' }).click();
    // The chart is drawn as the frames come, its weather painted as it keeps up.
    await expect
      .poll(
        async () => {
          await drawChart(page, 1);
          return page.evaluate(() => globalThis.keel.chartSlider().playing);
        },
        { timeout: 20_000 },
      )
      .toBe(false);
    const slider = await page.evaluate(() => globalThis.keel.chartSlider());
    expect(slider.minutes).toBe(90);
    await drawChart(page);
    const played = await storm(page);
    expect(played.moment?.minutes).toBe(90);
    expect(played.paints - before).toBeGreaterThan(3);
  });

  test('a tap on the storm opens its box; Steer sets the autopilot and the boat turns to it', async ({
    page,
  }) => {
    await openScene(page, 'world=1', true);
    await page.evaluate(() => {
      globalThis.keel.setSky(12);
      globalThis.keel.placeBoat(-3500, -5000, 0);
      globalThis.keel.galeIn(30);
    });
    await pass(page, 3 * MINUTE);
    await page.evaluate(() => {
      globalThis.keel.openChart('chart');
      globalThis.keel.fitChart();
    });
    await drawChart(page);
    const { s } = await storm(page);
    if (s === undefined) {
      throw new Error('no storm on the chart');
    }
    // A tap within it, off any charted place's mark, which a tap opens first.
    let tapped = false;
    for (let k = 0; k < 9 && !tapped; k++) {
      const a = (k * Math.PI) / 4;
      const r = k === 8 ? 0 : 0.7 * Math.max(s.ring, s.size);
      const at = await page.evaluate(([e, n]) => globalThis.keel.chartScreenOf(e, n), [
        s.east + r * Math.sin(a),
        s.north + r * Math.cos(a),
      ] as const);
      if (at === null) {
        continue;
      }
      // Apart, so that two are not a double tap.
      await page.waitForTimeout(400);
      await page.mouse.click(at.x, at.y);
      tapped = (await page.evaluate(() => globalThis.keel.chartTapped())) !== null;
      const placeBox = page.locator('.chart-box:not(.chart-system)').getByRole('button', {
        name: 'Close',
      });
      if (!tapped && (await placeBox.count()) > 0) {
        // A place's box, which would lie over the next tap.
        await placeBox.dispatchEvent('click');
      }
    }
    expect(tapped).toBe(true);
    const box = page.locator('[data-readout="system-box"]');
    await expect(box).toBeVisible();
    await expect(box).toContainText(s.name);
    await expect(box).toContainText(/\d+ kn, gusts \d+ kn/);
    await expect(box).toContainText(/from you/);
    await expect(page.locator('[data-readout="system-course"]')).not.toBeEmpty();
    const steer = box.getByRole('button', { name: /^Steer \d{3}°$/ });
    await steer.click();
    expect((await page.evaluate(() => globalThis.keel.chartInfo())).open).toBe(false);
    const course = await page.evaluate(() => globalThis.keel.chartSteered());
    expect(course).not.toBeNull();
    const heading = course?.heading ?? 0;
    const b = await page.evaluate(() => globalThis.keel.boat());
    // The heading mode, holding the course: 65536ths of a turn.
    expect(b.pilot.mode).toBe(2);
    const want = Math.round((heading / (2 * Math.PI)) * 65536) % 65536;
    expect(b.pilot.target).toBe(want < 0 ? want + 65536 : want);
    // The storm comes down the wind, so the course to meet it is often
    // close to dead upwind, which no boat holds; with a steady breeze on
    // the beam of it, a minute on, the boat heads for it.
    await page.evaluate(
      (h) => globalThis.keel.setWind(12, ((((h * 180) / Math.PI + 90) % 360) + 360) % 360),
      heading,
    );
    await pass(page, MINUTE);
    const after = await page.evaluate(() => globalThis.keel.boat());
    const off = Math.atan2(
      Math.sin(after.state.heading - heading),
      Math.cos(after.state.heading - heading),
    );
    expect(Math.abs(off)).toBeLessThan((10 * Math.PI) / 180);
  });
});
