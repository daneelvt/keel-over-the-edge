// SPDX-License-Identifier: AGPL-3.0-only

// Boats meeting, in a real browser on each back end, through the test
// hooks: the right-of-way overlay marks the boats that will come close,
// with the ring and bar over one the player must keep clear of and the
// diamond over one that must keep clear of the player, each labelled with
// its Article, and the player's tack beside the readout; the wind overlay
// lays dirty air along each sail's apparent wind; a bump shakes the camera
// once, a third as much under reduced motion, and says its verdict under
// the readout; and every new material passes the scene's walk with the bend.

import { expect, type Page, test } from '@playwright/test';
import { openScene } from './helpers';

const DEG = Math.PI / 180;

/** An angle brought into [−π, π). */
function wrap(a: number): number {
  return a - 2 * Math.PI * Math.floor(a / (2 * Math.PI) + 0.5);
}

/** The player on a beam reach east in 12 knots from the north: port tack. */
async function reaching(page: Page): Promise<void> {
  await page.evaluate(() => {
    const k = globalThis.keel;
    k.setWind(12, 0);
    k.placeBoat(200, 300);
    k.setState({ heading: Math.PI / 2, surge: 2.5, boom: 1.0, sheetLimit: 1.0 });
    k.setControls(0, 0.55);
    // A few steps, so the boat's own motion is known to what it draws.
    k.advance(3);
    k.freeze(10);
  });
}

/** Draws frames until the overlay has judged: it does so four times a second. */
async function settle(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => globalThis.keel.render());
    await page.waitForTimeout(300);
  }
  await page.evaluate(() => globalThis.keel.render());
}

test.describe('the right-of-way overlay', () => {
  test('marks the boats that will come close, by the Articles', async ({ page }) => {
    await openScene(page, '', true);
    await reaching(page);
    await page.evaluate((deg) => {
      const k = globalThis.keel;
      k.settings({ rightOfWay: true });
      k.setFleet([
        // Starboard tack, close-hauled, crossing from ahead: the player keeps clear.
        { east: 214, north: 296, heading: -45 * deg, boom: -0.2, speed: 2 },
        // Far off: no mark.
        { east: 260, north: 360, heading: Math.PI / 2, boom: 1.0, speed: 2.5 },
        // On port tack too, overlapped to windward and converging: it keeps clear.
        { east: 200.5, north: 303, heading: 100 * deg, boom: 1.0, speed: 2.6 },
      ]);
    }, DEG);
    await settle(page);
    const e = await page.evaluate(() => globalThis.keel.encounters());
    const marks = e.marks.map((m) => ({ slot: m.slot, kind: m.kind, article: m.article }));
    expect(marks).toContainEqual({ slot: 0, kind: 'keep-clear', article: '10' });
    expect(marks).toContainEqual({ slot: 2, kind: 'right-of-way', article: '11' });
    expect(marks.find((m) => m.slot === 1)).toBeUndefined();
    expect(e.labels).toContain('Keep clear · Article 10');
    expect(e.labels).toContain('Right of way · Article 11');
    expect(e.tack).toBe('Port tack');
    await expect(page.locator('[data-readout="tack"]')).toHaveText('Port tack');
    // The marks and the wedges are the factory's materials, with the bend.
    await page.evaluate(() => globalThis.keel.settings({ windOverlay: true }));
    await settle(page);
    expect(await page.evaluate(() => globalThis.keel.checkScene())).toEqual([]);
    // Off, nothing is marked and no tack is shown.
    await page.evaluate(() => globalThis.keel.settings({ rightOfWay: false }));
    await settle(page);
    const off = await page.evaluate(() => globalThis.keel.encounters());
    expect(off.marks).toEqual([]);
    expect(off.labels).toEqual([]);
    await expect(page.locator('[data-readout="tack"]')).toHaveCount(0);
  });
});

test.describe('dirty air', () => {
  test('lies along each sail’s apparent wind, not the true wind', async ({ page }) => {
    await openScene(page);
    await reaching(page);
    await page.evaluate(() => {
      const k = globalThis.keel;
      k.settings({ windOverlay: true, rightOfWay: false });
      k.setFleet([{ east: 230, north: 300, heading: Math.PI / 2, boom: 1.0, speed: 2.5 }]);
    });
    await settle(page);
    const e = await page.evaluate(() => globalThis.keel.encounters());
    expect(e.wedges).toBe(2);
    for (const a of e.axes) {
      // Wind from the north at 12 knots, the boat east at 2.5 m/s: the air
      // it feels moves south and west, turned a few degrees more toward
      // its windward side, the north, by its sail.
      const air = Math.atan2(-2.5, -12 * (1852 / 3600));
      const axis = Math.atan2(a.east, a.north);
      const off = Math.abs(wrap(axis - air)) / DEG;
      expect(off).toBeLessThan(12);
      // And not along the true wind, which blows due south.
      expect(Math.abs(wrap(axis - Math.PI)) / DEG).toBeGreaterThan(8);
    }
    await page.evaluate(() => globalThis.keel.settings({ windOverlay: false }));
    await settle(page);
    expect((await page.evaluate(() => globalThis.keel.encounters())).wedges).toBe(0);
  });
});

test.describe('a bump', () => {
  test('shakes the camera once and says its verdict', async ({ page }) => {
    await openScene(page, '', true);
    await reaching(page);
    await page.evaluate(() =>
      globalThis.keel.bump({
        tick: 300,
        east: 201,
        north: 300,
        closing: 2,
        part: 'yours',
        article: '10',
      }),
    );
    await page.evaluate(() => globalThis.keel.render());
    const e = await page.evaluate(() => globalThis.keel.encounters());
    expect(e.bumps).toBe(1);
    expect(e.shake).toBeGreaterThan(0.05);
    expect(e.bump).toBe('Bump · port tack keeps clear of starboard (Article 10) · yours');
    await expect(page.locator('[data-readout="bump"]')).toHaveText(e.bump);
    // A bump only seen, between two other boats: no verdict.
    await page.evaluate(() =>
      globalThis.keel.bump({
        tick: 400,
        east: 220,
        north: 300,
        closing: 1,
        part: 'seen',
        article: '',
      }),
    );
    const seen = await page.evaluate(() => globalThis.keel.encounters());
    expect(seen.bumps).toBe(2);
    expect(seen.bump).toBe(e.bump);
  });

  test('shakes a third as much under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openScene(page, '', true);
    await reaching(page);
    await page.evaluate(() =>
      globalThis.keel.bump({
        tick: 300,
        east: 201,
        north: 300,
        closing: 2,
        part: 'theirs',
        article: '11',
      }),
    );
    const e = await page.evaluate(() => globalThis.keel.encounters());
    expect(e.shake).toBeCloseTo(0.1 / 3, 6);
    expect(e.bump).toBe('Bump · windward keeps clear of leeward (Article 11) · theirs');
  });
});
