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
import { openScene, type Picture, picture } from './helpers';

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

/** Whether a pixel is the tag's gold. */
function gold(p: Picture, x: number, y: number): boolean {
  const i = (y * p.width + x) * 4;
  const r = p.data[i] ?? 0;
  const g = p.data[i + 1] ?? 0;
  const b = p.data[i + 2] ?? 0;
  return r > 170 && g > 120 && b < 140 && r - b > 70;
}

test('the next mark’s number stands in the sea over its spar, behind the sail', async ({
  page,
}) => {
  test.slow();
  await openScene(page, 'world=1&boat=skiff');
  await page.evaluate(() => {
    const k = globalThis.keel;
    k.setSky(12);
    k.raceTell({ start: 1 });
    k.racePicture([{ place: 1, leg: 1 }]);
  });
  await drawnWhen(page, 'loaded');
  // Sailing for mark 1, 150 m off, the sheet eased; the camera low astern,
  // turned until the tag stands behind the sail, a little out from the mast
  // on the side the boom is out to.
  const at = await page.evaluate(() => {
    const k = globalThis.keel;
    const m = k.raceMarks().laid[0]?.marks.find((x) => x.number === 1) ?? { east: 0, north: 0 };
    const hd = 1.2;
    k.placeBoat(m.east - Math.sin(hd) * 150, m.north - Math.cos(hd) * 150, hd);
    k.setControls(0, 0.9);
    k.advance(120);
    const side = Math.sign(k.world.pose.boom) || 1;
    let best: { azimuth: number; x: number; y: number; off: number } | null = null;
    for (let a = -0.6; a <= 0.6; a += 0.01) {
      k.camera({ azimuth: a, elevation: 0.08, distance: 12 });
      k.render();
      const t = k.worldOnScreen(m.east, m.north, 8);
      const mast = k.worldOnScreen(k.world.pose.east, k.world.pose.north, 3);
      if (t === null || mast === null) {
        continue;
      }
      const off = Math.abs(t.x - (mast.x + side * 30));
      if (best === null || off < best.off) {
        best = { azimuth: a, x: t.x, y: t.y, off };
      }
    }
    if (best !== null) {
      k.camera({ azimuth: best.azimuth, elevation: 0.08, distance: 12 });
      k.render();
    }
    return { best, tag: k.raceMarks().tag, html: k.course().tag };
  });
  // Drawn in the sea, not a tag over it.
  expect(at.tag).toBe(1);
  expect(at.html).toBeNull();
  expect(at.best?.off ?? 99).toBeLessThan(4);
  const seen = await picture(page);
  await page.evaluate(() => globalThis.keel.showOwnBoat(false));
  const bare = await picture(page);
  await page.evaluate(() => globalThis.keel.showOwnBoat(true));
  // The tag's pixels, where its foot is: the pill stands on it.
  const x0 = Math.round(at.best?.x ?? 0);
  const y0 = Math.round(at.best?.y ?? 0);
  let tag = 0;
  let covered = 0;
  for (let y = Math.max(y0 - 30, 0); y <= Math.min(y0 + 4, bare.height - 1); y++) {
    for (let x = Math.max(x0 - 40, 0); x <= Math.min(x0 + 40, bare.width - 1); x++) {
      if (gold(bare, x, y)) {
        tag++;
        if (!gold(seen, x, y)) {
          covered++;
        }
      }
    }
  }
  // The bare sea shows the tag; the sail before it hides it.
  expect(tag).toBeGreaterThan(20);
  expect(covered).toBeGreaterThan(tag * 0.8);
});
