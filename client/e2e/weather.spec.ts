// SPDX-License-Identifier: AGPL-3.0-only

// The weather in the sky, in the sandbox: a squall's tower before its gust
// front, rain held and its draws, the same cloud on two pages, a storm's
// cloud far off within the far plane, and the sheets over the stars and the
// sun.

import { expect, test } from '@playwright/test';
import { openScene, picture, pictureDifference } from './helpers';

/** How far a cloud whose top is h m up shows over the horizon of an eye 2 m up, m. */
const sight = (h: number): number => 100 + Math.sqrt(2 * 2500 * h);

test.describe('heaped cloud', () => {
  test('a squall’s tower shows over the horizon before its gust front reaches the boat', async ({
    page,
  }) => {
    await openScene(page, 'weather=trade');
    const got = await page.evaluate(() => {
      const k = globalThis.keel;
      // Beyond the refuge, where a squall blows whole, a squall called to
      // meet the boat three minutes on: born now.
      k.placeBoat(0, 6000, Math.PI / 2);
      k.setWeather('squall');
      k.advance(30);
      k.render();
      const calm = k.boat().wind.meanSpeed;
      let seen: number | null = null;
      let front: number | null = null;
      let tick = 0;
      for (let i = 0; i < 300 && front === null; i++) {
        k.advance(30);
        tick += 30;
        k.render();
        const b = k.boat().state;
        const c = k.clouds().clouds.find((x) => x.form === 3 && x.slot >= 0);
        if (seen === null && c !== undefined) {
          const away = Math.hypot(c.east - b.x, c.north - b.y);
          if (c.top > 1200 && away - 900 <= 100 + Math.sqrt(5000 * c.top)) {
            seen = tick;
          }
        }
        if (k.boat().wind.meanSpeed > calm + 4 * (1852 / 3600)) {
          front = tick;
        }
      }
      return { seen, front, scene: k.checkScene() };
    });
    expect(got.seen, 'its tower never showed').not.toBeNull();
    expect(got.front, 'its gust front never came').not.toBeNull();
    // Its tower before its gust front. The sandbox calls a squall up only
    // three minutes off, born then: the week's squalls, born beyond the
    // lip, give minutes (internal/weather's TestWeeks).
    expect((got.front ?? 0) - (got.seen ?? 0)).toBeGreaterThanOrEqual(15 * 30);
    expect(got.scene).toEqual([]);
  });

  test('a cloud is the same on two pages', async ({ browser }) => {
    const take = async () => {
      const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
      await openScene(page, 'weather=squall');
      const c = await page.evaluate(() => {
        const k = globalThis.keel;
        k.advance(1200);
        k.render();
        return k.clouds();
      });
      await page.close();
      return c;
    };
    const a = await take();
    const b = await take();
    expect(a.clouds.length).toBeGreaterThan(0);
    expect(a.heapedPuffs).toBeGreaterThan(20);
    expect(b.clouds).toEqual(a.clouds);
    expect(b.puffs).toBe(a.puffs);
  });

  test('a storm’s cloud far off is drawn, within the far plane', async ({ page }) => {
    await openScene(page, 'weather=storm');
    const got = await page.evaluate(() => {
      const k = globalThis.keel;
      k.setSky(13);
      k.advance(30 * 60 * 20);
      k.render();
      const b = k.boat().state;
      const c = k.clouds();
      const storm = c.clouds.find((x) => x.form === 4);
      if (storm === undefined) {
        return null;
      }
      // Toward the storm.
      k.placeBoat(b.x, b.y, Math.atan2(storm.east - b.x, storm.north - b.y));
      k.render();
      return { away: Math.hypot(storm.east - b.x, storm.north - b.y), top: storm.top, far: c.far };
    });
    expect(got, 'no storm').not.toBeNull();
    if (got === null) {
      return;
    }
    expect(got.away).toBeGreaterThan(3000);
    expect(got.away).toBeLessThan(got.far);
    expect(got.away).toBeLessThan(sight(got.top) + 2 * 1852 * 1.0);
    // With the weather and without it, the pictures differ: it is drawn.
    const shown = await picture(page);
    await page.evaluate(() => globalThis.keel.showWeather(false));
    const hidden = await picture(page);
    expect(pictureDifference(shown, hidden)).toBeGreaterThan(0.5);
  });
});

test.describe('rain', () => {
  test('?rain= holds rain at the boat: streaks, a shorter visibility, one draw', async ({
    page,
  }) => {
    await openScene(page, 'rain=20');
    const got = await page.evaluate(async () => {
      const k = globalThis.keel;
      k.advance(30);
      await k.show();
      const wet = { ...k.clouds(), draws: k.info().drawCalls, air: k.visibility() };
      k.setRain(0);
      k.advance(30 * 10);
      await k.show();
      const dry = { ...k.clouds(), draws: k.info().drawCalls, air: k.visibility() };
      return { wet, dry };
    });
    expect(got.wet.rain).toBeCloseTo(20, 0);
    expect(got.wet.streaks).toBeGreaterThan(100);
    // Its depth is along each ray, as a source the same everywhere; the
    // sea's horizon is held within the visibility at the camera.
    expect(got.wet.air?.cameraRange).toBeLessThan(2000);
    expect(got.wet.air?.sources).toBe(1);
    expect(got.dry.streaks).toBe(0);
    expect(got.dry.air?.cameraRange).toBeGreaterThan(5000);
    expect(got.dry.air?.sources).toBe(0);
    expect(got.wet.draws - got.dry.draws).toBe(1);
  });

  test('under a squall: puffs, curtains and streaks, three draws in all', async ({ page }) => {
    await openScene(page, 'weather=squall');
    const got = await page.evaluate(async () => {
      const k = globalThis.keel;
      // To the squall's core.
      for (let i = 0; i < 400 && k.clouds().rain < 20; i++) {
        k.advance(30);
        k.render();
      }
      await k.show();
      const shown = { ...k.clouds(), draws: k.info().drawCalls };
      k.showWeather(false);
      await k.show();
      return { shown, hidden: k.info().drawCalls, scene: k.checkScene() };
    });
    expect(got.shown.rain).toBeGreaterThan(20);
    expect(got.shown.curtains).toBeGreaterThan(0);
    expect(got.shown.streaks).toBeGreaterThan(0);
    expect(got.shown.overcast).toBeGreaterThan(0.5);
    expect(got.shown.draws - got.hidden).toBe(3);
    expect(got.scene).toEqual([]);
  });
});

test.describe('sheet cloud', () => {
  test('under a front’s sheets the sun’s disc is hidden and the light dimmed', async ({ page }) => {
    await openScene(page, 'weather=front&front=1');
    const got = await page.evaluate(() => {
      const k = globalThis.keel;
      k.setSky(10);
      k.advance(30);
      k.render();
      return k.clouds();
    });
    expect(got.sheets[1]).toBeGreaterThan(0.9);
    expect(got.overcast).toBeGreaterThan(0.7);
    // Looking at the sun, with the sheets and without: its disc is hidden.
    const at = await page.evaluate(() => {
      const k = globalThis.keel;
      // The sun low, ahead of the boat: it heads for it.
      k.setSky(7);
      const b = k.boat().state;
      k.placeBoat(b.x, b.y, (k.sky().sun.bearing * Math.PI) / 180);
      k.render();
      // From low astern, looking out over the bow toward it.
      k.camera({ azimuth: 0, elevation: 0.02, distance: 16 });
      k.render();
      return { ...k.sunOnScreen(), height: k.sky().sun.height };
    });
    const shown = await page.evaluate(() => globalThis.keel.clouds().light);
    const covered = await picture(page);
    await page.evaluate(() => {
      const k = globalThis.keel;
      k.showWeather(false);
      // Long enough for the light to clear: it eases over ten seconds.
      k.advance(30 * 20);
      k.render();
    });
    const clear = await page.evaluate(() => globalThis.keel.clouds().light);
    const open = await picture(page);
    const bright = (p: typeof open, x: number, y: number): number => {
      const i = 4 * (Math.round(y) * p.width + Math.round(x));
      return (p.data[i] ?? 0) + (p.data[i + 1] ?? 0) + (p.data[i + 2] ?? 0);
    };
    test.info().annotations.push({ type: 'sun', description: JSON.stringify(at) });
    expect(at.front).toBe(true);
    expect(at.x).toBeGreaterThan(0);
    expect(at.y).toBeGreaterThan(0);
    expect(at.x).toBeLessThan(open.width);
    expect(at.y).toBeLessThan(open.height);
    const x = at.x ?? 0;
    const y = at.y ?? 0;
    expect(bright(open, x, y)).toBeGreaterThan(700);
    expect(bright(covered, x, y)).toBeLessThan(bright(open, x, y) - 60);
    expect(shown).toBeLessThan(0.6 * clear);
  });

  test('a star under the sheets is not drawn and not tapped', async ({ page }) => {
    await openScene(page, 'weather=front&front=1');
    const got = await page.evaluate(() => {
      const k = globalThis.keel;
      k.setSky(0);
      k.advance(30);
      k.camera({ azimuth: 0, elevation: -0.6, distance: 20 });
      k.render();
      const names = k
        .namedStars()
        .filter((s) => s.height > 20)
        .map((s) => s.name);
      const under = names.map((n) => ({ n, s: k.starOnScreen(n) }));
      k.showWeather(false);
      k.advance(30);
      k.render();
      const clear = names.map((n) => ({ n, s: k.starOnScreen(n) }));
      return { under, clear };
    });
    const showing = got.clear.filter((c) => c.s?.shows === true);
    expect(showing.length).toBeGreaterThan(0);
    const hidden = got.under.filter((c) => c.s?.front === true && c.s.shows === false);
    expect(hidden.length).toBeGreaterThan(0);
  });
});
