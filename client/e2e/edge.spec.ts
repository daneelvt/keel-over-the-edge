// SPDX-License-Identifier: AGPL-3.0-only

// The edge of the world in the offline sandbox: the mist band thickening to
// the lip, the sky overhead still blue there, the sea ending at the lip and
// pouring over it, the falls the same on two pages at one world time,
// ?edge=off, going over and coming back at the start, an approach survived
// and told; and pictures of the lip and the falls.

import { expect, type Page, test } from '@playwright/test';
import { openScene, type Picture, picture, pictureDifference } from './helpers';

/** The lip, metres from the centre, and the mist band's inner edge. */
const LIP = 8334;
const BAND = 4.2 * 1852;

/** The largest difference of any channel between two pictures, 0 to 255. */
function largestDifference(a: Picture, b: Picture): number {
  let most = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      most = Math.max(most, Math.abs((a.data[i + c] ?? 0) - (b.data[i + c] ?? 0)));
    }
  }
  return most;
}

/** The mean of each channel over the rows from y0 to y1. */
function meanColour(p: Picture, y0: number, y1: number): [number, number, number] {
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < p.width; x++) {
      const o = (y * p.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        sum[c] = (sum[c] ?? 0) + (p.data[o + c] ?? 0);
      }
      n++;
    }
  }
  return [(sum[0] ?? 0) / n, (sum[1] ?? 0) / n, (sum[2] ?? 0) / n];
}

/** Flat water, every tile alike, the sky of noon held: only the place differs. */
async function still(page: Page): Promise<void> {
  await page.evaluate(() => {
    const k = globalThis.keel;
    k.setSea('flat');
    k.setIdentity(false);
    k.setSky(12);
    k.holdSky(true);
    k.render();
  });
}

/** Puts the boat at (east, north) heading heading, the camera at a view, and draws. */
async function at(
  page: Page,
  east: number,
  north: number,
  heading: number,
  view: unknown,
): Promise<void> {
  await page.evaluate(
    async ({ east, north, heading, view }) => {
      const k = globalThis.keel;
      k.placeBoat(east, north, heading);
      k.render();
      k.camera(view as string);
      k.render();
      await k.show();
    },
    { east, north, heading, view },
  );
}

test.describe('the mist', () => {
  test('a boat 150 m off keeps its contrast short of the band and loses most of it at the lip', async ({
    page,
  }) => {
    await openScene(page);
    await still(page);
    // How much a boat 150 m ahead changes the picture: the most any pixel
    // moves. (From the deck the dome hides a boat 300 m off: the horizon is
    // 180 m away.)
    const seen = async (north: number): Promise<number> => {
      await at(page, 0, north, 0, 'chase');
      await page.evaluate(async () => {
        const k = globalThis.keel;
        k.setFleet(null);
        k.render();
        await k.show();
      });
      const without = await picture(page);
      await page.evaluate(async (north) => {
        const k = globalThis.keel;
        k.setFleet([{ east: 0, north: north + 150, heading: Math.PI / 2, sail: 0x5f }]);
        k.render();
        await k.show();
      }, north);
      const withBoat = await picture(page);
      await page.evaluate(() => globalThis.keel.setFleet(null));
      return largestDifference(without, withBoat);
    };
    const clear = await seen(BAND - 200);
    const misted = await seen(LIP - 154);
    expect(clear).toBeGreaterThan(40);
    expect(misted).toBeLessThan(0.3 * clear);
  });

  test('thickens toward the lip, and the sky overhead stays blue there', async ({ page }) => {
    await openScene(page);
    await still(page);
    expect(await page.evaluate(() => globalThis.keel.world.edge.lip)).toBe(LIP);
    // The sea toward the horizon, looking along the lip: plainer, nearer
    // the mist's grey, at the lip than short of the band.
    const lowerSpread = async (north: number): Promise<number> => {
      await at(page, 0, north, Math.PI / 2, 'chase');
      const p = await picture(page);
      const [r, g, b] = meanColour(p, Math.round(p.height * 0.27), Math.round(p.height * 0.34));
      // The sea is blue-green; the mist grey: their difference falls.
      return b - r + (g - r);
    };
    const short = await lowerSpread(BAND - 400);
    const lip = await lowerSpread(LIP - 20);
    expect(lip).toBeLessThan(0.5 * short);
    // Looking up from the lip: the sky is still blue.
    await page.evaluate(async () => {
      const k = globalThis.keel;
      k.dragCamera(0, -400);
      k.render();
      await k.show();
    });
    const up = await picture(page);
    const [r, , b] = meanColour(up, 0, Math.round(up.height * 0.25));
    expect(b - r).toBeGreaterThan(25);
  });
});

test.describe('the lip and the falls', () => {
  test('the sea stops at the lip and pours over it; with ?edge=off it does neither', async ({
    page,
  }) => {
    await openScene(page);
    await still(page);
    const view = { azimuth: 1.9, elevation: 0.35, distance: 50 };
    await at(page, 0, LIP - 10, Math.PI / 2, view);
    const on = await picture(page);
    const edge = await page.evaluate(() => globalThis.keel.edge());
    expect(edge.on).toBe(true);
    expect(edge.slabs).toBeGreaterThan(100);
    expect(edge.curtain).toBeGreaterThan(10_000);
    // Far from the lip, nothing of the falls is drawn.
    await at(page, 0, LIP - 800, Math.PI / 2, 'chase');
    const far = await page.evaluate(() => globalThis.keel.edge());
    expect(far.slabs).toBe(0);
    expect(far.curtain).toBe(0);

    await openScene(page, 'edge=off');
    await still(page);
    await at(page, 0, LIP - 10, Math.PI / 2, view);
    const off = await picture(page);
    const edgeOff = await page.evaluate(() => globalThis.keel.edge());
    expect(edgeOff.on).toBe(false);
    expect(edgeOff.slabs).toBe(0);
    expect(edgeOff.curtain).toBe(0);
    // Beyond the lip, sea with it off; mist and falls with it on.
    expect(pictureDifference(on, off)).toBeGreaterThan(5);
  });

  test('are drawn alike on two pages at one world time', async ({ browser }) => {
    const pictures: Picture[] = [];
    for (let i = 0; i < 2; i++) {
      const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
      await openScene(page);
      await still(page);
      await page.evaluate(() => globalThis.keel.freeze(1234.5));
      await at(page, 0, LIP - 6, Math.PI / 2, { azimuth: 2.6, elevation: 0.05, distance: 30 });
      pictures.push(await picture(page));
      await page.close();
    }
    const [a, b] = pictures as [Picture, Picture];
    expect(pictureDifference(a, b)).toBeLessThan(0.5);
  });
});

test.describe('going over', () => {
  test('falls, fades to the mist, and is back at the start with the autopilot off and the helm centred', async ({
    page,
  }) => {
    await openScene(page, '', true);
    await still(page);
    const start = await page.evaluate(() => {
      const k = globalThis.keel;
      k.reset();
      return k.boat();
    });
    await page.evaluate((lip) => {
      const k = globalThis.keel;
      k.placeBoat(lip - 1, 0, Math.PI / 2);
      k.setState({ surge: 3, sheetLimit: 0.6 });
      k.setControls(0.3, 0.4);
      k.game.engagePilot(1);
      k.render();
    }, LIP);
    // Sailed on until it goes over: within a second.
    const over = await page.evaluate(() => {
      const k = globalThis.keel;
      for (let i = 0; i < 30 && k.edge().over === 0; i++) {
        k.sailFrames(1, 1);
      }
      return k.edge();
    });
    expect(over.over).toBeGreaterThan(0);
    expect(over.notice).toBe('Over the falls');
    expect(over.held).toBe(true);
    // Into the third second it fades to the mist.
    const fading = await page.evaluate(() => {
      const k = globalThis.keel;
      k.sailFrames(40, 2);
      return k.edge();
    });
    expect(fading.fade).toBeGreaterThan(0.5);
    expect(fading.over).toBe(over.over);
    // Five seconds after going over: back at the start.
    const back = await page.evaluate(() => {
      const k = globalThis.keel;
      for (let i = 0; i < 60 && k.edge().restarts === 0; i++) {
        k.sailFrames(1, 2);
      }
      return { edge: k.edge(), boat: k.boat() };
    });
    expect(back.edge.restarts).toBe(1);
    expect(back.edge.over).toBe(0);
    expect(back.edge.notice).toBe('Back at Port Royal');
    expect(back.edge.held).toBe(false);
    expect(back.edge.pilot).toBe(false);
    expect(back.edge.helm).toBe(0);
    expect(
      Math.hypot(back.boat.state.x - start.state.x, back.boat.state.y - start.state.y),
    ).toBeLessThan(5);
  });

  test('with reduced motion the fade comes at once and the camera does not follow', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openScene(page);
    const over = await page.evaluate((lip) => {
      const k = globalThis.keel;
      k.placeBoat(lip - 0.3, 0, Math.PI / 2);
      k.setState({ surge: 3, sheetLimit: 0.6 });
      k.render();
      for (let i = 0; i < 30 && k.edge().over === 0; i++) {
        k.sailFrames(1, 1);
      }
      k.sailFrames(1, 1);
      return k.edge();
    }, LIP);
    expect(over.over).toBeGreaterThan(0);
    expect(over.fade).toBe(1);
    expect(over.held).toBe(false);
  });

  test('an approach survived is told in whole metres', async ({ page }) => {
    await openScene(page, '', true);
    const told = await page.evaluate(
      ({ lip, band }) => {
        const k = globalThis.keel;
        k.placeBoat(0, lip - 40, Math.PI);
        k.sailFrames(1, 1);
        k.placeBoat(0, band - 100, Math.PI);
        k.sailFrames(1, 1);
        return k.edge().notice;
      },
      { lip: LIP, band: BAND },
    );
    expect(told).toMatch(/^Closest to the edge: 4\d m$/);
  });
});

test.describe('pictures', () => {
  test('the lip and the falls @long', async ({ page }) => {
    await openScene(page, 'sea=breeze');
    const canvas = page.locator('canvas.scene');
    // From the deck, 30 m from the lip.
    await page.evaluate(async (lip) => {
      const k = globalThis.keel;
      k.setSky(12);
      k.placeBoat(0, lip - 30, 0);
      k.render();
      k.camera('aboard');
      await k.show();
    }, LIP);
    await expect.soft(canvas).toHaveScreenshot('edge-deck.png');
    // Out over the falls, looking back along them at the boat.
    await page.evaluate(async (lip) => {
      const k = globalThis.keel;
      k.placeBoat(0, lip - 8, Math.PI / 2);
      k.render();
      k.camera({ azimuth: 2.6, elevation: 0.05, distance: 30 });
      await k.show();
    }, LIP);
    await expect.soft(canvas).toHaveScreenshot('edge-falls.png');
    // At night.
    await page.evaluate(async () => {
      const k = globalThis.keel;
      k.setSky(23);
      await k.show();
    });
    await expect.soft(canvas).toHaveScreenshot('edge-falls-night.png');
  });

  test('the falls in a gale @long', async ({ page }) => {
    await openScene(page, 'sea=gale');
    const canvas = page.locator('canvas.scene');
    await page.evaluate(async (lip) => {
      const k = globalThis.keel;
      k.setSky(12);
      k.placeBoat(0, lip - 8, Math.PI / 2);
      k.render();
      k.camera({ azimuth: 0.6, elevation: 0.25, distance: 35 });
      await k.show();
    }, LIP);
    await expect.soft(canvas).toHaveScreenshot('edge-gale.png');
  });
});
