// SPDX-License-Identifier: AGPL-3.0-only

// Watching a race on the spectator's screen, in a real browser, on the
// offline sandbox, the server's race messages and switches stood in for
// by the page's test hooks: the race bar takes the watch plate's place at
// the foot, the racer's line is gone, nothing steers; ‹ and › move the
// watch to the boat behind and ahead, the name opens the standings and a
// row tapped is watched; the cheer key cheers once, the bunting bursts
// and the crowd is heard, then it waits; the crowd's count comes back as
// a line; the crier says what happens; ⋯ turns follow the action on.

import { expect, type Page, test } from '@playwright/test';
import { openScene } from './helpers';

/** A race of six told and pictured about the sandbox's boat, none of them the page's, the third watched. */
async function watchRace(page: Page): Promise<void> {
  await page.evaluate(() => {
    const k = globalThis.keel;
    k.setSky(12);
    k.raceTell({
      start: 1,
      entrants: ['Saltwind', 'Iron Mary', 'Grey Gull', 'Pip', 'Old Tom', 'Tern'].map((name, i) => ({
        number: i + 1,
        name,
        boat: name,
        machine: name === 'Iron Mary',
        me: false,
      })),
    });
    const p = k.world.pose;
    k.racePicture(
      [0, 1, 2, 3, 4, 5].map((i) => ({
        place: i + 1,
        gap: 9 * i,
        leg: 1,
        east: p.east + 12 * (i - 2),
        north: p.north - 20 * (i - 2),
      })),
      1,
      3,
    );
    k.raceWatching(3);
  });
}

test('a race watched: the bar, ‹ ›, the standings, cheers, the crier, follow the action', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await openScene(page, 'world=1', true);
  await watchRace(page);
  const bar = page.locator('[data-readout=race-bar]');
  await expect(bar).toBeVisible();
  await expect(page.locator('[data-readout=race-line]')).toHaveCount(0);
  await expect(page.locator('.helm')).toHaveCount(0);
  await expect(bar.locator('[data-readout=race-bar-place]')).toHaveText('3rd');
  await expect(bar.locator('[data-readout=race-bar-name]')).toHaveText('Grey Gull');
  await expect(bar.locator('[data-readout=race-bar-over]')).toHaveText(
    'Leg 1/4 · +0:18 · The Noon Gun',
  );

  // › the boat behind, ‹ the boat ahead: one switch a second.
  await bar.getByRole('button', { name: 'The boat behind' }).click();
  await expect(bar).toHaveAttribute('data-watched', '4');
  await expect(bar.locator('[data-readout=race-bar-name]')).toHaveText('Pip');
  await bar.getByRole('button', { name: 'The boat ahead' }).click();
  await expect(bar).toHaveAttribute('data-watched', '3');

  // The standings from the name, a row tapped watched.
  await bar.getByRole('button', { name: 'Standings', exact: true }).click();
  const sheet = page.locator('[data-panel=race-standings]');
  await expect(sheet.locator('.rb-row')).toHaveCount(6);
  await expect(sheet.locator('.rb-row.rb-watched')).toHaveAttribute('data-number', '3');
  await sheet.locator('.rb-row[data-number="2"]').click();
  await expect(sheet).toHaveCount(0);
  await expect(bar).toHaveAttribute('data-watched', '2');
  await expect(bar.locator('.rb-cog')).toBeVisible();
  // Watched once the server's second has passed.
  await expect.poll(() => page.evaluate(() => globalThis.keel.raceWatch().eye)).toBe(2);

  // A cheer: the bunting, the huzzah; the key waits; the crowd's count back.
  const before = await page.evaluate(() => globalThis.keel.raceWatch().bunting);
  const cheer = bar.locator('[data-readout=race-cheer]');
  await cheer.click();
  await expect(cheer).toHaveAttribute('aria-label', /^Cheered/);
  const after = await page.evaluate(() => {
    globalThis.keel.render();
    return globalThis.keel.raceWatch();
  });
  expect(after.bunting).toBe(before + 1);
  expect(after.cheers?.voices).toBeGreaterThan(0);
  await page.evaluate(() =>
    globalThis.keel.raceCheered({ number: 2, count: 12, crowd: 12, mine: true }),
  );
  await expect(page.locator('[data-readout=cheered]')).toHaveText('You and 11 others cheered');
  expect(await page.evaluate(() => globalThis.keel.raceWatch().bunting)).toBe(before + 2);

  // The crier.
  await page.evaluate(() =>
    globalThis.keel.raceCall({ kind: 'rounded', number: 1, mark: 1, place: 1 }),
  );
  await expect(page.locator('[data-readout=crier]')).toHaveText('Saltwind rounds Mark 1 first');

  // ⋯: follow the action.
  await bar.getByRole('button', { name: /^The race: follow the action/ }).click();
  const more = page.locator('[data-panel=race-bar-more]');
  await more.getByRole('switch').click();
  expect(await page.evaluate(() => globalThis.keel.raceWatch().follow)).toBe(true);
  await more.getByRole('button', { name: 'Close' }).click();
  // A switch by hand hands it back.
  await bar.getByRole('button', { name: 'The boat behind' }).click();
  expect(await page.evaluate(() => globalThis.keel.raceWatch().follow)).toBe(false);

  // Sailing again: the bar goes.
  await page.evaluate(() => globalThis.keel.raceWatching(null));
  await expect(bar).toHaveCount(0);
});
