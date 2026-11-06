// SPDX-License-Identifier: AGPL-3.0-only

// A sailor's look, chosen: a new player picks one on the first form and
// sails as it, and another page sees their boat in it; the player changes
// it ashore from their own panel, and at sea away from Port Royal it is
// refused; a sailor made before looks were chosen is asked once.

import { expect, type Page, test } from '@playwright/test';
import data from '../src/catalog/catalog.gen.json' with { type: 'json' };
import { GAME, sail, sailor, setSail, stamp } from './helpers';

/** A look's code, as the wire carries it: five fields of 4 bits. */
function codeOf(l: { look: string; version: string; skin: string; hair: string; colour: string }) {
  const i = data.sailors.findIndex((s) => s.id === l.look);
  const s = data.sailors[i];
  if (s === undefined) {
    throw new Error(`no look ${l.look}`);
  }
  const o = data.sailorOptions;
  const hairs = s.hair === 'greys' ? o.greys : o.hairs;
  return (
    i +
    s.versions.findIndex((v) => v.id === l.version) * 16 +
    o.skins.findIndex((x) => x.id === l.skin) * 256 +
    hairs.findIndex((x) => x.id === l.hair) * 4096 +
    o.colours.findIndex((x) => x.id === l.colour) * 65536
  );
}

type Me = {
  look: string;
  version: string;
  skin: string;
  hair: string;
  colour: string;
  lookChosen: boolean;
};

async function me(page: Page): Promise<Me> {
  const res = await page.request.get('/api/me');
  expect(res.status()).toBe(200);
  return (await res.json()) as Me;
}

/** The picker's choice in a group, by the option's name. */
async function pick(page: Page, group: string, option: string): Promise<void> {
  await page.getByRole('radiogroup', { name: group }).getByRole('radio', { name: option }).click();
}

test('a new sailor chooses a look in the picker, sails as it, and another page sees it', async ({
  context,
  page,
  browser,
}) => {
  await context.credentials.install();
  await page.goto(GAME);
  const name = `Picker ${stamp()}`;
  await page.getByLabel('Your sailor’s name').fill(name);
  // Through the looks to the fourth look's second version, and its options.
  const look = data.sailors[3];
  if (look === undefined) {
    throw new Error('too few looks');
  }
  const place = page.locator('.picker-place');
  for (let i = 0; i < 18 && !(await place.textContent())?.endsWith(' 8 of 18'); i++) {
    await page.getByRole('button', { name: 'Next look' }).click();
  }
  await expect(page.locator('.picker-look-name')).toHaveText(look.name);
  const skin = data.sailorOptions.skins[4];
  const hair = data.sailorOptions.hairs[3];
  const colour = data.sailorOptions.colours[6];
  await pick(page, 'Skin', skin?.name ?? '');
  await pick(page, 'Hair', hair?.name ?? '');
  await pick(page, 'Main colour', colour?.name ?? '');
  const words = `${look.name}, ${look.versions[1]?.name}, ${colour?.name}, ${skin?.name}, ${hair?.name}`;
  await expect(page.locator('.picker-words')).toHaveText(words);
  await expect(page.getByRole('img', { name: words })).toBeVisible();
  // Shuffle draws another; Undo takes it back.
  await page.getByRole('button', { name: 'Shuffle' }).click();
  await expect(page.locator('.picker-words')).not.toHaveText(words);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.picker-words')).toHaveText(words);

  await page.getByRole('button', { name: 'Set sail' }).click();
  await page.getByRole('button', { name: 'I’ve written it down' }).click({ timeout: 30_000 });
  const chosen = {
    look: look.id,
    version: look.versions[1]?.id ?? '',
    skin: skin?.id ?? '',
    hair: hair?.id ?? '',
    colour: colour?.id ?? '',
  };
  expect(await me(page)).toMatchObject({ ...chosen, lookChosen: true });
  await setSail(page);
  await page.waitForFunction(() => globalThis.keel?.net().status === 'sailing', null, {
    timeout: 60_000,
  });
  expect(await page.evaluate(() => globalThis.keel.net().look)).toBe(codeOf(chosen));

  // Another sailor's page sees the boat in that look.
  const other = await browser.newContext();
  await sailor(other, 'Seer');
  const second = await other.newPage();
  await sail(second);
  await expect
    .poll(
      () =>
        second.evaluate(() => globalThis.keel.fleet().boats.map((b: { look: number }) => b.look)),
      { timeout: 60_000 },
    )
    .toContain(codeOf(chosen));
  await other.close();

  // At sea, away from Port Royal: refused, the look kept.
  const res = await page.request.post('/api/sailor/look', {
    data: { ...chosen, colour: data.sailorOptions.colours[0]?.id },
  });
  expect(res.status()).toBe(409);
  expect(await me(page)).toMatchObject(chosen);
});

test('a look changed ashore from the player’s own panel', async ({ context, page }) => {
  await context.credentials.install();
  await page.goto(GAME);
  await page.getByLabel('Your sailor’s name').fill(`Ashore ${stamp()}`);
  await page.getByRole('button', { name: 'Set sail' }).click();
  await page.getByRole('button', { name: 'I’ve written it down' }).click({ timeout: 30_000 });
  await page.goto(GAME);
  await page.getByRole('button', { name: 'Change your look' }).click({ timeout: 90_000 });
  await expect(page.getByRole('heading', { name: 'Change your look' })).toBeVisible();
  const colour = data.sailorOptions.colours[5];
  await pick(page, 'Main colour', colour?.name ?? '');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Change your look' })).toBeVisible();
  expect((await me(page)).colour).toBe(colour?.id);
  // Its portrait beside the name says the look kept.
  await expect(page.locator('.your-sailor .portrait')).toHaveAttribute(
    'aria-label',
    new RegExp(`, ${colour?.name}, `),
  );
});

test('a sailor whose look the game drew is asked once: Keep keeps it', async ({
  context,
  page,
}) => {
  await context.credentials.install();
  await page.goto(GAME);
  await page.getByLabel('Your sailor’s name').fill(`Drawn ${stamp()}`);
  await page.getByRole('button', { name: 'Set sail' }).click();
  await page.getByRole('button', { name: 'I’ve written it down' }).click({ timeout: 30_000 });
  const kept = await me(page);
  // As the server answers for a sailor made before looks were chosen.
  await page.route('**/api/me', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), lookChosen: false } });
  });
  await page.goto(GAME);
  await expect(page.getByRole('heading', { name: 'Choose your look' })).toBeVisible({
    timeout: 90_000,
  });
  const keep = page.waitForRequest((r) => r.url().endsWith('/api/sailor/look'));
  await page.getByRole('button', { name: 'Keep' }).click();
  const sent = (await keep).postDataJSON() as Me;
  expect(sent).toEqual({
    look: kept.look,
    version: kept.version,
    skin: kept.skin,
    hair: kept.hair,
    colour: kept.colour,
  });
  await expect(page.getByRole('button', { name: /^Set sail as/ })).toBeVisible();
  await page.unroute('**/api/me');
});

test('the first form keeps Set sail in view on a phone, upright and sideways', async ({ page }) => {
  for (const viewport of [
    { width: 360, height: 640 },
    { width: 640, height: 360 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(GAME);
    const go = page.getByRole('button', { name: 'Set sail' });
    await expect(go).toBeVisible({ timeout: 90_000 });
    const box = await go.boundingBox();
    expect(box).not.toBeNull();
    if (box !== null) {
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    }
    // Every swatch is on the screen's width.
    for (const radio of await page.getByRole('radio').all()) {
      const b = await radio.boundingBox();
      expect((b?.x ?? 0) + (b?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
    }
  }
});
