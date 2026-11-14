// SPDX-License-Identifier: AGPL-3.0-only

// A race replayed on the chart, in a real browser, on the offline sandbox,
// the replay's route stood in for: the race's link opens the chart framed
// on the course, its name and the standings under the strip and the
// replay's time at the foot; the slider moves the boats along their
// tracks and the standings with them; play runs at 30×; a boat tapped in
// the standings is followed; the results list every boat with its prize,
// its awards and those aboard; a time trial's runs sail together and a
// run tapped is drawn; a race whose world has gone shows its results
// alone; and closing the chart closes the replay.

import { expect, type Page, test } from '@playwright/test';
import { openScene } from './helpers';
import { GONE, RACED, standInReplays, TRIAL } from './replays';

/** The replay as the page has it, the slider moved to at if given and the chart drawn: a page under test draws only when asked. */
function replayed(page: Page, at?: number) {
  return page.evaluate((t) => {
    globalThis.keel.replayed(t);
    globalThis.keel.render();
    return globalThis.keel.replayed();
  }, at);
}

/** What the chart draws of the replay, once drawn: it draws at its own pace. */
async function charted(page: Page, want: Record<string, number | boolean>) {
  await expect
    .poll(async () => (await replayed(page))?.chart, { timeout: 5000 })
    .toMatchObject(want);
}

test('a race replayed on the chart: the slider, play, a boat followed, the results; a trial’s runs together; a gone world’s results alone', async ({
  page,
}) => {
  test.skip(test.info().project.name === 'webgpu', 'the chart is the same on either back end');
  await page.setViewportSize({ width: 360, height: 640 });
  await openScene(page, 'world=1', true);
  const at = await page.evaluate(() => ({
    east: globalThis.keel.world.pose.east,
    north: globalThis.keel.world.pose.north + 600,
  }));
  const asked = await standInReplays(page, at.east, at.north);

  // The link after the race: the chart on the course, the head and the bar.
  expect(await page.evaluate((c) => globalThis.keel.replay(c), RACED)).toBe(true);
  const bar = page.locator('[data-readout=replay-bar]');
  const head = page.locator('[data-readout=replay-head]');
  await expect(bar).toBeVisible();
  await expect(head).toContainText('The Graveyard Watch Gallop');
  await expect(head.locator('[data-readout=replay-standing]')).toHaveText(/6 boats on the line/);
  await expect(page.locator('[data-readout=replay-clock]')).toHaveText('−2:00 to the gun');
  let r = await replayed(page);
  expect(r?.lo).toBe(-120);
  // The player's own boat followed from the first.
  expect(r?.followed).toBe(2);
  await charted(page, { shown: true, marks: 2, boats: 6, tracks: 0 });

  // A minute after the gun: every track to then, the standings by progress.
  r = await replayed(page, 60);
  await charted(page, { shown: true, tracks: 6, boats: 6 });
  expect(r?.standings.map((s) => s.key)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(r?.standings.every((s) => s.state === 'racing' && s.toGo > 0)).toBe(true);
  await expect(page.locator('[data-readout=replay-clock]')).toHaveText('1:00');
  await expect(head.locator('.rp-place')).toHaveCount(3);
  await expect(head.locator('.rp-place').first()).toContainText('1Mira');

  // Play at 30×: the slider runs on.
  await bar.getByRole('button', { name: '30×' }).click();
  await bar.getByRole('button', { name: 'Play' }).click();
  await expect
    .poll(async () => (await replayed(page))?.t ?? 0, { timeout: 5000 })
    .toBeGreaterThan(90);
  await bar.getByRole('button', { name: 'Pause' }).click();
  expect((await replayed(page))?.playing).toBe(false);

  // After the first home: Mira home, the retired boat out of the race.
  r = await replayed(page, (r?.hi ?? 0) - 1);
  expect(r?.standings[0]).toMatchObject({ key: 1, place: 1, state: 'home' });
  expect(r?.standings.at(-1)).toMatchObject({ key: 6, place: 0, state: 'retired' });
  await charted(page, { boats: 5 });

  // The standings opened from the head; a boat tapped is followed.
  await head.locator('[data-readout=replay-standing]').click();
  const standings = page.locator('[data-panel=replay-standings]');
  await expect(standings.locator('.rp-row')).toHaveCount(6);
  await expect(standings.locator('.rp-row').first()).toContainText(/Home \d+:\d\d/);
  await standings.locator('.rp-row').nth(2).click();
  await expect(standings).toBeHidden();
  expect((await replayed(page))?.followed).toBe(3);

  // The results: every boat, its prize and time, the awards, those aboard.
  await bar.getByRole('button', { name: 'Results' }).click();
  const results = page.locator('[data-panel=replay-results]');
  await expect(results.locator('[data-readout=replay-results] li')).toHaveCount(6);
  await expect(results.locator('[data-readout=replay-results] li').first()).toContainText(
    'Aboard: Anne Bonny, one more',
  );
  await expect(results.locator('[data-readout=replay-results] li').nth(1)).toHaveClass(/rl-mine/);
  await expect(results.locator('[data-readout=replay-results] li').nth(5)).toContainText('Retired');
  await expect(results.locator('[data-readout=replay-awards] li')).toHaveCount(4);
  await results.getByRole('button', { name: 'Close' }).click();

  // A trial's runs sail together, each from its own start; a run tapped is drawn.
  expect(await page.evaluate((c) => globalThis.keel.replay(c), TRIAL)).toBe(true);
  await expect(head).toContainText('the Gannet Holm Challenge');
  r = await replayed(page, 30);
  await charted(page, { tracks: 3, boats: 3 });
  await bar.getByRole('button', { name: 'Results' }).click();
  const runs = results.locator('[data-readout=replay-runs] .rp-run');
  await expect(runs).toHaveCount(4);
  await expect(runs.nth(3)).toHaveAttribute('aria-pressed', 'false');
  await runs.nth(3).click();
  await expect(runs.nth(3)).toHaveAttribute('aria-pressed', 'true');
  expect(asked.at(-1)).toBe(`/api/race/${TRIAL}/replay?runs=1,2,3,4`);
  await charted(page, { tracks: 4 });
  await results.getByRole('button', { name: 'Close' }).click();

  // Closing the chart closes the replay.
  await page.getByRole('button', { name: 'Back to sea' }).click();
  expect(await replayed(page)).toBeNull();

  // A race whose world has gone: its results alone.
  await page.evaluate((c) => globalThis.keel.replay(c), GONE);
  const alone = page.locator('[data-panel=replay-alone]');
  await expect(alone).toBeVisible();
  await expect(alone.locator('[data-readout=replay-alone-note]')).toContainText(
    'World 13 has ended',
  );
  await expect(alone.locator('[data-readout=replay-results] li')).toHaveCount(8);
  await alone.getByRole('button', { name: 'Close' }).click();
  await expect(alone).toBeHidden();

  // A race not over yet says so.
  await page.evaluate(() => globalThis.keel.replay('notoveraaa'));
  await expect(page.locator('[data-readout=replay-said]')).toContainText('isn’t over yet');
});
