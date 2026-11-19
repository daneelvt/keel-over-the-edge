// SPDX-License-Identifier: AGPL-3.0-only

// The race committee's things in the sea, in a real browser, on the
// offline sandbox on seed 1's world: a course laid ahead of the boat (the
// committee boat dressed in flags with a class's pennant at her halyard,
// the pin, three marks with their flags and numbers) draws in a few draws;
// her gun fires, its smoke rises and drifts, its report is reckoned; by
// night the marks' lanterns and her riding light are lit; and the beacon
// on Brain Coral Reef stands at its place.

import { expect, type Page, test } from '@playwright/test';
import data from '../src/catalog/catalog.gen.json' with { type: 'json' };
import { openScene } from './helpers';

/** The most draws the committee's things may add: four kinds, the numbers, the flags and the smoke. */
const DRAWS = 7;

/** The frame's draw calls, as the GPU was given them. */
async function draws(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const k = globalThis.keel;
    k.render();
    await k.show();
    return k.info().drawCalls;
  });
}

/** Draws frames until the committee's models are loaded and what is wanted is drawn. */
async function drawnWhen(page: Page, what: 'loaded' | 'beacon'): Promise<void> {
  await page.evaluate(async (what) => {
    const k = globalThis.keel;
    for (let i = 0; i < 300; i++) {
      k.render();
      const m = k.raceMarks();
      if (what === 'loaded' ? m.loaded : m.beacons > 0) {
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }, what);
}

test('a laid course draws, its gun fires with smoke, its lanterns light by night, and a beacon stands on its reef', async ({
  page,
}) => {
  test.slow();
  await openScene(page, 'world=1');
  await page.evaluate(() => {
    const k = globalThis.keel;
    k.setSky(12);
    k.render();
  });
  const before = await draws(page);
  await page.evaluate(() => globalThis.keel.layCourse(1));
  await drawnWhen(page, 'loaded');
  const after = await draws(page);
  const day = await page.evaluate(() => globalThis.keel.raceMarks());
  expect(day).toMatchObject({ committees: 1, marks: 3, pins: 1, numbers: 3, lanterns: 0 });
  // The class pennant at her halyard, a flag on each mark and the pin.
  expect(day.flags).toBe(5);
  expect(day.draws).toBeLessThanOrEqual(DRAWS);
  expect(after - before).toBeLessThanOrEqual(DRAWS);

  // The preparatory flag goes up under the pennant; the start's gun.
  const fired = await page.evaluate((boat) => {
    const k = globalThis.keel;
    const flags = k.raceSignals(1, [{ signal: 'class', boat }, { signal: 'preparatory' }]);
    k.render();
    return { flags, shown: k.raceMarks().flags, gun: k.fireGun(1, 1.6) };
  }, data.boats[0]?.id ?? '');
  expect(fired.flags.every((f) => f >= 0)).toBe(true);
  expect(fired.shown).toBe(6);
  expect(fired.gun.fired).toBe(true);
  expect(fired.gun.report?.level ?? 0).toBeGreaterThan(0);
  const smoke = await page.evaluate(() => {
    const k = globalThis.keel;
    const height = () => {
      const p = k.raceMarks().puffsAt;
      return p.reduce((s, q) => s + q.up, 0) / Math.max(p.length, 1);
    };
    k.render();
    const first = { puffs: k.raceMarks().puffs, height: height() };
    // Ten seconds on.
    k.advance(300);
    k.render();
    return { first, later: { puffs: k.raceMarks().puffs, height: height() } };
  });
  expect(smoke.first.puffs).toBeGreaterThan(0);
  expect(smoke.later.puffs).toBeGreaterThan(0);
  expect(smoke.later.height).toBeGreaterThan(smoke.first.height + 15);

  // At midnight: each mark's lantern, the pin's and her riding light.
  const night = await page.evaluate(() => {
    const k = globalThis.keel;
    k.setSky(0);
    k.render();
    return k.raceMarks().lanterns;
  });
  expect(night).toBe(5);

  // The beacon on Brain Coral Reef, south of Port Royal.
  await page.evaluate(() => {
    const k = globalThis.keel;
    k.setSky(12);
    k.dropCourse(1);
    k.placeBoat(-31.5, -3258.5, 0);
  });
  await drawnWhen(page, 'beacon');
  const reef = await page.evaluate(() => globalThis.keel.raceMarks());
  expect(reef.beacons).toBe(1);
  expect(reef.known.some((b) => Math.hypot(b.east + 91.5, b.north + 3198.5) < 1)).toBe(true);
});
