// SPDX-License-Identifier: AGPL-3.0-only

// The other boats drawn, on each back end: a boat of the fleet at a pose
// looks as the player's own boat looks at that pose, heeled, gybing,
// capsized, luffing, with the rudder hard over; the fleet's 64 boats keep
// to their draw calls and triangles; every fleet material is the factory's,
// with the bend; faded boats dither and none sorts; and a picture of a
// fleet at fixed poses, near and far models, matches its reference.

import { expect, type Page, test } from '@playwright/test';
import { openScene, picture, pictureDifference } from './helpers';

const DEG = Math.PI / 180;

/** A pose: the own boat's state, and the sail's flattening and flows. */
interface Pose {
  name: string;
  state: Record<string, number>;
  wind?: number;
}

/** A whole pose: every field the poses set, at rest. */
const rest = {
  heel: 0,
  boom: 0,
  rudder: 0,
  sailor: 0,
  sailorMode: 0,
  sailorTimer: 0,
  surge: 0,
  sheetLimit: 1.2,
};

const poses: Pose[] = [
  { name: 'upright', state: { ...rest, heading: 1.5708, boom: 0.6, sailor: -0.4 } },
  { name: 'heeled', state: { ...rest, heading: 1.5708, heel: 20 * DEG, boom: 0.75, sailor: -0.9 } },
  {
    name: 'gybing',
    state: { ...rest, heading: 3.1, heel: -5 * DEG, boom: -0.1, sailor: 0.3, rudder: 0.2 },
  },
  {
    name: 'capsized',
    state: { ...rest, heading: 1.5708, heel: 88 * DEG, boom: 1.1, sailorMode: 1, sailorTimer: 4 },
  },
  { name: 'luffing', state: { ...rest, heading: 0.2, boom: 0.05, sailor: 0.1 } },
  {
    name: 'rudder over',
    state: { ...rest, heading: -2, heel: -8 * DEG, boom: -0.8, sailor: 0.7, rudder: -0.6 },
  },
  {
    name: 'on the board',
    state: { ...rest, heading: 2.4, heel: 70 * DEG, boom: 0.9, sailorMode: 2, sailorTimer: 4 },
  },
];

/**
 * Draws the own boat at a pose, then the fleet's boat at the same pose and
 * place, the own boat hidden, and returns both pictures. The telltales and
 * pennant, which the fleet does not draw, are hidden on the own boat.
 */
async function both(page: Page, pose: Pose) {
  const sail = await page.evaluate((p) => {
    const k = globalThis.keel;
    k.setFleet(null);
    k.showOwnBoat(true);
    k.setWind(p.wind ?? 12, 0);
    k.setState(p.state);
    k.advance(1);
    k.setState(p.state);
    k.render();
    k.camera('chase');
    const o = k.boat().out;
    const b = k.boat().state;
    const flat = Math.max(0, Math.min(15, Math.round(o.flattening * 15)));
    return {
      sail: flat | (o.footFlow << 4) | (o.headFlow << 6),
      east: b.x,
      north: b.y,
      heading: b.heading,
      heel: b.heel,
      boom: b.boom,
      rudder: b.rudder,
      sailor: b.sailor,
      mode: b.sailorMode,
    };
  }, pose);
  await page.evaluate(() => globalThis.keel.hideSmallParts(true));
  const own = await picture(page);
  await page.evaluate((s) => {
    const k = globalThis.keel;
    k.showOwnBoat(false);
    k.setFleet([s]);
    // The camera where it was for the own boat's picture: it eases between
    // frames drawn on real time.
    k.camera('chase');
    k.render();
  }, sail);
  const fleet = await picture(page);
  await page.evaluate(() => {
    const k = globalThis.keel;
    k.setFleet(null);
    k.showOwnBoat(true);
    k.hideSmallParts(false);
  });
  return { own, fleet };
}

test('a boat of the fleet looks as the own boat does at the same pose', async ({ page }) => {
  await openScene(page);
  const diffs: Record<string, number> = {};
  for (const pose of poses) {
    const { own, fleet } = await both(page, pose);
    diffs[pose.name] = pictureDifference(own, fleet);
  }
  test.info().annotations.push({ type: 'measured', description: JSON.stringify(diffs) });
  for (const [name, d] of Object.entries(diffs)) {
    expect(d, name).toBeLessThan(0.25);
  }
});

test('64 boats keep to 22 draw calls and 200,000 triangles', async ({ page }) => {
  await openScene(page);
  const budget = await page.evaluate(() => {
    const k = globalThis.keel;
    const b = k.boat().state;
    const boats = [];
    for (let i = 0; i < 64; i++) {
      // A start line: 8 rows of 8, 20 m apart, around the camera.
      boats.push({
        east: b.x - 70 + (i % 8) * 20,
        north: b.y + 20 + Math.floor(i / 8) * 20,
        heading: 1.5708,
        boom: 0.6,
        sail: 15 | (1 << 4) | (1 << 6),
      });
    }
    k.setFleet(boats);
    k.render();
    return k.fleetBudget();
  });
  expect(budget.near + budget.far).toBe(64);
  expect(budget.near).toBeLessThanOrEqual(12);
  expect(budget.drawCalls).toBeLessThanOrEqual(22);
  expect(budget.triangles).toBeLessThanOrEqual(200_000);
  test.info().annotations.push({ type: 'measured', description: JSON.stringify(budget) });
});

test('every fleet material is the factory’s, with the bend, and dithers', async ({ page }) => {
  await openScene(page);
  const problems = await page.evaluate(() => {
    const k = globalThis.keel;
    const b = k.boat().state;
    k.setFleet([
      { east: b.x + 10, north: b.y + 10, opacity: 0.5 },
      { east: b.x + 200, north: b.y + 10, opacity: 0.25 },
    ]);
    k.render();
    return [...k.checkScene(), ...k.fleetMaterials()];
  });
  expect(problems).toEqual([]);
});

test.describe('pictures', () => {
  test('a fleet at fixed poses, near and far', async ({ page }) => {
    await openScene(page);
    await page.evaluate(async () => {
      const k = globalThis.keel;
      k.setWind(12, 0);
      const b = k.boat().state;
      // Ahead of the own boat, which heads east, and to either side.
      const at = (side: number, ahead: number) => ({ east: b.x + ahead, north: b.y - side });
      const drawing = 15 | (1 << 4) | (1 << 6);
      k.setFleet([
        { ...at(-14, 26), heading: 1.5708, heel: 0.35, boom: 0.75, sailor: -0.9, sail: drawing },
        {
          ...at(10, 30),
          heading: -1.2,
          heel: -0.1,
          boom: -0.9,
          rudder: 0.5,
          sailor: 0.5,
          sail: drawing,
        },
        { ...at(-6, 48), heading: 0.1, boom: 0.02, sail: 15 },
        { ...at(22, 55), heading: 1.5708, heel: 1.53, boom: 1.1, mode: 1, sail: drawing },
        {
          ...at(-30, 60),
          heading: 2.8,
          heel: 0.05,
          boom: 0.3,
          rudder: -0.6,
          sail: drawing,
          opacity: 0.5,
        },
        { ...at(-40, 140), heading: 1.2, heel: 0.2, boom: 0.6, sailor: -0.7, sail: drawing },
        { ...at(60, 180), heading: -0.6, heel: -0.15, boom: -0.4, sailor: 0.6, sail: drawing },
        { ...at(0, 260), heading: 3.0, boom: 1.3, sail: drawing },
      ]);
      k.render();
      k.camera('chase');
      await k.show();
    });
    await expect(page.locator('canvas.scene')).toHaveScreenshot('fleet.png');
  });
});
