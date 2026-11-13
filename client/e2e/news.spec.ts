// SPDX-License-Identifier: AGPL-3.0-only

// The news sheet on the chart screen, on the offline sandbox with the
// day's edition stood in for: the News tab's dot while today's edition has
// a story not yet read, each such story marked new and read once shown,
// both kept after a reload; a story chosen while the sheet is open
// slipping in, lit; a tap on a story opening the chart on its
// place with its box, or on its point; a name whose log may be read opening
// it in the Log tab, and one whose may not, nothing; the listener on the
// chart's chartings let go when the sheet closes. And the sheet before the
// sea, from the view waiting to watch, standing on its own.

import { expect, test } from '@playwright/test';
import { openScene } from './helpers';
import { LONG_NAME, standInLogs } from './logs';
import { fullDay, KEYHOLE, standInNews } from './news';

/** Keyhole Rock, charted in the sandbox's chart: a place on an island of the rim. */
function keyhole() {
  return {
    subject: KEYHOLE.subject,
    number: KEYHOLE.number,
    sort: 0,
    name: KEYHOLE.name,
    east: 3200,
    north: -14_800,
    by: LONG_NAME,
    ai: false,
    at: Date.now() - 600_000,
    worth: 24,
    island: -1,
    group: '',
    bounds: null,
    highest: 0,
    zone: 2,
    className: '',
    model: '',
    light: -1,
    character: 0,
    focal: 0,
    range: 0,
    ship: '',
    sunk: false,
    withSubject: null,
    withNumber: 0,
  };
}

/** A story chosen after the sheet was opened. */
function arrived() {
  return {
    id: '0193a1f0c0de4b7e9a01000000000099',
    kind: 'great',
    at: Date.now(),
    head: 'GANNET HOLM',
    text: 'A blowhole on an island of the rim, first sighted by {0}.',
    names: [{ kind: 'human', name: 'Grace O’Malley', logged: true }],
    subject: 'place',
    number: 9003,
    x: 2000,
    y: -12_000,
  };
}

test('the news: new stories and the tab’s dot, kept after a reload; a tap to the chart with its box; a name to its log', async ({
  page,
}) => {
  test.skip(test.info().project.name === 'webgpu', 'the news is the same on either back end');
  test.setTimeout(120_000);
  let today: () => object = fullDay;
  await standInNews(page, () => today());
  await standInLogs(page);
  await page.setViewportSize({ width: 360, height: 640 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const open = async () => {
    await openScene(page, 'world=1', true);
    await page.evaluate((e) => {
      globalThis.keel.newsFromServer();
      globalThis.keel.chartReceive([e as never], false);
      globalThis.keel.openChart('chart');
    }, keyhole());
  };
  await open();
  const listening = await page.evaluate(() => globalThis.keel.chartListeners());

  // Nothing read yet: the dot, and every story new.
  const dot = page.locator('.chart-tab-dot');
  await expect(dot).toBeVisible();
  await page.getByRole('button', { name: 'News' }).click();
  const stories = page.locator('.news-story');
  await expect(stories).toHaveCount(9);
  await expect(page.locator('.news-story .news-new')).toHaveCount(9);
  expect(await page.evaluate(() => globalThis.keel.chartListeners())).toBe(listening + 1);

  // A tap on Keyhole Rock's story: the chart, on it, its box open.
  await stories.first().click({ position: { x: 30, y: 12 } });
  await expect(page.locator('.chart-box h2')).toHaveText(KEYHOLE.name);
  expect(await page.evaluate(() => globalThis.keel.chartInfo().mode)).toBe('chart');
  // The sheet closed: its listener let go. The stories read: no dot.
  await expect.poll(() => page.evaluate(() => globalThis.keel.chartListeners())).toBe(listening);
  await expect(dot).toHaveCount(0);

  // A story whose place is not on the reader's chart opens its point.
  await page.getByRole('button', { name: 'News' }).click();
  await expect(page.locator('.news-story .news-new')).toHaveCount(0);
  await page.getByRole('button', { name: 'Pelican cove, on the chart' }).click();
  expect(await page.evaluate(() => globalThis.keel.chartInfo().mode)).toBe('chart');
  await expect(page.locator('.chart-box')).toHaveCount(0);

  // A name whose log may be read opens it; one whose may not is no link.
  await page.getByRole('button', { name: 'News' }).click();
  await expect(page.locator('.news-name')).toHaveCount(7);
  await expect(page.locator('.news-sheet button', { hasText: 'Tom Tew' })).toHaveCount(0);
  await expect(page.locator('.news-story').nth(2)).toContainText('Tom Tew');
  await page.getByRole('button', { name: `${LONG_NAME}: Their log` }).click();
  expect(await page.evaluate(() => globalThis.keel.chartInfo().mode)).toBe('log');
  await expect(page.locator('.log-back')).toBeVisible();
  await expect(page.locator('.log-name')).toContainText(LONG_NAME);

  // A story chosen while the sheet is open slips in, lit, soon after a charting.
  await page.getByRole('button', { name: 'News' }).click();
  await expect(stories).toHaveCount(9);
  today = () => {
    const e = fullDay();
    return { ...e, stories: [arrived(), ...e.stories.slice(0, 5)] };
  };
  await page.evaluate((e) => globalThis.keel.chartReceive([e as never], false), {
    ...keyhole(),
    number: 9003,
    name: 'Gannet Holm',
  });
  await expect(page.locator('.news-story.news-arrived')).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator('.news-arrived .news-new')).toHaveCount(1);
  await expect(page.locator('.news-arrived')).toContainText('Gannet holm');
  today = fullDay;

  // An earlier edition, and back to today's.
  await page.getByRole('button', { name: 'News' }).click();
  await page.locator('.news-older').click();
  await expect(page.locator('.news-edition')).toContainText('No. 3');
  await expect(page.locator('.news-story .news-new')).toHaveCount(4);
  await page.locator('.news-newer').click();
  await expect(page.locator('.news-edition')).toContainText('No. 4');

  // After a reload: what was read stays read, and no dot.
  await open();
  await expect(page.locator('.chart-tab.chosen')).toHaveText('Chart');
  await page.waitForTimeout(500);
  await expect(dot).toHaveCount(0);
  await page.getByRole('button', { name: 'News' }).click();
  await expect(stories).toHaveCount(9);
  await expect(page.locator('.news-story .news-new')).toHaveCount(0);
});

test('the news while waiting to watch: News beside Watch another opens the sheet over the view, a name its log over it, each closed in turn', async ({
  page,
}) => {
  test.skip(test.info().project.name === 'webgpu', 'the news is the same on either back end');
  await standInNews(page);
  await standInLogs(page);
  await page.setViewportSize({ width: 360, height: 640 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openScene(page, 'world=1', true);
  await page.evaluate(() => globalThis.keel.watchWaiting('Iron Mary'));
  const plate = page.locator('.watch-waiting [data-readout="watching"]');
  await expect(plate).toContainText('Iron Mary has left the water.');
  await plate.getByRole('button', { name: 'News' }).click();
  // The sheet on its own, over the view: its stories, no tap to a chart.
  const sheet = page.locator('.news-alone-screen .news-sheet');
  await expect(sheet.locator('.news-story')).toHaveCount(9);
  await expect(sheet.locator('.news-go')).toHaveCount(0);
  await expect(sheet.locator('.news-edition')).toContainText('No. 4');
  await sheet.getByRole('button', { name: `${LONG_NAME}: Their log` }).click();
  const log = page.locator('.log-alone-screen .log-sheet');
  await expect(log.locator('.log-name')).toContainText(LONG_NAME);
  await log.getByRole('button', { name: 'Close' }).click();
  await expect(log).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(plate).toBeVisible();
  await page.evaluate(() => globalThis.keel.watchWaiting(null));
});
