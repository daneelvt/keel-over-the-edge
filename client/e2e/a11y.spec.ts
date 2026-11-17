// SPDX-License-Identifier: AGPL-3.0-only

// The game read as assistive technology reads it, against keel and its
// database, on pages that draw nothing (?draw=off): axe's checks of the
// start screen, the screen at sea (the barometer out, the autopilot's
// control head open), the menu, the question before going home, the log
// and the news, failing on any serious or critical finding; and the
// instruments read by their names and states: the case's pushers, the
// helm and the sheet with their words, the control head, the night
// light's slider.
// No rule is turned off; one kept but not for a few parts is named below,
// with why.
//
// And the keyboard: keys go to what has the focus. Tabbed to, the sheet
// answers its own arrows, trimming as the helm stays; a key the keyboard
// reached keeps the game's keys off; a question takes the focus on the
// key that changes nothing, with the rest of the page inert, and Escape
// puts it away, the focus back on the menu's button; and the full chart,
// opened from the pocket chart, closes on Escape with the focus back on
// the pocket chart.

import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { GAME, sail, sailor } from './helpers';

/**
 * No rule is turned off. One is kept but not for these parts, and why:
 * checked apart, everywhere else.
 */
const NOT_FOR: { rule: string; parts: string[]; why: string }[] = [
  {
    rule: 'label-content-name-mismatch',
    parts: ['.dial', '.lever'],
    why:
      // A dial's face is a picture of the instrument, its scale's figures
      // and words drawn on it (the barometer's 960 to 1040, Rain, Fair);
      // the key is named for the instrument, its reading read out with
      // it. A lever of the control head is named for what it switches
      // (Autopilot, Hold a heading), its state told as pressed; the
      // legends engraved on its halves (Off and On, Wind and Compass, or
      // their symbols on a narrow head) mark its two positions. axe reads
      // every text on the face as the key's name.
      'a dial’s drawn figures and a lever’s engraved positions are not their names',
  },
];

/** axe's serious and critical findings on the page as it stands, one line each. */
async function findings(page: Page, where: string): Promise<string[]> {
  const all = await new AxeBuilder({ page }).disableRules(NOT_FOR.map((n) => n.rule)).analyze();
  const violations = [...all.violations];
  for (const n of NOT_FOR) {
    let apart = new AxeBuilder({ page }).withRules([n.rule]);
    for (const p of n.parts) {
      apart = apart.exclude(p);
    }
    violations.push(...(await apart.analyze()).violations);
  }
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) =>
      v.nodes.map(
        (n) =>
          `${where}: ${v.id} (${v.impact}), ${v.help}: ${n.target.join(' ')} ${n.failureSummary ?? ''}`,
      ),
    );
}

/** Presses Tab until what has the focus matches sel, at most 60 times; whether it did. */
async function tabTo(page: Page, sel: string): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    if (await page.evaluate((sel) => document.activeElement?.matches(sel) === true, sel)) {
      return true;
    }
    await page.keyboard.press('Tab');
  }
  return false;
}

test('the start screen has no serious finding', async ({ page }) => {
  await page.goto(GAME);
  await expect(page.getByRole('heading', { name: 'Keel Over the Edge' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByLabel('Your sailor’s name')).toBeVisible();
  expect(await findings(page, 'the start screen')).toEqual([]);
});

test('at sea, the screen, the menu, the question before going home, the log and the news have no serious finding', async ({
  context,
  page,
}) => {
  test.setTimeout(120_000);
  // Still: a drum rolling to its words or a window fading in is read mid-way, its colours not yet its own.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await sailor(context, 'Reader');
  await sail(page);
  const found: string[] = [];
  found.push(...(await findings(page, 'at sea')));
  // The instruments by name and state, as a screen reader reads them: the
  // case's pushers, the helm and the sheet with their words, the
  // autopilot's control head.
  await expect(page.getByRole('button', { name: 'World time', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(page.getByRole('button', { name: 'Barometer', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await page.getByRole('button', { name: 'Barometer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Barometer', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Weather on the chart' })).toHaveAttribute(
    'aria-pressed',
    /^(true|false)$/,
  );
  await expect(page.getByRole('slider', { name: 'Helm' })).toHaveAttribute(
    'aria-valuetext',
    /^Helm (amidships|\d+° to (port|starboard))$/,
  );
  await expect(page.getByRole('slider', { name: 'Sheet' })).toHaveAttribute(
    'aria-valuetext',
    /^Sheet \d+%/,
  );
  await page.getByRole('button', { name: /^Autopilot: / }).click();
  const head = page.getByRole('region', { name: 'Autopilot' });
  await expect(head).toBeVisible();
  await expect(head.getByRole('button', { name: 'Tack' })).toBeVisible();
  found.push(...(await findings(page, 'the control head open')));
  await page.getByRole('button', { name: /^Autopilot: / }).click();
  await expect(head).toHaveCount(0);
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.locator('.menu')).toBeVisible();
  // The night light: its name and its value in words.
  await expect(page.getByRole('slider', { name: 'Night light' })).toHaveAttribute(
    'aria-valuetext',
    /.+/,
  );
  found.push(...(await findings(page, 'the menu')));
  await page.locator('.menu').getByRole('button', { name: 'Back to Port Royal' }).click();
  const q = page.getByRole('alertdialog', { name: 'Back to Port Royal?' });
  await expect(q).toBeVisible();
  found.push(...(await findings(page, 'the question')));
  await q.getByRole('button', { name: 'Stay', exact: true }).click();
  await expect(q).toHaveCount(0);
  await page.evaluate(() => globalThis.keel.openLog({ kind: 'own' }));
  await expect(page.locator('.log-sheet')).toBeVisible();
  await expect(page.locator('.log-sheet .log-name')).toBeVisible({ timeout: 15_000 });
  found.push(...(await findings(page, 'the log')));
  await page.evaluate(() => globalThis.keel.openNews(null));
  await expect(page.locator('.news-sheet')).toBeVisible();
  found.push(...(await findings(page, 'the news')));
  expect(found).toEqual([]);
});

test('keys go to what has the focus: the sheet trims on its arrows, a key tabbed to keeps them, a clicked one not, a question and the chart close on Escape and give the focus back', async ({
  context,
  page,
}) => {
  test.setTimeout(120_000);
  await sailor(context, 'Keys');
  await sail(page);
  const controls = () =>
    page.evaluate(() => {
      const b = globalThis.keel.boat();
      return { helm: b.helm, sheet: b.sheet };
    });
  await page.evaluate(() => globalThis.keel.setControls(0, 0.5));
  // Tabbed to, the sheet answers → by trimming, and the helm stays.
  expect(await tabTo(page, '[data-control="sheet"]')).toBe(true);
  await page.keyboard.down('ArrowRight');
  await expect.poll(async () => (await controls()).sheet, { timeout: 5_000 }).toBeLessThan(0.4);
  await page.keyboard.up('ArrowRight');
  expect((await controls()).helm).toBe(0);
  // Page Down eases a tenth.
  const trimmed = (await controls()).sheet;
  await page.keyboard.press('PageDown');
  expect((await controls()).sheet).toBeCloseTo(Math.min(1, trimmed + 0.1), 6);
  // The helm, tabbed to, steers on its arrows; it says the rudder in words.
  expect(await tabTo(page, '[data-control="helm"]')).toBe(true);
  await page.keyboard.down('ArrowLeft');
  await expect.poll(async () => (await controls()).helm, { timeout: 5_000 }).toBeLessThan(-0.3);
  await page.keyboard.up('ArrowLeft');
  await expect(page.locator('[data-control="helm"]')).toHaveAttribute(
    'aria-valuetext',
    /^Helm \d+° to port$/,
  );
  // On a key the keyboard reached, the arrows are not the game's.
  await page.evaluate(() => globalThis.keel.setControls(0, 0.5));
  expect(await tabTo(page, '.menu-button')).toBe(true);
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(400);
  await page.keyboard.up('ArrowRight');
  expect(await controls()).toEqual({ helm: 0, sheet: 0.5 });
  // The question before going home: the focus on Stay, the case behind
  // inert, Escape is Stay and the focus goes back to the menu's button.
  await page.keyboard.press('Enter');
  await expect(page.locator('.menu')).toBeVisible();
  const back = page.locator('.menu').getByRole('button', { name: 'Back to Port Royal' });
  await back.focus();
  await page.keyboard.press('Enter');
  const q = page.getByRole('alertdialog', { name: 'Back to Port Royal?' });
  await expect(q).toBeVisible();
  await expect(q).toHaveAttribute('aria-modal', 'true');
  await expect(q.getByRole('button', { name: 'Stay', exact: true })).toBeFocused();
  expect(
    await page.evaluate(() => document.querySelector('.case')?.closest('[inert]') != null),
  ).toBe(true);
  await page.keyboard.press('Escape');
  await expect(q).toHaveCount(0);
  await expect(page.locator('.menu-button')).toBeFocused();
  expect(await page.evaluate(() => document.querySelector('[inert]') === null)).toBe(true);
  // The full chart from the pocket chart: Escape closes it, the focus back
  // on the pocket chart.
  expect(await tabTo(page, '.pocket-chart')).toBe(true);
  await page.keyboard.press('Enter');
  const chart = page.getByRole('dialog', { name: 'The chart' });
  await expect(chart).toBeVisible();
  expect(
    await page.evaluate(() =>
      document.querySelector('.chart-screen')?.contains(document.activeElement),
    ),
  ).toBe(true);
  await page.keyboard.press('Escape');
  await expect(chart).toHaveCount(0);
  await expect(page.locator('.pocket-chart')).toBeFocused();
  // A key a pointer pressed keeps the game's keys, a Shift between too:
  // the arrows still steer.
  await page.evaluate(() => globalThis.keel.setControls(0, 0.5));
  const reef = page.getByRole('button', { name: /^Reef: / });
  await reef.click();
  await expect(reef).toBeFocused();
  await page.keyboard.press('Shift');
  await page.keyboard.down('ArrowLeft');
  await expect.poll(async () => (await controls()).helm, { timeout: 5_000 }).toBeLessThan(-0.3);
  await page.keyboard.up('ArrowLeft');
});
