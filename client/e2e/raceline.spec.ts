// SPDX-License-Identifier: AGPL-3.0-only

// A race sailed on the racer's screen, in a real browser, on the offline
// sandbox, the race committee's messages stood in for by the page's test
// hooks: told before the start, the race line counts down with the flag
// up and says how far the boat is from the line; the committee boat flies
// the flags of the moment and fires her gun with smoke; racing, the line
// gives the place, the gap ahead and the next mark's bearing and
// distance, the pocket chart frames the course and the chart opens on it
// with the boats' tracks; a call shows on the line and goes; Retire, from
// the line's ⋯, asks first and retires; a boat home opens the finish's
// card, and the results the results' window with its rosettes, its awards
// read warmly and the wooden spoon's question.

import { expect, test } from '@playwright/test';
import { openScene } from './helpers';

test('a race on the racer’s screen, from the warning to the results', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 360, height: 640 });
  await openScene(page, 'world=1', true);
  const line = page.locator('[data-readout=race-line]');

  // Told two minutes before the start: the class's flag, the countdown, the line.
  const told = await page.evaluate(() => {
    const k = globalThis.keel;
    k.setSky(12);
    return k.raceTell({ start: k.world.ticks + 100 * 30 });
  });
  await expect(line).toHaveAttribute('data-state', 'before');
  await expect(line.locator('[data-readout=race-countdown]')).toHaveText('−1:40');
  await expect(line.locator('[data-readout=race-side]')).toHaveText(/^\d+ m to the line$/);
  await expect(line.locator('.rl-flag')).toHaveAttribute('aria-label', 'The class’s flag');
  const flown = await page.evaluate(() => globalThis.keel.raceMarks().laid[0]?.flags.length ?? 0);
  expect(flown).toBe(1);

  // The start's gun, its smoke.
  const gun = await page.evaluate(() => {
    const k = globalThis.keel;
    k.raceSignal({ signal: 'start', gun: true });
    k.render();
    return { gun: k.game.lastGun !== null, puffs: k.raceMarks().puffs };
  });
  expect(gun.gun).toBe(true);
  expect(gun.puffs).toBeGreaterThan(0);

  // Racing: third of three, 18 s behind the second, making for mark 1.
  await page.evaluate((t) => {
    const k = globalThis.keel;
    k.raceTell({ start: 1 });
    const m = t.marks[0];
    for (let i = 0; i < 4; i++) {
      k.racePicture([
        { place: 3, gap: 24.5, leg: 1, north: k.world.pose.north - 40 + i * 10 },
        { place: 1, gap: 0, leg: 2, east: (m?.east ?? 0) + i, north: m?.north ?? 0 },
        { place: 2, gap: 6.5, leg: 1, east: k.world.pose.east + 20 + i * 5 },
      ]);
    }
    k.render();
  }, told);
  await expect(line).toHaveAttribute('data-state', 'racing');
  await expect(line.locator('[data-readout=race-place]')).toHaveText('3/3');
  await expect(line.locator('[data-readout=race-gap]')).toHaveText('+0:18');
  await expect(line.locator('.rl-label')).toHaveText('Mk 1');
  await expect(line.locator('.rl-bearing')).toHaveText(/^\d{3}°$/);

  // The chart opens on the course, every boat's track and its tags.
  await page.locator('.pocket-chart').click();
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          // A page under test draws only when asked.
          globalThis.keel.render();
          return globalThis.keel.racing().chart;
        }),
      { timeout: 10_000 },
    )
    .toMatchObject({ shown: true, tracks: 3, marks: 3, tags: 2, boats: 3 });
  await expect(page.locator('.race-chart-tag')).toHaveCount(2);
  await page.locator('.chart-back').click();

  // A call: on the line a while, in the log's words.
  await page.evaluate(() => globalThis.keel.raceCall({ article: '10', number: 1, other: 2 }));
  await expect(line).toHaveAttribute('data-state', 'call');
  await expect(line.locator('[data-readout=race-call]')).toHaveText(
    'Port tack keeps clear of starboard · 10 seconds added',
  );
  await expect(line).toHaveAttribute('data-state', 'racing', { timeout: 10_000 });

  // Retire asks first.
  await line.locator('.rl-more').click();
  const more = page.locator('[data-panel=race-more]');
  await expect(more.locator('[data-readout=race-clock]')).toContainText('Race clock');
  await more.getByRole('button', { name: 'Retire…' }).click();
  await more.getByRole('button', { name: 'Keep racing' }).click();
  await more.getByRole('button', { name: 'Retire…' }).click();
  await more.getByRole('button', { name: 'Retire', exact: true }).click();
  await expect(more).toHaveCount(0);
  await expect(line.locator('[data-readout=race-done]')).toHaveText(
    'Retired · the results when the race ends',
  );

  // Another race, home second: the finish's card, then the results.
  await page.evaluate(() => {
    const k = globalThis.keel;
    k.raceGone(1, true);
    k.raceTell({ start: 1 });
    k.racePicture([{ place: 2 }, { place: 1, state: 'finished' }, { place: 3 }]);
    k.raceFinish({ number: 2, place: 1, elapsedMs: 570_000 });
    k.raceFinish({ number: 1, place: 2, elapsedMs: 604_200, added: 10 });
  });
  const finish = page.locator('[data-panel=race-finish]');
  await expect(finish.locator('[data-readout=race-finish]')).toHaveText('10:04 · 10 s added');
  await expect(finish).toContainText('0:44 behind the winner');
  await expect(line.locator('[data-readout=race-done]')).toHaveText(
    'Home 2nd of 3 · 10:04 · 10 s added',
  );
  await page.evaluate(() =>
    globalThis.keel.raceResults({
      results: [
        {
          number: 2,
          place: 1,
          how: 'finished',
          elapsedMs: 570_000,
          added: 0,
          marks: 3,
          toGo: 0,
          medal: '',
          awards: ['best-start'],
        },
        {
          number: 3,
          place: 2,
          how: 'finished',
          elapsedMs: 600_000,
          added: 0,
          marks: 3,
          toGo: 0,
          medal: '',
          awards: [],
        },
        {
          number: 1,
          place: 3,
          how: 'finished',
          elapsedMs: 604_200,
          added: 10,
          marks: 3,
          toGo: 0,
          medal: '',
          awards: ['spoon'],
        },
      ],
    }),
  );
  const results = page.locator('[data-panel=race-results]');
  await expect(results.locator('.rl-results li')).toHaveCount(3);
  await expect(results.locator('[role=img][aria-label="1st of 3"]')).toHaveCount(1);
  await expect(results.locator('[data-readout=race-awards]')).toContainText(
    'The wooden spoon to Mira, who never gave up',
  );
  await expect(results.locator('[data-readout=race-spoon]')).toContainText(
    'Hang the spoon from your stern',
  );
  // Hung by the sailor's choice, the server's answer stood in for.
  await page.route('**/api/race/abcdefghij/spoon', (r) => r.fulfill({ json: { hang: true } }));
  await results.getByRole('button', { name: 'Yes, hang it' }).click();
  await expect(results).toContainText('The spoon hangs from your stern');
  await results.getByRole('button', { name: 'Close' }).click();
  await expect(results).toHaveCount(0);
});
