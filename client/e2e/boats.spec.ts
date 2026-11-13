// SPDX-License-Identifier: AGPL-3.0-only

// The player's boat chosen from the fleet and its look set, from their own
// panel before setting sail: another boat chosen is theirs for the voyage,
// a look saved is kept, a name the server refuses is said in words beside
// the field, and at sea away from a port the look is not changed. The tall
// ship, chosen the same way, sails with her yards braced. The skiff, chosen
// the same way, has her crew set the gennaker as she bears away on the
// autopilot and take it in as she comes up, and keep it in once reefed.
// The beach cat, chosen the same way, flies a hull on a reach, capsizes
// luffed in a gust with her sheet held and is righted, pitchpoles borne
// away in a breeze with it held, and reefs.

import { expect, type Page, test } from '@playwright/test';
import data from '../src/catalog/catalog.gen.json' with { type: 'json' };
import { alone, GAME, heldRegime, sailor, setSail } from './helpers';

type FleetBoat = {
  id: string;
  kind: string;
  number: number;
  name: string;
  paint: string;
  cloth: string;
  atSea: boolean;
  yours: boolean;
};

async function fleet(page: Page): Promise<{ boat: string; boats: FleetBoat[] }> {
  const res = await page.request.get('/api/fleet');
  expect(res.status()).toBe(200);
  return (await res.json()) as { boat: string; boats: FleetBoat[] };
}

/** The account's kind of boat, by what it is rather than its id. */
const keelboat = data.boats.find((b) => b.fleet === 'account');
/** The account's ship of square sails. */
const ship = data.boats.find((b) => b.fleet === 'account' && b.physics.square.squareAfterArea > 0);
/** The account's boat with a downwind sail its crew sets. */
const skiff = data.boats.find((b) => b.fleet === 'account' && b.physics.downwind.downwindArea > 0);

/** The account's boat of two hulls. */
const cat = data.boats.find((b) => b.fleet === 'account' && b.physics.hulls.hullSpacing > 0);

/** The account's boat whose crew sit on a cockpit's bench. */
const yacht = data.boats.find(
  (b) => b.fleet === 'account' && b.stations.some((s) => s.pose === 'bench'),
);

/** keel's internal listener, as tools/e2e serves it: its developer commands. */
const internal = 'http://127.0.0.1:19090';

/**
 * Turns what the autopilot holds to an angle off the wind, degrees (positive
 * with the wind over starboard), as a player does on the keyboard: Q a degree
 * to port, E to starboard, ten with Shift.
 */
async function pilotTo(page: Page, degrees: number): Promise<void> {
  const held = () => page.evaluate(() => globalThis.keel.boat().pilot.degrees);
  for (let d = await held(), n = 0; d !== degrees && n < 40; d = await held(), n++) {
    const step = Math.abs(degrees - d) >= 10 ? 'Shift+' : '';
    await page.keyboard.press(`${step}${degrees > d ? 'q' : 'e'}`);
  }
  expect(await held()).toBe(degrees);
}

/** The boat's angle off the mean wind, degrees, positive with the wind over starboard. */
function angleOff(page: Page): Promise<number> {
  return page.evaluate(() => {
    const b = globalThis.keel.boat();
    const a = ((b.wind.meanFrom - b.state.heading) * 180) / Math.PI;
    return ((((a + 180) % 360) + 360) % 360) - 180;
  });
}

test('a boat chosen and its look set from the player’s own panel, then sailed', async ({
  context,
  page,
}) => {
  test.skip(keelboat === undefined, 'the catalog has no boat of the account’s');
  await sailor(context, 'Fleet');
  await page.goto(GAME);
  const readout = page.locator('.your-sailor [data-readout=boat]');
  await expect(readout).toBeVisible({ timeout: 90_000 });

  // Another boat: the account's, theirs for the next voyage.
  await page.getByRole('button', { name: 'Change boat', exact: true }).click();
  await page
    .locator('.change-boat-choice', { hasText: keelboat?.name ?? '' })
    .first()
    .click();
  await expect(readout).toContainText(keelboat?.name ?? '');
  let f = await fleet(page);
  const chosen = f.boats.find((b) => b.id === f.boat);
  expect(chosen?.kind).toBe(keelboat?.id);

  // Its look: a paint and a cloth, and a name.
  const paint = data.boatLooks.paints[3];
  const cloth = data.boatLooks.cloths[4];
  await page.getByRole('button', { name: 'Your boat', exact: true }).click();
  await page
    .getByRole('radiogroup', { name: 'Paint' })
    .getByRole('radio', { name: paint?.name ?? '' })
    .click();
  await page
    .getByRole('radiogroup', { name: 'Cloth' })
    .getByRole('radio', { name: cloth?.name ?? '' })
    .click();
  // A name the server refuses: its words beside the field, the chooser kept open.
  await page.getByLabel('Name').fill('1 Saltpeter');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#boat-look-problem')).toContainText('starting with a letter');
  await page.getByLabel('Name').fill('Saltpeter');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(readout).toContainText('«Saltpeter»');
  f = await fleet(page);
  expect(f.boats.find((b) => b.id === f.boat)).toMatchObject({
    kind: keelboat?.id,
    paint: paint?.id,
    cloth: cloth?.id,
    name: 'Saltpeter',
  });

  // Sailed in it; away from a port its look is not changed.
  await setSail(page);
  await page.waitForFunction(() => globalThis.keel?.net().status === 'sailing', null, {
    timeout: 60_000,
  });
  await expect.poll(async () => (await fleet(page)).boats.find((b) => b.yours)?.atSea).toBe(true);
  const res = await page.request.post('/api/boat/look', {
    data: { boat: f.boat, paint: data.boatLooks.paints[0]?.id },
  });
  expect(res.status()).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('port');
});

test('the tall ship chosen from the fleet and sailed, her yards braced', async ({
  context,
  page,
}) => {
  test.skip(ship === undefined, 'the catalog has no ship of square sails');
  await sailor(context, 'Ship');
  await page.goto(GAME);
  const readout = page.locator('.your-sailor [data-readout=boat]');
  await expect(readout).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Change boat', exact: true }).click();
  const choice = page.locator('.change-boat-choice', { hasText: ship?.name ?? '' }).first();
  await expect(choice).toContainText('available');
  await choice.click();
  await expect(readout).toContainText(ship?.name ?? '');
  expect((await fleet(page)).boats.find((b) => b.yours)?.kind).toBe(ship?.id);

  await setSail(page);
  await page.waitForFunction(() => globalThis.keel?.net().status === 'sailing', null, {
    timeout: 60_000,
  });
  await expect.poll(async () => (await fleet(page)).boats.find((b) => b.yours)?.atSea).toBe(true);
  // Her yards, as the server sends them and the page predicts: braced, no
  // nearer the centreline than braced up sharp.
  const sharp = ((ship?.physics.square.braceSharp ?? 0) * Math.PI) / 180;
  await expect
    .poll(() => page.evaluate(() => Math.abs(globalThis.keel.boat().state.yards)), {
      timeout: 30_000,
    })
    .toBeGreaterThanOrEqual(sharp - 1e-6);
});

test('the skiff chosen from the fleet: her crew sets the gennaker bearing away, takes it in coming up, and keeps it in reefed', {
  tag: '@world',
}, async ({ context, page, request }) => {
  test.skip(skiff === undefined, 'the catalog has no boat with a downwind sail');
  const set = skiff?.physics.downwind.setAngle ?? 0;
  const drop = skiff?.physics.downwind.dropAngle ?? 0;
  await sailor(context, 'Skiff');
  await page.goto(GAME);
  const readout = page.locator('.your-sailor [data-readout=boat]');
  await expect(readout).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Change boat', exact: true }).click();
  const choice = page.locator('.change-boat-choice', { hasText: skiff?.name ?? '' }).first();
  await expect(choice).toContainText('available');
  await choice.click();
  await expect(readout).toContainText(skiff?.name ?? '');
  expect((await fleet(page)).boats.find((b) => b.yours)?.kind).toBe(skiff?.id);

  await setSail(page);
  await page.waitForFunction(() => globalThis.keel?.net().status === 'sailing', null, {
    timeout: 60_000,
  });
  // A steady breeze from the north, whatever the world's weather is at
  // this hour: the crew's angles are off the true wind.
  expect((await request.post(`${internal}/debug/wind?knots=10&from=0`)).status()).toBe(204);
  try {
    await page.waitForFunction(() => Math.cos(globalThis.keel.boat().wind.meanFrom) > 0.99, null, {
      timeout: 10_000,
    });
    // In clean air, at rest on a beam reach with the wind over starboard;
    // the autopilot on at that angle, and way gathered.
    await alone(page, 90);
    await page.keyboard.press('p');
    await expect.poll(() => page.evaluate(() => globalThis.keel.boat().pilot.mode)).toBe(1);
    await page.waitForFunction(() => globalThis.keel.boat().out.speedOverGround > 1.5, null, {
      timeout: 20_000,
    });
    const reef = page.locator('[data-readout=reef]');
    const hoist = () => page.evaluate(() => globalThis.keel.boat().state.hoist);

    // Bearing away onto a broad reach: the crew sets the gennaker.
    await pilotTo(page, set + 45);
    await expect(reef).toHaveText('Gennaker set', { timeout: 30_000 });
    expect(await hoist()).toBe(1);
    expect(await angleOff(page)).toBeGreaterThanOrEqual(set);

    // Coming up onto a close reach: they take it in.
    await pilotTo(page, drop - 20);
    await expect(reef).toHaveText('Gennaker coming in', { timeout: 20_000 });
    await expect.poll(hoist, { timeout: 20_000 }).toBe(0);
    await expect(reef).toHaveCount(0);

    // One reef, as the Reef key says it: the gennaker kept in its bag,
    // bearing away again.
    await page.getByRole('button', { name: /^Reef: / }).click();
    const key = page.locator('[data-control=reef] .reef-level').first();
    await expect(key).toHaveText(skiff?.controls.reef[1] ?? '');
    await pilotTo(page, set + 45);
    await expect.poll(() => angleOff(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(set);
    await expect(reef).toHaveText(skiff?.controls.reef[1] ?? '', { timeout: 30_000 });
    // Still sailing, her sailor aboard: a capsize would bag it too.
    const s = await page.evaluate(() => globalThis.keel.boat().state);
    expect([s.hoist, s.hoistTarget, s.sailorMode]).toEqual([0, 0, 0]);
    expect(await angleOff(page)).toBeGreaterThanOrEqual(set);
  } finally {
    // Back to the breeze tools/e2e holds.
    await request.post(`${internal}/debug/weather?regime=${heldRegime()}`);
  }
});

test('the beach cat chosen from the fleet: she flies a hull on a reach, capsizes luffed in a gust and is righted, pitchpoles borne away in a breeze, and reefs', {
  tag: '@world',
}, async ({ context, page, request }) => {
  test.skip(cat === undefined, 'the catalog has no boat of two hulls');
  test.setTimeout(240_000);
  await sailor(context, 'Cat');
  await page.goto(GAME);
  const readout = page.locator('.your-sailor [data-readout=boat]');
  await expect(readout).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Change boat', exact: true }).click();
  const choice = page.locator('.change-boat-choice', { hasText: cat?.name ?? '' }).first();
  await expect(choice).toContainText('available');
  await choice.click();
  await expect(readout).toContainText(cat?.name ?? '');
  expect((await fleet(page)).boats.find((b) => b.yours)?.kind).toBe(cat?.id);

  await setSail(page);
  await page.waitForFunction(() => globalThis.keel?.net().status === 'sailing', null, {
    timeout: 60_000,
  });
  /** The sheet held down (W hauls in, S eases) for so long, s: its whole range in 2. */
  const sheet = async (key: 'KeyW' | 'KeyS', seconds: number) => {
    await page.keyboard.down(key);
    await page.waitForTimeout(seconds * 1000);
    await page.keyboard.up(key);
  };
  const state = () => page.evaluate(() => globalThis.keel.boat().state);
  const wind = async (knots: number) =>
    expect((await request.post(`${internal}/debug/wind?knots=${knots}&from=0`)).status()).toBe(204);
  try {
    await wind(16);
    await page.waitForFunction(() => Math.cos(globalThis.keel.boat().wind.meanFrom) > 0.99, null, {
      timeout: 10_000,
    });
    // At rest on a beam reach in clean air, the autopilot on there and the
    // sheet half out: way gathered, her windward hull clear of the water.
    await alone(page, 90);
    await page.keyboard.press('p');
    await expect.poll(() => page.evaluate(() => globalThis.keel.boat().pilot.mode)).toBe(1);
    await sheet('KeyW', 2.2);
    await sheet('KeyS', 0.7);
    await page.waitForFunction(() => globalThis.keel.boat().out.hullFlying > 0, null, {
      timeout: 40_000,
    });
    // Luffed hard in a gust, the sheet hauled in and held: over onto her side.
    await wind(30);
    await sheet('KeyW', 2.2);
    await pilotTo(page, 60);
    await expect.poll(async () => (await state()).sailorMode, { timeout: 40_000 }).not.toBe(0);
    expect(Math.abs((await state()).heel)).toBeGreaterThan(1);
    // Let fly in a lighter wind: her sailor rights her from her lower hull and climbs back.
    await wind(12);
    await sheet('KeyS', 2.2);
    await expect.poll(async () => (await state()).sailorMode, { timeout: 90_000 }).toBe(0);
    expect(Math.abs((await state()).heel)).toBeLessThan(0.5);
    // A broad reach in a breeze, the sheet at its best; a gust and borne
    // away, the sheet held: her bows bury and her sailor goes over them.
    await wind(20);
    // At rest on it in clean air, with the wind over starboard again
    // (righted, she may have come up on the other tack), the autopilot on
    // afresh there.
    if ((await page.evaluate(() => globalThis.keel.boat().pilot.mode)) === 1) {
      await page.keyboard.press('p');
      await expect.poll(() => page.evaluate(() => globalThis.keel.boat().pilot.mode)).toBe(0);
    }
    await alone(page, 135);
    await page.keyboard.press('p');
    await expect.poll(() => page.evaluate(() => globalThis.keel.boat().pilot.mode)).toBe(1);
    await pilotTo(page, 135);
    await sheet('KeyW', 0.6);
    await page.waitForFunction(() => globalThis.keel.boat().out.speedOverGround > 4, null, {
      timeout: 40_000,
    });
    await wind(30);
    await pilotTo(page, 155);
    await page.waitForFunction(
      () => {
        const b = globalThis.keel.boat();
        return b.state.sailorMode !== 0 && Math.abs(b.state.heel) < 0.9;
      },
      null,
      { timeout: 40_000, polling: 50 },
    );
    // One reef, as the Reef key says it, while her sailor swims back to her.
    await wind(12);
    await page.getByRole('button', { name: /^Reef: / }).click();
    await expect(page.locator('[data-control=reef] .reef-level').first()).toHaveText(
      cat?.controls.reef[1] ?? '',
    );
  } finally {
    // Back to the breeze tools/e2e holds.
    await request.post(`${internal}/debug/weather?regime=${heldRegime()}`);
  }
});

test('the yacht chosen from the fleet: she beats in a breeze, tacks, reaches past 7.6 knots, rounds up in a gust with her sheet held, and reefs', {
  tag: '@world',
}, async ({ context, page, request }) => {
  test.skip(yacht === undefined, 'the catalog has no boat with a bench');
  test.setTimeout(240_000);
  await sailor(context, 'Cruiser');
  await page.goto(GAME);
  const readout = page.locator('.your-sailor [data-readout=boat]');
  await expect(readout).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Change boat', exact: true }).click();
  const choice = page.locator('.change-boat-choice', { hasText: yacht?.name ?? '' }).first();
  await expect(choice).toContainText('available');
  await choice.click();
  await expect(readout).toContainText(yacht?.name ?? '');
  expect((await fleet(page)).boats.find((b) => b.yours)?.kind).toBe(yacht?.id);

  await setSail(page);
  await page.waitForFunction(() => globalThis.keel?.net().status === 'sailing', null, {
    timeout: 60_000,
  });
  /** The sheet held down (W hauls in, S eases) for so long, s: its whole range in 2. */
  const sheet = async (key: 'KeyW' | 'KeyS', seconds: number) => {
    await page.keyboard.down(key);
    await page.waitForTimeout(seconds * 1000);
    await page.keyboard.up(key);
  };
  const state = () => page.evaluate(() => globalThis.keel.boat().state);
  const knots = (k: number) => k * 0.5144;
  const wind = async (knots: number) =>
    expect((await request.post(`${internal}/debug/wind?knots=${knots}&from=0`)).status()).toBe(204);
  try {
    await wind(14);
    await page.waitForFunction(() => Math.cos(globalThis.keel.boat().wind.meanFrom) > 0.99, null, {
      timeout: 10_000,
    });
    // Way gathered on a close reach in clean air, the autopilot on there;
    // then close-hauled, the sheet in, making her way to windward.
    await alone(page, 70);
    await page.keyboard.press('p');
    await expect.poll(() => page.evaluate(() => globalThis.keel.boat().pilot.mode)).toBe(1);
    await sheet('KeyW', 2.2);
    await sheet('KeyS', 0.4);
    await page.waitForFunction((v) => globalThis.keel.boat().out.speedOverGround > v, knots(4), {
      timeout: 60_000,
    });
    await pilotTo(page, 50);
    await sheet('KeyW', 0.5);
    await page.waitForFunction((v) => globalThis.keel.boat().out.speedOverGround > v, knots(5), {
      timeout: 60_000,
    });
    // A tack: round onto the other tack, the wind over the other side.
    const before = Math.sign(await angleOff(page));
    await page.keyboard.press('t');
    await expect
      .poll(async () => Math.sign(await angleOff(page)), { timeout: 60_000 })
      .toBe(-before);
    // A beam reach in a breeze, the sheet eased: past 7.6 knots.
    await wind(16);
    await pilotTo(page, -before * 90);
    await sheet('KeyS', 0.8);
    await page.waitForFunction((v) => globalThis.keel.boat().out.speedOverGround > v, knots(7.6), {
      timeout: 90_000,
    });
    // Held there in a gust, the sheet hauled in and held: she heels and
    // rounds up toward the wind, and comes back.
    await page.keyboard.press('p');
    await expect.poll(() => page.evaluate(() => globalThis.keel.boat().pilot.mode)).toBe(0);
    const off = Math.abs(await angleOff(page));
    await wind(35);
    await sheet('KeyW', 2.2);
    await expect
      .poll(async () => Math.abs((await state()).heel), { timeout: 40_000 })
      .toBeGreaterThan(0.35);
    await expect
      .poll(async () => Math.abs(await angleOff(page)), { timeout: 40_000 })
      .toBeLessThan(off - 20);
    // One reef, as the Reef key says it.
    await wind(14);
    await sheet('KeyS', 2.2);
    await page.getByRole('button', { name: /^Reef: / }).click();
    await expect(page.locator('[data-control=reef] .reef-level').first()).toHaveText(
      yacht?.controls.reef[1] ?? '',
    );
    expect((await state()).sailorMode).toBe(0);
  } finally {
    // Back to the breeze tools/e2e holds.
    await request.post(`${internal}/debug/weather?regime=${heldRegime()}`);
  }
});
