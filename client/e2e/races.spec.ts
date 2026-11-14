// SPDX-License-Identifier: AGPL-3.0-only

// Races ashore, against keel and its database, on phones held upright
// (360 × 640). A sailor makes a race from their own panel before the sea:
// Make a race, every choice filled in and a name suggested, Make it, and
// the share with the race's link. A stranger with no account opens the
// link, is told they can enter once they have a sailor, makes one, sees
// the race's card and enters; closing the card lands on their own Set
// sail, the link done with. Then the first sailor has made as many races
// as a day allows (the rest made and cancelled through the routes, to be
// quick), sets sail, and Make a race in the menu says so kindly, with
// when the next may be made. The pages draw nothing (?draw=off).

import { expect, test } from '@playwright/test';
import { answerBorn, GAME, holdPasskeys, sailor, setSail, stamp } from './helpers';

const PHONE = { width: 360, height: 640 };
const MINUTE = 60_000;

test('a race made on a phone, entered by its link from a private window; the ninth made in a day refused kindly', async ({
  browser,
  context,
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize(PHONE);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const them = await sailor(context, 'Racer');
  await holdPasskeys(context, them.passkey);
  await page.goto(GAME);
  const yours = page.locator('.your-sailor');
  await expect(yours).toContainText(them.name, { timeout: 90_000 });

  // Make a race: everything filled in, the name suggested; Make it.
  await yours.getByRole('button', { name: 'Make a race' }).click();
  const make = page.locator('[data-panel=make-race]');
  await expect(make.locator('#race-name')).not.toHaveValue('', { timeout: 30_000 });
  await make.getByRole('button', { name: 'Make it' }).click();
  const share = page.locator('[data-panel=race-share]');
  await expect(share).toBeVisible({ timeout: 30_000 });
  const link = (await share.locator('[data-readout=race-link]').textContent()) ?? '';
  const code = /[?&]r=([a-z2-7]{10})$/.exec(link)?.[1] ?? '';
  expect(code, link).not.toBe('');
  await share.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(share).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Set sail as ${them.name}` })).toBeVisible();

  // A stranger, no account, opens the link in a private window.
  const strangers = await browser.newContext({ viewport: PHONE });
  try {
    await strangers.credentials.install();
    const s = await strangers.newPage();
    const theirErrors: string[] = [];
    s.on('pageerror', (e) => theirErrors.push(e.message));
    await s.goto(`${GAME}&r=${code}`);
    await expect(s.locator('[data-readout=make-to-race]')).toHaveText(
      'Make a sailor, and you can enter the race.',
      { timeout: 90_000 },
    );
    const name = `Entrant ${stamp()}`;
    await s.getByLabel('Your sailor’s name').fill(name);
    await answerBorn(s);
    await s.getByRole('button', { name: 'Set sail' }).click();
    await s.getByRole('button', { name: 'I’ve written it down' }).click({ timeout: 60_000 });

    // The card, then Enter.
    const card = s.locator('[data-panel=race-card]');
    await expect(card).toHaveAttribute('data-code', code, { timeout: 30_000 });
    await expect(card.locator('[data-readout=race-start]')).toContainText('Starts in');
    await card.getByRole('button', { name: 'Enter', exact: true }).click();
    await expect(card.locator('[data-readout=race-entered]')).toContainText('You’re entered');
    await expect(card.locator('[data-readout=race-entrants]')).toContainText(name);
    await card.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(s.getByRole('button', { name: `Set sail as ${name}` })).toBeVisible();
    expect(new URL(s.url()).searchParams.get('r')).toBeNull();
    expect(theirErrors).toEqual([]);
  } finally {
    await strangers.close();
  }

  // As many races as a day allows: the rest made and cancelled.
  const board = await (await page.request.get('/api/races')).json();
  const boat: string = board.make.boat;
  const course: string =
    (board.make.courses as { id: string; boats: Record<string, number> }[]).find(
      (c) => c.boats[boat] !== undefined,
    )?.id ?? '';
  expect(course).not.toBe('');
  const now = Date.now();
  for (let i = 1; ; i++) {
    const made = await page.request.post('/api/race', {
      data: {
        kind: 'race',
        course,
        boat,
        at: now + (20 + 15 * i) * MINUTE,
        who: 'everyone',
        name: '',
      },
    });
    if (made.status() === 409) {
      expect((await made.json()).error).toBe('made');
      break;
    }
    expect(made.status(), await made.text()).toBe(201);
    const { code: seeded } = await made.json();
    const cancelled = await page.request.post(`/api/race/${seeded}/cancel`);
    expect(cancelled.status(), await cancelled.text()).toBe(200);
    expect(i).toBeLessThan(20);
  }

  // At sea, Make a race in the menu says so, and when.
  await setSail(page);
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.locator('.menu').getByRole('button', { name: 'Make a race' }).click();
  await expect(page.locator('[data-panel=make-race] [data-readout=race-refused]')).toContainText(
    'You’ve made as many races as a day allows. You can make the next after',
    { timeout: 30_000 },
  );
  expect(errors).toEqual([]);
});
