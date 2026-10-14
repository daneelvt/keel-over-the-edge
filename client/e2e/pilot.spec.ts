// SPDX-License-Identifier: AGPL-3.0-only

// The autopilot in a real browser, in the offline sandbox, on each back end:
// its button switches it on at the boat's angle to the wind and opens the
// dial, which steps the target and closes on a tap elsewhere; on it the
// boat tacks through the wind; the keys work it; a thumb on the helm takes
// the helm back where it left it; and its course on the water is drawn with
// the factory's material.

import { expect, type Page, test } from '@playwright/test';
import { openScene } from './helpers';

/**
 * Under way on a beam reach on port tack in the sandbox's north wind, by
 * hand; returns the boat's angle off the wind in whole degrees, about −90.
 */
async function reaching(page: Page): Promise<number> {
  await openScene(page, '', true);
  const b = await page.evaluate(() => {
    const k = globalThis.keel;
    k.setState({ heading: Math.PI / 2, surge: 3, sheetLimit: 0.5 });
    k.setControls(0, 0.3);
    k.advance(30);
    k.render();
    return k.boat();
  });
  return Math.round(angleOff(b));
}

/** The boat's angle off the mean wind, degrees, positive with the wind over starboard. */
function angleOff(b: { state: { heading: number }; wind: { meanFrom: number } }): number {
  const a = ((b.wind.meanFrom - b.state.heading) * 180) / Math.PI;
  return ((((a + 180) % 360) + 360) % 360) - 180;
}

test('the button switches it on at the boat’s angle; the dial steps the target and closes', async ({
  page,
}) => {
  const angle = await reaching(page);
  expect(Math.abs(angle + 90)).toBeLessThan(3);
  await expect(page.locator('[data-readout=pilot-button]')).toHaveText('Off');
  await page.locator('[data-pilot=button]').click();
  await page.evaluate(() => globalThis.keel.render());
  // About 90° off a north wind, heading east: the wind over port.
  await expect(page.locator('[data-readout=pilot-button]')).toHaveText(`Wind ${-angle}° P`);
  await expect(page.locator('[data-readout=pilot]')).toHaveText(`Wind ${-angle}° P`);
  await expect(page.locator('[data-pilot=dial]')).toBeVisible();
  // Eleven degrees to starboard: bearing away on port.
  await page.locator('[data-pilot-step="10"]').click();
  await page.locator('[data-pilot-step="1"]').click();
  await page.evaluate(() => globalThis.keel.render());
  expect((await page.evaluate(() => globalThis.keel.boat())).pilot.degrees).toBe(angle - 11);
  await expect(page.locator('[data-readout=pilot-button]')).toHaveText(`Wind ${11 - angle}° P`);
  // The other mode holds the heading the boat has.
  await page.locator('[data-pilot=mode]').click();
  const heading = await page.evaluate(() => globalThis.keel.boat().pilot);
  expect(heading.mode).toBe(2);
  // A tap on the sea closes the dial; the autopilot stays on.
  await page.mouse.click(120, 340);
  await expect(page.locator('[data-pilot=dial]')).toHaveCount(0);
  expect((await page.evaluate(() => globalThis.keel.boat())).pilot.mode).toBe(2);
  // Off, from the dial.
  await page.locator('[data-pilot=button]').click();
  await page.locator('[data-pilot=off]').click();
  await page.evaluate(() => globalThis.keel.render());
  await expect(page.locator('[data-readout=pilot-button]')).toHaveText('Off');
  await expect(page.locator('[data-pilot=dial]')).toHaveCount(0);
});

test('on the autopilot, Tack turns the boat through the wind onto the same angle', async ({
  page,
}) => {
  await openScene(page, '', true);
  // Close-hauled on starboard, sheeted in.
  await page.evaluate(() => {
    const k = globalThis.keel;
    k.setState({ heading: -Math.PI / 4, surge: 2.5, sheetLimit: 0.1, boom: -0.1 });
    k.setControls(0, 0.05);
    k.advance(30);
  });
  await page.keyboard.press('p');
  const on = await page.evaluate(() => {
    const k = globalThis.keel;
    k.advance(150);
    return k.boat();
  });
  expect(on.pilot.mode).toBe(1);
  expect(Math.abs(angleOff(on) - 45)).toBeLessThan(3);
  const held = on.pilot.degrees;
  await page.locator('[data-pilot=button]').click();
  await page.locator('[data-pilot=tack]').click();
  const turn = await page.evaluate(() => {
    const k = globalThis.keel;
    const angles: number[] = [];
    for (let i = 0; i < 40; i++) {
      k.advance(10);
      const b = k.boat();
      const a = ((b.wind.meanFrom - b.state.heading) * 180) / Math.PI;
      angles.push(((((a + 180) % 360) + 360) % 360) - 180);
    }
    k.render();
    return { angles, after: k.boat() };
  });
  // Through head to wind, never near dead downwind, onto 45° on port.
  expect(Math.max(...turn.angles.map(Math.abs))).toBeLessThan(60);
  expect(Math.min(...turn.angles.map(Math.abs))).toBeLessThan(10);
  expect(Math.abs(angleOff(turn.after) + held)).toBeLessThan(5);
  expect(turn.after.pilot).toMatchObject({ order: 1, degrees: -held });
  await expect(page.locator('[data-readout=pilot-button]')).toHaveText(`Wind ${held}° P`);
});

test('the keys: P on and off, Q and E a degree, ten with Shift, G gybes', async ({ page }) => {
  const angle = await reaching(page);
  await page.keyboard.press('p');
  const pilot = () => page.evaluate(() => globalThis.keel.boat().pilot);
  expect(await pilot()).toMatchObject({ mode: 1, degrees: angle });
  await page.keyboard.press('e');
  expect((await pilot()).degrees).toBe(angle - 1);
  await page.keyboard.press('Shift+q');
  expect((await pilot()).degrees).toBe(angle + 9);
  await page.keyboard.press('g');
  expect(await pilot()).toMatchObject({ degrees: -(angle + 9), order: 1, way: 2 });
  await page.keyboard.press('p');
  expect((await pilot()).mode).toBe(0);
});

test('a thumb on the helm takes it back where the autopilot left it', async ({ page }) => {
  await reaching(page);
  await page.keyboard.press('p');
  const before = await page.evaluate(() => {
    const k = globalThis.keel;
    // A gust of helm to hold: off course, the autopilot steers back.
    k.setState({ yawRate: 0.3 });
    k.advance(5);
    k.render();
    return k.boat();
  });
  expect(before.pilot.mode).toBe(1);
  expect(Math.abs(before.out.pilotHelm)).toBeGreaterThan(0.01);
  const box = await page.locator('[data-control=helm]').boundingBox();
  if (box === null) {
    throw new Error('the helm is not on screen');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  const after = await page.evaluate(() => {
    const k = globalThis.keel;
    k.render();
    return k.boat();
  });
  expect(after.pilot.mode).toBe(0);
  expect(after.helm).toBeCloseTo(before.out.pilotHelm, 2);
  await expect(page.locator('[data-readout=pilot-button]')).toHaveText('Off');
});

test('its course on the water is drawn with the factory’s material, with the bend', async ({
  page,
}) => {
  await reaching(page);
  await page.evaluate(() => globalThis.keel.settings({ windOverlay: true }));
  await page.keyboard.press('p');
  const checked = await page.evaluate(() => {
    const k = globalThis.keel;
    k.advance(30);
    k.render();
    return { problems: k.checkScene(), course: k.world.overlays.course.group.visible };
  });
  expect(checked.course).toBe(true);
  expect(checked.problems).toEqual([]);
});
