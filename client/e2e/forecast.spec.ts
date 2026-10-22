// SPDX-License-Identifier: AGPL-3.0-only

// The forecast in a real browser, in the sandbox on seed 1's world, whose
// forecast is made as the server makes its own: the chart's slider shows
// the latest issue's steps and, back, what happened, never what is to come;
// each layer of the chart's weather is painted only with its switch, within
// the chart's budget; a gale warning is raised once however often it is
// issued again, names the nearest charted place, and is not raised with its
// switch off; the barometer's words follow its readings, its set hand a
// quarter of an hour behind; the harbourmaster's board is in Port Royal's
// harbour, the storm cone hoisted over it while a gale is in force; and the
// pocket chart's weather switch is kept. The chart's weather under each
// colour vision deficiency is saved for the owner to judge.

import { existsSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { openScene } from './helpers';

const chartFile = new URL('../../.dev/worlds/1.chart', import.meta.url);

test.skip(!existsSync(chartFile), 'no chart for seed 1: run go run ./tools/dev -world 1');

// Small pages, as the chart's other tests have them: a software renderer
// draws the open chart for every pixel.
test.use({ viewport: { width: 480, height: 300 } });

const MINUTE = 1800;

/** The chart's budget, charted whole, its weather drawn on its paper. */
const DRAWS = 40;
const TRIANGLES = 250_000;

/** Draws the chart a few times, its frames apart. */
async function drawChart(page: Page, n = 8): Promise<void> {
  for (let i = 0; i < n; i++) {
    await page.evaluate(() => globalThis.keel.render());
    await page.waitForTimeout(40);
  }
}

/** Sails the world's time on, five minutes at a time, its forecast issued and its truth kept as it goes. */
async function passMinutes(page: Page, minutes: number): Promise<void> {
  for (let m = 0; m < minutes; m += 5) {
    // The world's tick moves on with a frame drawn.
    await page.evaluate((n) => {
      globalThis.keel.advance(n);
      globalThis.keel.render();
      globalThis.keel.weatherNow();
    }, 5 * MINUTE);
  }
}

/** The chart open on the whole world, its forecast issued. */
async function openWeather(page: Page, query: string): Promise<void> {
  await openScene(page, `world=1&${query}`, true);
  await page.evaluate(() => {
    globalThis.keel.setSky(12);
    globalThis.keel.issueForecast();
    globalThis.keel.openChart('chart');
    globalThis.keel.fitChart();
  });
  await drawChart(page);
}

test.describe('the chart’s weather', () => {
  test('the slider shows the forecast’s steps ahead and what happened behind, never what is to come', async ({
    page,
  }) => {
    await openScene(page, 'world=1&weather=storm', true);
    await page.evaluate(() => globalThis.keel.setSky(12));
    // An hour of weather kept, its forecasts issued as it went.
    await passMinutes(page, 60);
    await page.evaluate(() => {
      globalThis.keel.openChart('chart');
      globalThis.keel.fitChart();
    });
    await drawChart(page);
    const f = await page.evaluate(() => globalThis.keel.forecast());
    expect(f?.issue).not.toBeNull();
    expect(f?.steps).toBe(10);
    const now = f?.tick ?? 0;
    expect(now - (f?.issue ?? 0)).toBeLessThan(10 * MINUTE);
    expect(f?.truth.length).toBeGreaterThanOrEqual(12);
    const at = async (minutes: number) => {
      await page.evaluate((m) => globalThis.keel.chartTime(m), minutes);
      await drawChart(page, 4);
      return page.evaluate(() => globalThis.keel.chartWeather());
    };
    const ahead = await at(30);
    expect(ahead.moment).toEqual({
      kind: 'forecast',
      step: 3,
      tick: (f?.issue ?? 0) + 30 * MINUTE,
    });
    expect(ahead.systems.every((s) => s.cone > 0)).toBe(true);
    const back = await at(-30);
    expect(back.moment?.kind).toBe('past');
    expect(back.moment?.tick).toBe(now - 30 * MINUTE);
    // What happened is judged against the forecast of then, the truth's
    // systems inside its cones or not, and none without a truth.
    expect(back.judged).toBeLessThanOrEqual(back.systems.length);
    expect(back.inside).toBeLessThanOrEqual(back.judged);
    // Further back than is kept, it shows the oldest kept, never now's.
    const far = await at(-90);
    expect(far.moment?.kind).toBe('past');
    expect(far.moment?.tick ?? now).toBeLessThan(now);
    const nowShown = await at(0);
    expect(nowShown.moment?.kind).toBe('now');
    await expect(page.locator('[data-readout="chart-time"]')).toContainText('Now');
  });

  test('each layer is painted only with its switch, within the chart’s budget', async ({
    page,
  }) => {
    await openWeather(page, 'weather=storm');
    // Half an hour ahead, when the storm the sandbox called up is born.
    await page.evaluate(() => globalThis.keel.chartTime(30));
    const layers = ['gusts', 'rain', 'fog', 'systems', 'pressure'] as const;
    const paint = async (on: readonly string[]) => {
      await page.evaluate(
        (o) =>
          globalThis.keel.chartLayers(
            Object.fromEntries(
              ['gusts', 'rain', 'fog', 'systems', 'pressure'].map((l) => [l, o.includes(l)]),
            ) as Record<'gusts', boolean>,
          ),
        on,
      );
      await drawChart(page, 3);
      return page.evaluate(() => globalThis.keel.chartWeather());
    };
    const none = await paint([]);
    expect(none.inked).toBe(0);
    const all = await paint(layers);
    expect(all.inked).toBeGreaterThan(0);
    const alone: Record<string, number> = {};
    for (const l of layers) {
      alone[l] = (await paint([l])).inked;
    }
    // A storm's systems and its isobars are always there to paint; the
    // rain and the fog where the scene has them.
    expect(alone.systems).toBeGreaterThan(0);
    expect(alone.pressure).toBeGreaterThan(0);
    if (all.rain > 0) {
      expect(alone.rain).toBeGreaterThan(0);
    }
    if (all.fog === 0) {
      expect(alone.fog).toBe(0);
    }
    for (const l of layers) {
      expect(alone[l] ?? 0, l).toBeLessThanOrEqual(all.inked);
    }
    const chart = await page.evaluate(() => globalThis.keel.chartInfo());
    expect(chart.meshes).toBeLessThanOrEqual(DRAWS);
    expect(chart.triangles).toBeLessThanOrEqual(TRIANGLES);
    expect(chart.problems).toEqual([]);
    test.info().annotations.push({
      type: 'measured',
      description: JSON.stringify({ took: all.took, inked: alone, meshes: chart.meshes }),
    });
  });

  test('a place’s box gives its weather now and its outlook', async ({ page }) => {
    await openWeather(page, 'weather=storm');
    const w = await page.evaluate(() => globalThis.keel.placeWeather('Port Royal'));
    expect(w).not.toBeNull();
    expect(JSON.stringify(w)).toMatch(/kn/);
    expect(await page.evaluate(() => globalThis.keel.position(0, 0))).toMatch(/°/);
  });

  test('the chart’s weather under each colour vision deficiency, for the owner', async ({
    page,
  }) => {
    test.skip(test.info().project.name !== 'webgl2', 'the pictures once');
    await page.setViewportSize({ width: 640, height: 640 });
    await openWeather(page, 'weather=storm');
    await page.evaluate(() => globalThis.keel.chartTime(30));
    await drawChart(page);
    const cdp = await page.context().newCDPSession(page);
    for (const type of ['none', 'protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia']) {
      await cdp.send('Emulation.setEmulatedVisionDeficiency', {
        type: type as 'none',
      });
      await drawChart(page, 2);
      await test.info().attach(`chart-weather-${type}.png`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
    }
  });
});

test.describe('gale warnings', () => {
  // The menu over the controls wants the page's usual size.
  test.use({ viewport: { width: 960, height: 600 } });

  test('a gale is warned of once however often it is issued, naming the nearest charted place', async ({
    page,
  }) => {
    await openScene(page, 'world=1', true);
    await page.evaluate(() => {
      globalThis.keel.setSky(12);
      // Off the harbour, where a gale blows whole.
      globalThis.keel.placeBoat(-3500, -5000, 0);
      globalThis.keel.galeIn(30);
      globalThis.keel.issueForecast();
      globalThis.keel.issueForecast();
    });
    const f = await page.evaluate(() => globalThis.keel.forecast());
    expect(f?.gale).not.toBeNull();
    expect(f?.gale?.place).not.toBeNull();
    expect(f?.warning).toMatch(/gale|storm/i);
    const shown = await page.evaluate(() =>
      globalThis.keel.noticesShown().filter((t) => t.startsWith('Gale warning')),
    );
    expect(shown.length).toBe(1);
    expect(shown[0]).toContain(f?.warning?.split(', ').at(-1) ?? '');
    // The chart hatches it while it is ahead.
    await page.evaluate(() => {
      globalThis.keel.openChart('chart');
      globalThis.keel.fitChart();
      globalThis.keel.chartTime(30);
    });
    await drawChart(page);
    expect((await page.evaluate(() => globalThis.keel.chartWeather())).gale).toBeGreaterThan(0);
  });

  test('switched off, a gale warning is not raised', async ({ page }) => {
    await openScene(page, 'world=1', true);
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.locator('input[name="notice-gale-warnings"]').uncheck();
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.evaluate(() => {
      globalThis.keel.placeBoat(-3500, -5000, 0);
      globalThis.keel.galeIn(30);
    });
    expect((await page.evaluate(() => globalThis.keel.forecast()))?.gale).not.toBeNull();
    expect(
      await page.evaluate(() =>
        globalThis.keel.noticesShown().filter((t) => t.startsWith('Gale warning')),
      ),
    ).toEqual([]);
  });
});

test.describe('the barometer', () => {
  test.use({ viewport: { width: 960, height: 600 } });

  test('its words follow its readings at each rate, its set hand a quarter of an hour behind', async ({
    page,
  }) => {
    await openScene(page, 'world=1&weather=settled', true);
    const words: Record<string, string> = {};
    for (const rate of [0, -5, -7, 3]) {
      const was = await page.evaluate((r) => {
        globalThis.keel.holdBarometer(r);
        globalThis.keel.weatherNow();
        return globalThis.keel.barometer()?.now ?? 0;
      }, rate);
      await passMinutes(page, 15);
      const b = await page.evaluate(() => globalThis.keel.barometer());
      words[rate] = b?.words ?? '';
      expect(b?.now ?? 0).toBeGreaterThan(900);
      // The set hand is at its own reading of a quarter of an hour before.
      expect(b?.set).toBeCloseTo(was, 6);
    }
    // The held change and the settled weather's own, a little.
    expect(words[-5]).toMatch(/hPa, falling quickly$/);
    expect(words[-7]).toMatch(/hPa, falling very rapidly$/);
    expect(words[3]).toMatch(/hPa, rising/);
    await expect(page.locator('[data-readout="barometer"]')).toHaveText(words[3] ?? '');
  });

  test('it can be put away from the menu', async ({ page }) => {
    await openScene(page, 'world=1', true);
    await expect(page.locator('.barometer')).toBeVisible();
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.locator('input[name="barometer"]').uncheck();
    await expect(page.locator('.barometer')).toHaveCount(0);
    await openScene(page, 'world=1', true);
    await expect(page.locator('.barometer')).toHaveCount(0);
  });
});

test.describe('the harbourmaster’s board', () => {
  test.use({ viewport: { width: 960, height: 600 } });

  test('in Port Royal’s harbour, its board; and the storm cone hoisted while a gale is in force', async ({
    page,
  }) => {
    await openScene(page, 'world=1', true);
    expect((await page.evaluate(() => globalThis.keel.board())).button).toBe(false);
    expect(await page.evaluate(() => globalThis.keel.toHarbour())).toBe(true);
    await page.evaluate(() => globalThis.keel.issueForecast());
    const before = await page.evaluate(() => {
      globalThis.keel.render();
      globalThis.keel.render();
      return globalThis.keel.info().drawCalls;
    });
    await expect(page.locator('.board-button')).toBeVisible();
    await page.locator('.board-button').click();
    await expect(page.locator('.board')).toContainText('General situation');
    await expect(page.locator('.board')).toContainText('Next 90 minutes');
    await expect(page.locator('[data-readout="board-outlook"]')).not.toBeEmpty();
    // A gale: the warning on the board, the cone hoisted, a draw at most.
    await page.evaluate(() => globalThis.keel.galeIn(20));
    await expect(page.locator('.board-warning')).toBeVisible({ timeout: 15_000 });
    const after = await page.evaluate(() => {
      globalThis.keel.render();
      globalThis.keel.render();
      return { draws: globalThis.keel.info().drawCalls, scene: globalThis.keel.checkScene() };
    });
    expect(after.draws - before).toBeLessThanOrEqual(1);
    expect(after.scene).toEqual([]);
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('.board')).toHaveCount(0);
  });
});

test.describe('the pocket chart', () => {
  test.use({ viewport: { width: 960, height: 600 } });

  test('its weather switch is kept', async ({ page }) => {
    await openScene(page, 'world=1', true);
    const sw = page.locator('.pocket-weather');
    await expect(sw).toHaveAttribute('aria-pressed', 'true');
    await sw.click();
    await expect(sw).toHaveAttribute('aria-pressed', 'false');
    await openScene(page, 'world=1', true);
    await expect(page.locator('.pocket-weather')).toHaveAttribute('aria-pressed', 'false');
  });
});
