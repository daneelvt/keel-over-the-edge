// SPDX-License-Identifier: AGPL-3.0-only

// What a boat flies for its skipper's races in the world, in a real
// browser on the offline sandbox: the own boat told a winner's prizes
// flies its pennants down the forestay and its burgee at the masthead, its
// sailor wearing the cockade, its race number on the sail while it races;
// a boat of the fleet near enough flies its own and shows its number,
// one beyond the prizes' reach none; every boat's prizes cost two draws
// (their flags, their spoons), and none when nobody flies any. In the
// dressing room the cockade is pinned to a look's hat. A certificate's
// pendant hangs at the neck of the own boat's sailor, of a friend's boat's
// skipper near by and of her crew, and is taken off with the certificate's
// prize code; the dressing room hangs each of the five.

import { expect, type Page, test } from '@playwright/test';
import type { DressingHooks } from '../src/dev/dressing';
import { decodePng, openScene } from './helpers';

declare global {
  var dressing: DressingHooks;
}

/** The frame's draw calls. */
async function draws(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const k = globalThis.keel;
    k.render();
    await k.show();
    return k.info().drawCalls;
  });
}

test("a winner's boat flies her pennants to the boats in sight, and a racing boat her number", async ({
  page,
}) => {
  test.slow();
  await openScene(page);
  const before = await draws(page);
  const r = await page.evaluate(async () => {
    const k = globalThis.keel;
    const b = k.boat().state;
    const own = k.prizeCode({ pennants: [2, 4], burgee: 1, spoons: 1 });
    k.setPrizes(own, 9);
    const fleet = k.prizeCode({ pennants: [0, 1, 3], burgee: 2, committee: true });
    k.setFleet([
      {
        kind: 1,
        east: b.x + 20,
        north: b.y + 12,
        heading: 1.2,
        sail: 15,
        prizes: fleet,
        raceNumber: 12,
      },
      // Beyond the prizes' reach: nothing of hers drawn.
      { kind: 0, east: b.x + 900, north: b.y, heading: 1.2, sail: 15, prizes: fleet },
    ]);
    k.render();
    await k.fleetLoaded();
    k.render();
    return { drawn: k.prizesDrawn(), looks: k.boatLooksDrawn() };
  });
  const after = await draws(page);
  // The own boat's two pennants and burgee, the near boat's three, her
  // gilded burgee and the committee's flag; the own boat's spoon.
  expect(r.drawn).toMatchObject({
    boats: 2,
    pennants: 5,
    burgees: 2,
    committees: 1,
    spoons: 1,
    flags: 8,
  });
  expect(r.drawn.own).toMatchObject({ number: 9, cockade: true });
  expect(r.looks.own?.number).toBe(9);
  expect(r.looks.fleet.some((f) => f.kind === 1 && f.number === 12)).toBe(true);
  // The own boat's pennants hang down her forestay from under the masthead, the burgee above them.
  const up = r.drawn.heads.slice(0, 3).map((h) => h.up);
  expect(up[0] ?? 0).toBeGreaterThan(up[1] ?? 0);
  expect(up[1] ?? 0).toBeGreaterThan(up[2] ?? 0);
  // The fleet's boats, its sailors and the prizes' two draws.
  expect(after - before).toBeGreaterThan(0);
  const prizes = await page.evaluate(async () => {
    const k = globalThis.keel;
    const n = k.info().drawCalls;
    k.setPrizes(0, 0);
    k.setFleet(null);
    k.render();
    await k.show();
    return {
      with: n,
      without: k.info().drawCalls,
      drawn: k.prizesDrawn(),
      number: k.boatLooksDrawn().own?.number,
    };
  });
  expect(prizes.drawn).toMatchObject({ boats: 0, flags: 0, spoons: 0, own: { cockade: false } });
  expect(prizes.number).toBe(0);
  expect(prizes.without).toBeLessThan(prizes.with);
});

/** Gold pixels in a picture: the cockade's ribbon. */
function gold(png: Buffer): number {
  const p = decodePng(png);
  let n = 0;
  for (let i = 0; i < p.width * p.height; i++) {
    const r = p.data[4 * i] ?? 0;
    const g = p.data[4 * i + 1] ?? 0;
    const b = p.data[4 * i + 2] ?? 0;
    if (r > 150 && g > 105 && b < 90 && r - b > 100) {
      n++;
    }
  }
  return n;
}

test('the dressing room pins the cockade to a look’s hat', async ({ page }) => {
  test.slow();
  const project = test.info().project.name;
  const query = project === 'webgl2' ? '?backend=webgl2' : '';
  await page.goto(`/dev.html${query}#sailors&view=face&look=bosun&clip=rest&t=1`);
  await page.waitForURL(/\/sailors\.html/);
  await page.waitForFunction(
    () => globalThis.dressing?.ready === true || (globalThis.dressing?.error ?? '') !== '',
    null,
    { timeout: 120_000 },
  );
  expect(await page.evaluate(() => globalThis.dressing.error)).toBe('');
  test.skip(
    project === 'webgpu' && (await page.evaluate(() => globalThis.dressing.backend)) !== 'webgpu',
    'this browser offers no WebGPU adapter',
  );
  const picture = async (cockade: boolean): Promise<Buffer> => {
    await page.evaluate(async (cockade) => {
      const d = globalThis.dressing;
      await d.set({ cockade });
      d.orbit({ azimuth: 0.7 });
      d.draw();
    }, cockade);
    return page.locator('.dressing-stage canvas').screenshot();
  };
  const without = gold(await picture(false));
  const worn = gold(await picture(true));
  // A rosette a few centimetres across on each figure's scarf.
  expect(worn - without).toBeGreaterThan(40);
});

test('a certificate’s pendant at the sailor’s neck, and on a friend’s boat near by, her skipper’s and her crew’s', async ({
  page,
}) => {
  test.slow();
  await openScene(page);
  const worn = await page.evaluate(async () => {
    const k = globalThis.keel;
    const b = k.boat().state;
    k.setPrizes(k.prizeCode({ pendant: 3 }), 0);
    // A friend's keelboat near by: her skipper a Master, her crew Deckhands and a Helm.
    const kind = 1;
    const { crew } = k.fleetCrew(4, 0, 7);
    const pendants = [0, 1, 2, 1];
    k.setFleet([
      {
        kind,
        east: b.x + 14,
        north: b.y + 9,
        heading: 1.2,
        sail: 15,
        prizes: k.prizeCode({ pendant: 5 }),
        crew: { ...crew, people: crew.people.map((p, i) => ({ ...p, pendant: pendants[i] ?? 0 })) },
      },
    ]);
    await k.fleetLoaded();
    await k.fleetCrewsReady();
    for (let i = 0; i < 200 && !k.pendantsDrawn().own.drawn; i++) {
      k.render();
      await new Promise((r) => setTimeout(r, 50));
    }
    k.render();
    await k.show();
    return k.pendantsDrawn();
  });
  expect(worn.loaded).toBe(true);
  expect(worn.own).toEqual({ worn: 3, drawn: true });
  // The skipper's and those of her crew who wear one.
  expect(worn.fleet).toBe(1);
  expect(worn.crews).toBe(3);
  const off = await page.evaluate(async () => {
    const k = globalThis.keel;
    k.setPrizes(0, 0);
    k.setFleet(null);
    k.render();
    await k.show();
    return k.pendantsDrawn();
  });
  expect(off.own).toEqual({ worn: 0, drawn: false });
  expect(off.fleet).toBe(0);
});

test('the dressing room hangs each certificate’s pendant at a look’s neck', async ({ page }) => {
  test.slow();
  const project = test.info().project.name;
  const query = project === 'webgl2' ? '?backend=webgl2' : '';
  await page.goto(`/dev.html${query}#sailors&view=lineup&look=bosun&clip=rest&t=1`);
  await page.waitForURL(/\/sailors\.html/);
  await page.waitForFunction(
    () => globalThis.dressing?.ready === true || (globalThis.dressing?.error ?? '') !== '',
    null,
    { timeout: 120_000 },
  );
  expect(await page.evaluate(() => globalThis.dressing.error)).toBe('');
  for (const n of [1, 2, 3, 4, 5, 0]) {
    const worn = await page.evaluate(async (n) => {
      await globalThis.dressing.set({ pendant: n });
      return globalThis.dressing.pendants();
    }, n);
    // Her and him alike.
    expect(worn).toEqual([n, n]);
  }
});
