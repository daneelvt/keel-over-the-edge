// SPDX-License-Identifier: AGPL-3.0-only

// The game connection in the browser, against keel (tools/e2e): a guest
// connects and the sea appears with the server's boat; a sail predicted
// with no correction; a wind changed on the server reaches the boat; a
// reload within the grace finds the same boat; a restart of keel rings the
// harbourmaster's bell and the same boat is there after; and a second
// device takes the boat, and is taken back from. One back end is enough: the drawing is not under test.

import { expect, type Page, test } from '@playwright/test';
import { guest, heldRegime, sail } from './helpers';

const internal = 'http://127.0.0.1:19090';
const control = 'http://127.0.0.1:19099';

test.beforeEach(() => {
  test.skip(test.info().project.name !== 'webgl2', 'the connection: one back end is enough');
});

function net(page: Page) {
  return page.evaluate(() => globalThis.keel.net());
}

test('a guest connects, and the sea appears with the server’s boat', async ({ page, context }) => {
  await guest(context);
  await sail(page);
  const n = await net(page);
  expect(n.boat).toBeGreaterThan(0);
  expect(n.tick).toBeGreaterThan(0);
  // The boat starts on the server's grid, south of the centre, heading east.
  const b = await page.evaluate(() => globalThis.keel.boat());
  expect(b.state.y).toBeLessThan(0);
  expect(Math.abs(b.state.heading - Math.PI / 2)).toBeLessThan(0.5);
  await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible();
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.locator('.menu-rtt')).toHaveText(/Round trip (\d+|under 1) ms/);
});

/**
 * No correction in clean air. The boats of the tests before sail on in their
 * grace near where a new boat appears, and whether their wakes reach it is
 * the wind's doing: a step in another boat's shadow, which the page knows
 * only from the snapshots' samples, may be corrected, by no more than a
 * millimetre.
 */
function cleanAir(c: { corrections: number; shadowed: number; largest: number }): void {
  if (c.shadowed === 0) {
    expect(c.corrections).toBe(0);
  }
  expect(c.largest).toBeLessThan(0.001);
}

test('a sail predicted with no correction', async ({ page, context }) => {
  await guest(context);
  await sail(page);
  await page.evaluate(() => globalThis.keel.script('wiggle'));
  await page.waitForTimeout(15_000);
  const n = await net(page);
  expect(n.counts.snapshots).toBeGreaterThan(150);
  cleanAir(n.counts);
  expect(n.traffic.messagesOut).toBeGreaterThan(100);
});

test('a wind changed on the server reaches the boat', async ({ page, context, request }) => {
  await guest(context);
  await sail(page);
  const res = await request.post(`${internal}/debug/wind?knots=15&from=90`);
  expect(res.status()).toBe(204);
  // A steady wind is in the steps a sea area's wind is rounded to: 15 knots
  // is 7.72 m/s. It takes effect at the second after next.
  await page.waitForFunction(
    () => Math.abs(globalThis.keel.boat().wind.speed - 7.72) < 1e-9,
    null,
    {
      timeout: 5_000,
    },
  );
  const b = await page.evaluate(() => globalThis.keel.boat());
  expect(b.wind.from).toBeCloseTo(Math.PI / 2, 9);
  // The boat heard of it before it took effect: nothing is corrected.
  await page.waitForTimeout(1_000);
  cleanAir((await net(page)).counts);
  // Back to the breeze tools/e2e holds.
  expect((await request.post(`${internal}/debug/weather?regime=${heldRegime()}`)).status()).toBe(
    204,
  );
});

test('a reload within the grace finds the same boat', async ({ page, context }) => {
  await guest(context);
  await sail(page);
  await page.evaluate(() => globalThis.keel.setControls(0.3, 0.4));
  await page.waitForTimeout(3_000);
  const before = await net(page);
  const at = (await page.evaluate(() => globalThis.keel.boat())).state;
  await sail(page);
  const after = await net(page);
  expect(after.boat).toBe(before.boat);
  const now = (await page.evaluate(() => globalThis.keel.boat())).state;
  // The boat sailed on while the page reloaded: near where it was, not back at the start.
  expect(Math.hypot(now.x - at.x, now.y - at.y)).toBeLessThan(40);
});

test('a restart of keel rings the bell, and the boat waits for its sailor', async ({
  page,
  context,
  request,
}) => {
  await guest(context);
  await sail(page);
  const before = await net(page);
  const line = page.locator('[data-readout="connection"]');
  const bell = expect(line).toHaveText(/harbourmaster rings the bell/, { timeout: 30_000 });
  expect((await request.post(`${control}/restart`, { timeout: 60_000 })).status()).toBe(204);
  await bell;
  await page.waitForFunction(() => globalThis.keel.net().status === 'sailing', null, {
    timeout: 30_000,
  });
  expect((await net(page)).boat).toBe(before.boat);
  // Back aboard: the line goes.
  await expect(line).toHaveCount(0);
});

test('another device takes the boat, and Take over takes it back', async ({ page, browser }) => {
  // Two pages load the game, one while the other sails: on CI's software
  // GPU that alone has taken most of the 90 s a test is given. Small pages,
  // as together.spec.ts's, so the second loads beside the first.
  test.setTimeout(180_000);
  const small = { width: 320, height: 200 };
  await page.setViewportSize(small);
  const context = page.context();
  await guest(context);
  await sail(page);
  const boat = (await net(page)).boat;
  const other = await browser.newContext({
    storageState: await context.storageState(),
    viewport: small,
  });
  const second = await other.newPage();
  await sail(second);
  expect((await net(second)).boat).toBe(boat);
  await expect(page.locator('[data-readout="connection"]')).toHaveText(/another device/);
  await page.getByRole('button', { name: 'Take over' }).click();
  await page.waitForFunction(() => globalThis.keel.net().status === 'sailing', null, {
    timeout: 10_000,
  });
  await expect(second.locator('[data-readout="connection"]')).toHaveText(/another device/);
  expect((await net(page)).boat).toBe(boat);
  await other.close();
});
