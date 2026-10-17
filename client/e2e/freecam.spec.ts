// SPDX-License-Identifier: AGPL-3.0-only

// The free camera in the sandbox, where anyone may fly it (seed 1's world:
// go run ./tools/dev -world 1): F flies it off the boat, the screen clean;
// the scene follows the point beneath it, so the floating origin, the
// dome's bend, the tile field and the land are about the camera 2 km from
// the boat, which stays where it was; Escape brings it back, the chase
// camera behind the boat at once.

import { expect, test } from '@playwright/test';
import { openScene } from './helpers';

test('the free camera flies, the scene about it, and comes back to the boat', async ({ page }) => {
  await openScene(page, 'world=1', true);
  await page.evaluate(() => globalThis.keel.thaw());
  await page.waitForTimeout(500);
  const drawnAtStart = (await page.evaluate(() => globalThis.keel.land()))?.drawn ?? [];
  expect(await page.evaluate(() => globalThis.keel.freeCam().hud)).toBe(true);
  await page.keyboard.press('KeyF');
  let cam = await page.evaluate(() => globalThis.keel.freeCam());
  expect(cam.on && cam.flying && cam.stays).toBe(true);
  // The screen is clean: no instruments, and the way back hidden until a tap.
  await expect.poll(() => page.evaluate(() => globalThis.keel.freeCam().hud)).toBe(false);
  expect(cam.back).toBe(false);
  // The boat stays where it was.
  const held = await page.evaluate(() => globalThis.keel.boat().state);
  // 2 km off, south-west of Lime Cay, 60 m up, looking at it.
  await page.evaluate(() =>
    globalThis.keel.fly({ east: 1300, north: -1600, height: 60, bearing: 45, pitch: -6 }),
  );
  await page.waitForTimeout(1500);
  const still = await page.evaluate(() => globalThis.keel.boat().state);
  expect(Math.hypot(still.x - held.x, still.y - held.y)).toBe(0);
  // The focus is the point beneath the camera; the dome bends about it and
  // the tile field is centred on its tile: from the next frame drawn.
  await expect
    .poll(
      async () => {
        const c = await page.evaluate(() => globalThis.keel.freeCam());
        return Math.hypot(c.tiles.east - c.east, c.tiles.north - c.north);
      },
      { timeout: 20_000 },
    )
    .toBeLessThan(10);
  cam = await page.evaluate(() => globalThis.keel.freeCam());
  for (const p of [cam.focus, cam.dome, cam.tiles]) {
    expect(Math.hypot(p.east - cam.east, p.north - cam.north)).toBeLessThan(10);
  }
  expect(Math.hypot(cam.east - still.x, cam.north - still.y)).toBeGreaterThan(1000);
  // The land about the camera is handed and drawn: chunks the boat's place
  // did not draw.
  await expect
    .poll(
      async () => {
        const drawn = (await page.evaluate(() => globalThis.keel.land()))?.drawn ?? [];
        return drawn.filter((n) => !drawnAtStart.includes(n)).length;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  // The keys fly it: W held until it has moved, however slowly the
  // renderer draws its frames (CI's software one draws a few a second).
  const before = await page.evaluate(() => globalThis.keel.freeCam());
  await page.keyboard.down('KeyW');
  await expect
    .poll(
      async () => {
        const c = await page.evaluate(() => globalThis.keel.freeCam());
        return Math.hypot(c.east - before.east, c.north - before.north);
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(1);
  await page.keyboard.up('KeyW');
  // A tap shows the way back.
  await page.mouse.click(480, 300);
  await expect.poll(() => page.evaluate(() => globalThis.keel.freeCam().back)).toBe(true);
  // Escape: back on the boat, the camera behind it, the screen back.
  await page.keyboard.press('Escape');
  cam = await page.evaluate(() => globalThis.keel.freeCam());
  expect(cam.on || cam.flying || cam.stays).toBe(false);
  await expect.poll(() => page.evaluate(() => globalThis.keel.freeCam().hud)).toBe(true);
  const boat = await page.evaluate(() => globalThis.keel.boat().state);
  const eye = await page.evaluate(() => globalThis.keel.eye());
  const ahead =
    (eye.east - boat.x) * Math.sin(boat.heading) + (eye.north - boat.y) * Math.cos(boat.heading);
  expect(Math.hypot(eye.east - boat.x, eye.north - boat.y)).toBeLessThan(40);
  expect(ahead).toBeLessThan(0);
  // F flies again, and F comes back.
  await page.keyboard.press('KeyF');
  expect(await page.evaluate(() => globalThis.keel.freeCam().on)).toBe(true);
  await page.keyboard.press('KeyF');
  expect(await page.evaluate(() => globalThis.keel.freeCam().on)).toBe(false);
});
