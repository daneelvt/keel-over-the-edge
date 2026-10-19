// SPDX-License-Identifier: AGPL-3.0-only

// The world's end, staged in the sandbox by the time left: nothing a minute
// out; then the falls heard and the mist closing in, the sea whole; from
// twenty seconds the near sea breaking away, the far edge first, its slabs
// falling; at the end the screen the mist, with its words; the new world
// rising out of it. It is drawing alone: the boat sails the same under it.

import { expect, type Page, test } from '@playwright/test';
import { openScene, picture, pictureDifference } from './helpers';

const stage = (page: Page, seconds: number | null, rising: number | null = null) =>
  page.evaluate(([s, r]) => globalThis.keel.worldEnd(s, r), [seconds, rising] as const);

const veil = (page: Page) =>
  page.evaluate(() => {
    const f = document.querySelector<HTMLElement>('.edge-fade');
    return {
      opacity: Number(f?.style.opacity ?? '0'),
      words: f?.classList.contains('world-end') === true,
      text: f?.querySelector('p')?.textContent ?? '',
    };
  });

test.describe('the world’s end, staged', () => {
  test.beforeEach(async ({ page }) => {
    await openScene(page);
    await page.evaluate(() => {
      globalThis.keel.setSky(12);
      globalThis.keel.camera('high');
    });
  });

  test('a minute out, nothing; then the roar and the mist, the sea whole; then the sea breaking away, the far edge first', async ({
    page,
  }) => {
    // Low over the sea, where the mist shows.
    await page.evaluate(() => globalThis.keel.camera('sea'));
    const none = await stage(page, null);
    expect(none).toEqual({ sound: 0, mist: 0, cut: null, veil: 0, slabs: 0 });
    const before = await picture(page);
    const fifty = await stage(page, 25);
    expect(fifty.sound).toBeGreaterThan(0);
    expect(fifty.mist).toBeGreaterThan(0);
    expect(fifty.cut).toBeNull();
    expect(fifty.slabs).toBe(0);
    const misted = await picture(page);
    expect(pictureDifference(before, misted)).toBeGreaterThan(1);
    const fifteen = await stage(page, 15);
    expect(fifteen.cut).toBeCloseTo(90, 6);
    expect(fifteen.slabs).toBeGreaterThan(100);
    const five = await stage(page, 5);
    expect(five.cut).toBeCloseTo(30, 6);
    // The mist over everything, thick now, but no words yet.
    const v5 = await veil(page);
    expect(v5.opacity).toBeGreaterThan(0.4);
    expect(v5.words).toBe(false);
    await stage(page, null);
  });

  test('at the end the screen is the mist, with its words; the new world rises out of it', async ({
    page,
  }) => {
    const end = await stage(page, 0);
    expect(end.veil).toBe(1);
    expect(end.cut).toBe(0);
    const v = await veil(page);
    expect(v).toEqual({ opacity: 1, words: true, text: 'The falls take the world' });
    // A new world, two seconds after its Welcome: half risen.
    const rising = await stage(page, null, 2);
    expect(rising.veil).toBe(0);
    const half = await veil(page);
    expect(half.opacity).toBeGreaterThan(0.2);
    expect(half.opacity).toBeLessThan(0.8);
    await stage(page, null, 10);
    expect(await veil(page)).toMatchObject({ opacity: 0, words: false });
  });

  test('the boat sails the same under it', async ({ page }) => {
    const sail = async (seconds: number | null) => {
      await page.evaluate(() => {
        globalThis.keel.freeze(1000);
        globalThis.keel.reset();
      });
      await stage(page, seconds);
      await page.evaluate(() => {
        globalThis.keel.script('steer', 1);
        globalThis.keel.sailFrames(45, 2);
        globalThis.keel.script(null);
      });
      return page.evaluate(() => globalThis.keel.stateBits());
    };
    const plain = await sail(null);
    const staged = await sail(8);
    expect(staged).toEqual(plain);
    await stage(page, null);
  });
});
