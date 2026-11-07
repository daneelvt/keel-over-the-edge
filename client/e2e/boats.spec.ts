// SPDX-License-Identifier: AGPL-3.0-only

// The player's boat chosen from the fleet and its look set, from their own
// panel before setting sail: another boat chosen is theirs for the voyage,
// a look saved is kept, a name the server refuses is said in words beside
// the field, and at sea away from a port the look is not changed.

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
