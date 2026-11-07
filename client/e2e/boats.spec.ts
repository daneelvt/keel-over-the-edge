// SPDX-License-Identifier: AGPL-3.0-only

// The player's boat chosen from the fleet and its look set, from their own
// panel before setting sail: another boat chosen is theirs for the voyage,
// a look saved is kept, a name the server refuses is said in words beside
// the field, and at sea away from a port the look is not changed. The tall
// ship, chosen the same way, sails with her yards braced.

import { expect, type Page, test } from '@playwright/test';
import data from '../src/catalog/catalog.gen.json' with { type: 'json' };
import { GAME, sailor, setSail } from './helpers';

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
