// SPDX-License-Identifier: AGPL-3.0-only

// The other boats drawn, on each back end: a boat of the fleet at a pose
// looks as the player's own boat looks at that pose, heeled, gybing,
// capsized, luffing, with the rudder hard over, its sailor a person's or a
// machine's; a keelboat of the fleet as the own keelboat, its jib and its
// reef, and a tall ship as the own tall ship, her yards braced and her
// topgallants furled; the fleet's 64 boats keep to their draw calls and
// triangles, and a mixed 64 of Jolly boats, keelboats and tall ships to
// theirs,
// their sailors, near and far, of every look, to at most 6; every fleet
// material is the factory's, with the bend; faded boats dither and none
// sorts; and a picture of a fleet at fixed poses, near and far models,
// matches its reference.

import { expect, type Page, test } from '@playwright/test';
import { openScene, picture, pictureDifference } from './helpers';

const DEG = Math.PI / 180;
/** How far apart the own boat's picture and a fleet boat's at one pose may be, 0 to 255 a channel. */
const LIKE = 0.25;

/** A pose: the own boat's state, and the sail's flattening and flows. */
interface Pose {
  name: string;
  state: Record<string, number>;
  wind?: number;
  /** A machine sailor's boat. */
  machine?: boolean;
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
  {
    name: 'a machine, upright',
    state: { ...rest, heading: 1.5708, boom: 0.6, sailor: -0.4 },
    machine: true,
  },
  {
    name: 'a machine, heeled',
    state: { ...rest, heading: 1.5708, heel: 20 * DEG, boom: 0.75, sailor: -0.9 },
    machine: true,
  },
];

/**
 * Draws the own boat at a pose, then the fleet's boat at the same pose and
 * place, the own boat hidden, and returns both pictures. The telltales and
 * pennant, which the fleet does not draw, are hidden on the own boat.
 */
async function both(page: Page, pose: Pose, kind = 0) {
  await page.evaluate((m) => globalThis.keel.machineAboard(m), pose.machine === true);
  const sail = await page.evaluate(
    ({ kind, ...p }) => {
      const k = globalThis.keel;
      k.setFleet(null);
      k.showOwnBoat(true);
      k.setWind(p.wind ?? 12, 0);
      k.setReef(Math.round(p.state.reef ?? 0));
      k.setState(p.state);
      k.advance(1);
      k.setState(p.state);
      // Its sailor seated afresh at the pose, as the fleet's is when met.
      k.settleSailor();
      k.render();
      k.camera('chase');
      const o = k.boat().out;
      const b = k.boat().state;
      const flat = Math.max(0, Math.min(15, Math.round(o.flattening * 15)));
      return {
        kind,
        jib: b.jib,
        reef: Math.round(b.reef),
        // The yards by their nodes' turns (yardsTurn): π/2 less the angle,
        // the port arm forward for a positive angle.
        yardsTurn: b.yards === 0 ? 0 : -Math.sign(b.yards) * (Math.PI / 2 - Math.abs(b.yards)),
        foreYardsTurn:
          b.foreYards === 0 ? 0 : -Math.sign(b.foreYards) * (Math.PI / 2 - Math.abs(b.foreYards)),
        sail: flat | (o.footFlow << 4) | (o.headFlow << 6),
        east: b.x,
        north: b.y,
        heading: b.heading,
        heel: b.heel,
        boom: b.boom,
        rudder: b.rudder,
        sailor: b.sailor,
        mode: b.sailorMode,
        machine: p.machine === true ? 1 : 0,
      };
    },
    { ...pose, kind },
  );
  await page.evaluate(() => globalThis.keel.hideSmallParts(true));
  const own = await picture(page);
  await page.evaluate(async (s) => {
    const k = globalThis.keel;
    k.showOwnBoat(false);
    k.setFleet([s]);
    // Its look loaded, if this is its first boat.
    k.render();
    await k.fleetLoaded();
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
  await page.evaluate(() => globalThis.keel.machineAboard(false));
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
  // Both sailors skinned and posed by the same clips; the own boat's cloth
  // on springs, the fleet's swaying, and each sailor's glances its own:
  // alike, not the same.
  for (const [name, d] of Object.entries(diffs)) {
    expect(d, name).toBeLessThan(LIKE);
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

test('a mixed 64, Jolly boats, keelboats and tall ships, keep to 32 draw calls and 320,000 triangles', async ({
  page,
}) => {
  await openScene(page);
  const budget = await page.evaluate(async () => {
    const k = globalThis.keel;
    const b = k.boat().state;
    const boats = [];
    for (let i = 0; i < 64; i++) {
      // The start line again: of every sixteen, three keelboats and a tall
      // ship, the keelboats' jibs drawing and every other one reefed, the
      // ships braced up, one with her topgallants in, the first near.
      const ship = i % 16 === 3;
      const keel = !ship && i % 4 === 3;
      const kind = ship ? 2 : keel ? 1 : 0;
      boats.push({
        kind,
        east: b.x - 70 + (i % 8) * 20,
        north: b.y + 20 + Math.floor(i / 8) * 20,
        heading: 1.5708,
        boom: 0.6,
        jib: kind > 0 ? 0.3 : 0,
        reef: (keel && i % 8 === 3) || (ship && i === 19) ? 1 : 0,
        yardsTurn: ship ? -0.9 : 0,
        foreYardsTurn: ship ? -0.9 : 0,
        sail: 15 | (1 << 4) | (1 << 6),
      });
    }
    k.setFleet(boats);
    k.render();
    // The keelboats' and the ships' kinds load as their first boats come into view.
    await k.fleetLoaded();
    k.render();
    return k.fleetBudget();
  });
  test.info().annotations.push({ type: 'measured', description: JSON.stringify(budget) });
  expect(budget.near + budget.far).toBe(64);
  expect(budget.near).toBeLessThanOrEqual(12);
  expect(budget.drawCalls).toBeLessThanOrEqual(32);
  expect(budget.triangles).toBeLessThanOrEqual(320_000);
});

test('a keelboat and a tall ship of the fleet look as the own ones do, the jib, the yards and the reefs', async ({
  page,
}) => {
  await openScene(page, 'boat=keelboat');
  const diffs: Record<string, number> = {};
  for (const pose of [
    {
      name: 'a keelboat close-hauled',
      state: { ...rest, heading: 1.5708, heel: 15 * DEG, boom: 0.15, jib: 0.2, sailor: -0.9 },
    },
    {
      name: 'a keelboat reefed, reaching',
      state: { ...rest, heading: 1.5708, heel: 10 * DEG, boom: 0.7, jib: 0.35, reef: 1 },
    },
  ]) {
    const { own, fleet } = await both(page, pose, 1);
    diffs[pose.name] = pictureDifference(own, fleet);
  }
  // The same page, its own boat a tall ship: the wind on her port beam, her
  // yards braced up and drawing; then running square before it, her
  // topgallants furled.
  await page.evaluate(() => globalThis.keel.useBoat('tall-ship'));
  for (const pose of [
    {
      name: 'a tall ship braced up',
      state: { ...rest, heading: 1.5708, heel: 4 * DEG, boom: 0.4, yards: 0.6, foreYards: 0.6 },
    },
    {
      name: 'a tall ship running, her topgallants in',
      state: { ...rest, heading: 3.1416, boom: 1.0, yards: 1.5, foreYards: 1.5, reef: 1 },
    },
  ]) {
    const { own, fleet } = await both(page, pose, 2);
    diffs[pose.name] = pictureDifference(own, fleet);
  }
  test.info().annotations.push({ type: 'measured', description: JSON.stringify(diffs) });
  for (const [name, d] of Object.entries(diffs)) {
    expect(d, name).toBeLessThan(LIKE);
  }
});

test('every sailor, near and far, person or machine, in at most 6 draws', async ({ page }) => {
  await openScene(page);
  const r = await page.evaluate(async () => {
    const k = globalThis.keel;
    const b = k.boat().state;
    const fleet = async (machine: (i: number) => number) => {
      const boats = [];
      for (let i = 0; i < 64; i++) {
        // A start line, the nearest rows within the near models' range.
        boats.push({
          east: b.x - 35 + (i % 8) * 10,
          north: b.y + 12 + Math.floor(i / 8) * 14,
          heading: 1.5708,
          boom: 0.6,
          sailor: -0.6,
          sail: 15 | (1 << 4) | (1 << 6),
          machine: machine(i),
        });
      }
      k.setFleet(boats);
      k.render();
      // Each look loaded as its first boat comes into view.
      await k.fleetLoaded();
      k.render();
      return k.fleetBudget();
    };
    return {
      none: await fleet(() => 0),
      half: await fleet((i) => i % 2),
      all: await fleet(() => 1),
    };
  });
  test.info().annotations.push({ type: 'measured', description: JSON.stringify(r) });
  expect([r.none.people, r.none.machines]).toEqual([64, 0]);
  expect([r.half.people, r.half.machines]).toEqual([32, 32]);
  expect([r.all.people, r.all.machines]).toEqual([0, 64]);
  for (const f of [r.none, r.half, r.all]) {
    // The near ones skinned in one draw, the far ones rigid in another,
    // whatever their looks.
    expect(f.near).toBe(12);
    expect(f.skinned).toBe(12);
    expect(f.sailorDraws).toBeLessThanOrEqual(6);
    expect(f.sailorDraws).toBe(2);
    expect(f.drawCalls).toBeLessThanOrEqual(22);
    // Twelve near sailors at the deck level, 3,000 triangles each.
    expect(f.triangles).toBeLessThanOrEqual(220_000);
  }
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
