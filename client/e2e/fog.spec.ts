// SPDX-License-Identifier: AGPL-3.0-only

// Fog, visibility and lightning in the sandbox: a fog bank held on the boat
// makes very poor visibility, hides what is 300 m off and not what is 60 m
// off, and costs no draw; from outside a bank whitens the horizon toward
// it; a light in fog by day is lit and seen close; a flash strikes when it
// was asked for, draws its bolt in one more draw and lights its cloud; the
// screen pulses at most three times a second; and two pages find the same
// flashes.

import { existsSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { openScene, type Picture, picture } from './helpers';

const world = new URL('../../.dev/worlds/1.world', import.meta.url);

/** The optical depth a thing is seen through at most: Koschmieder's 2%. */
const CONTRAST = 3.912;

/** The mean brightness of a band of a picture's rows, from y0 to y1 as shares of its height. */
function band(p: Picture, y0: number, y1: number): number {
  let sum = 0;
  let n = 0;
  for (let y = Math.floor(y0 * p.height); y < Math.floor(y1 * p.height); y++) {
    for (let x = 0; x < p.width; x++) {
      const i = (y * p.width + x) * 4;
      sum += (p.data[i] ?? 0) + (p.data[i + 1] ?? 0) + (p.data[i + 2] ?? 0);
      n++;
    }
  }
  return sum / Math.max(n, 1) / 3;
}

/** The optical depth from the camera to a point d m ahead of the boat, h m up, as the module gives it. */
async function ahead(page: Page, d: number, h: number): Promise<number> {
  return page.evaluate(
    ([d, h]) => {
      const k = globalThis.keel;
      const e = k.eye();
      const a = k.boat().state.heading;
      return (
        k.opticalDepth(
          e.east,
          e.north,
          e.height,
          e.east + d * Math.sin(a),
          e.north + d * Math.cos(a),
          h,
        ) ?? 0
      );
    },
    [d, h] as const,
  );
}

test.describe('a fog bank', () => {
  test('held on the boat, visibility is very poor: a boat 300 m off is hidden, one 60 m off seen, at no draw', async ({
    page,
  }) => {
    await openScene(page);
    const clear = await page.evaluate(async () => {
      const k = globalThis.keel;
      k.setSky(12);
      await k.show();
      return { draws: k.info().drawCalls, vis: k.visibility() };
    });
    expect(clear.vis?.word).toBe('good');
    await page.evaluate(async () => {
      const k = globalThis.keel;
      k.setFog(100);
      k.render();
      await k.show();
    });
    const fog = await page.evaluate(() => ({
      vis: globalThis.keel.visibility(),
      draws: globalThis.keel.info().drawCalls,
      scene: globalThis.keel.checkScene(),
    }));
    expect(fog.vis?.word).toBe('very poor');
    expect(fog.vis?.visibility).toBeLessThan(120);
    expect(fog.vis?.sources).toBe(1);
    expect(await ahead(page, 300, 1)).toBeGreaterThan(CONTRAST);
    expect(await ahead(page, 60, 1)).toBeLessThan(CONTRAST);
    // The fog is in the materials: no draw of its own.
    expect(fog.draws).toBe(clear.draws);
    expect(fog.scene).toEqual([]);
  });

  test('from outside whitens the horizon toward it', async ({ page }) => {
    await openScene(page, 'fog=100');
    // A mile and more east of the bank's axis, looking toward it and away.
    const look = async (heading: number): Promise<Picture> => {
      await page.evaluate((heading) => {
        const k = globalThis.keel;
        k.setSky(12);
        k.placeBoat(1900, 0, heading);
        k.render();
        // Long enough for the overcast of the bank left behind to ease.
        k.advance(600);
        k.render();
        k.camera({ azimuth: 0, elevation: 0.03, distance: 12 });
        k.render();
      }, heading);
      return picture(page);
    };
    const toward = await look(-Math.PI / 2);
    const away = await look(Math.PI / 2);
    const vis = await page.evaluate(() => globalThis.keel.visibility());
    expect(vis?.word).not.toBe('very poor');
    // The sky just over the horizon.
    const whiter = band(toward, 0.18, 0.25) - band(away, 0.18, 0.25);
    expect(whiter).toBeGreaterThan(4);
  });
});

test.describe('a light in fog', () => {
  test.skip(!existsSync(world), 'no world file for seed 1: run go run ./tools/dev -world 1');

  test('is lit by day and seen close, not far', async ({ page }) => {
    await openScene(page, 'world=1');
    const glow = async (fog: number | null, to: number): Promise<number> =>
      page.evaluate(
        async ([fog, to]) => {
          const k = globalThis.keel;
          k.setSky(12);
          k.setFog(fog);
          // Toward Port Royal's light, to m from it.
          const s = k.fogSignals()[0];
          if (s === undefined) {
            throw new Error('no light in range');
          }
          const b = k.boat().state;
          const a = (s.bearing * Math.PI) / 180;
          const go = s.distance - to;
          k.placeBoat(b.x + go * Math.sin(a), b.y + go * Math.cos(a), a);
          // The brightest its glow is drawn over its character's period,
          // which is mostly dark.
          let most = 0;
          for (let i = 0; i < 60; i++) {
            k.advance(10);
            k.render();
            const g = k.lights().glows.filter((x) => x.mode === 'glow');
            most = Math.max(most, ...g.map((x) => x.strength));
          }
          await k.show();
          return most;
        },
        [fog, to] as const,
      );
    // In clear air by day, dark.
    expect(await glow(null, 60)).toBe(0);
    // In fog by day, lit: over its threshold close, not 300 m off.
    expect(await glow(100, 60)).toBeGreaterThanOrEqual(0.2);
    expect(await glow(100, 300)).toBeLessThan(0.2);
  });
});

test.describe('lightning', () => {
  test('a flash asked for strikes in two seconds, draws its bolt in one more draw, and lights its cloud', async ({
    page,
  }) => {
    await openScene(page, 'weather=squall');
    const before = await page.evaluate(async () => {
      const k = globalThis.keel;
      k.setSky(22);
      // The squall over the boat.
      k.advance(3600);
      k.render();
      // Looking along the squall's way, toward its flash.
      k.flashIn(2);
      k.advance(45);
      k.render();
      await k.show();
      return { draws: k.info().drawCalls, flashes: k.flashes() };
    });
    expect(before.flashes.segments).toBe(0);
    const after = await page.evaluate(async () => {
      const k = globalThis.keel;
      // Two seconds and a frame on.
      k.advance(17);
      k.render();
      await k.show();
      return { draws: k.info().drawCalls, flashes: k.flashes(), scene: k.checkScene() };
    });
    expect(after.flashes.segments).toBeGreaterThan(10);
    expect(after.flashes.cloud).toBeGreaterThan(0.2);
    expect(after.draws).toBe(before.draws + 1);
    expect(after.scene).toEqual([]);
  });

  test('the screen pulses at most three times a second, however many flashes come', async ({
    page,
  }) => {
    await openScene(page, 'weather=squall');
    const pulses = await page.evaluate(() => {
      const k = globalThis.keel;
      k.advance(3600);
      k.render();
      // Ten flashes a tenth of a second apart.
      for (let i = 0; i < 10; i++) {
        k.flashIn(0.5 + i * 0.1);
      }
      for (let i = 0; i < 90; i++) {
        k.advance(1);
        k.render();
      }
      return k.flashes().pulses;
    });
    expect(pulses.length).toBeGreaterThan(0);
    for (const p of pulses) {
      expect(pulses.filter((q) => q >= p && q < p + 1).length).toBeLessThanOrEqual(3);
    }
  });

  test('two pages find the same flashes', async ({ browser }) => {
    const take = async () => {
      const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
      await openScene(page, 'weather=squall');
      const f = await page.evaluate(() => {
        const k = globalThis.keel;
        for (let i = 0; i < 60; i++) {
          k.advance(200);
          k.render();
        }
        return k.flashes().flashes;
      });
      await page.close();
      return f;
    };
    const a = await take();
    const b = await take();
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });
});
