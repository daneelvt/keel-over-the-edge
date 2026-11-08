// SPDX-License-Identifier: AGPL-3.0-only

// Sailing in a real browser, on each back end: the page steps the physics
// module and gets the module's own bits; two thumbs sail at once; the
// keyboard steers; the boat capsizes and the sailor rights it; a frame the
// cap skips leaves the picture; every new material is the factory's; the
// pictures match their references; sound starts on a tap and stops while
// the page is hidden; and the frame allocates nothing that stays, with the
// sea's birds in view.

import { readFileSync } from 'node:fs';
import { type CDPSession, expect, type Page, test } from '@playwright/test';
import type { BoatPhysics, Weather, World } from '../src/catalog/types.gen';
import { quantiseHelm, quantiseSheet } from '../src/input/quantise';
import { toHex } from '../src/predict/golden';
import { RECORDS } from '../src/predict/layout.gen';
import { startSandbox } from '../src/sandbox/sandbox';
import { decodePng, openScene, picture, pictureDifference } from './helpers';

const catalog = JSON.parse(
  readFileSync(new URL('../src/catalog/catalog.gen.json', import.meta.url), 'utf8'),
) as { boats: { physics: BoatPhysics }[]; weather: Weather; world: World };
const wasm = readFileSync(new URL('../src/predict/physics.wasm', import.meta.url));

test('the boat gains speed on a beam reach, with the module’s own bits', async ({ page }) => {
  await openScene(page);
  const browser = await page.evaluate(() => {
    const k = globalThis.keel;
    k.setControls(0, 0.3);
    const before = k.boat().state.surge;
    k.advance(300);
    return { before, after: k.boat(), bits: k.stateBits() };
  });
  expect(browser.before).toBe(0);
  // Ten seconds from rest on a beam reach in 10 knots.
  expect(browser.after.out.speedOverGround).toBeGreaterThan(1.5);
  expect(browser.after.steps).toBeGreaterThanOrEqual(300);

  // The same sail in the module under Node.
  const boat = catalog.boats[0];
  if (boat === undefined) {
    throw new Error('no boat');
  }
  // As the page began: time held at 100 s, the boat back at the start and
  // laid on the sea of that time; then each step at the clock's next.
  const s = await startSandbox(wasm, boat.physics, catalog.weather, catalog.world);
  const clock = { steps: 100 * 30 };
  s.clock = clock;
  s.reset();
  s.floatAt(clock.steps);
  for (let i = 0; i < 300; i++) {
    s.step(quantiseHelm(0), quantiseSheet(0.3));
    clock.steps++;
  }
  const node = Object.fromEntries(
    Object.entries(RECORDS.state).map(([k, i]) => [k, toHex(s.states.current[i] ?? 0)]),
  );
  expect(browser.bits).toEqual(node);
});

/** Touches through the DevTools protocol, so two fingers can be down at once. */
async function touch(
  cdp: CDPSession,
  type: 'touchStart' | 'touchMove' | 'touchEnd',
  points: { x: number; y: number; id: number }[],
): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : points,
  });
}

async function centre(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).boundingBox();
  if (box === null) {
    throw new Error(`${selector} is not on screen`);
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true });

  test('two thumbs move the helm and the sheet at once', async ({ page }) => {
    await openScene(page, '', true);
    const cdp = await page.context().newCDPSession(page);
    const helm = await centre(page, '[data-control=helm]');
    const sheet = await centre(page, '[data-control=sheet]');
    const before = await page.evaluate(() => globalThis.keel.boat());
    await touch(cdp, 'touchStart', [
      { ...helm, id: 1 },
      { ...sheet, id: 2 },
    ]);
    for (let i = 1; i <= 5; i++) {
      await touch(cdp, 'touchMove', [
        { x: helm.x + i * 10, y: helm.y, id: 1 },
        { x: sheet.x, y: sheet.y - i * 8, id: 2 },
      ]);
    }
    await touch(cdp, 'touchEnd', []);
    const after = await page.evaluate(() => {
      const k = globalThis.keel;
      const set = k.boat();
      k.advance(90);
      return { set, sailed: k.boat() };
    });
    // 50 px right on the helm: to starboard; 40 px up the sheet: hauled in.
    expect(after.set.helm).toBeCloseTo(before.helm + (2 * 50) / 140, 6);
    expect(after.set.sheet).toBeCloseTo(before.sheet - 40 / 160, 6);
    expect(after.sailed.state.heading).not.toBeCloseTo(before.state.heading, 2);
    expect(after.sailed.state.boom).not.toBeCloseTo(before.state.boom, 2);
  });
});

test('a held key turns the boat, and C centres the helm', async ({ page }) => {
  await openScene(page, '', true);
  // Under way on a beam reach, where the rudder bites.
  await page.evaluate(() => {
    const k = globalThis.keel;
    k.setState({ surge: 3, sheetLimit: 0.5 });
    k.setControls(0, 0.3);
    k.thaw();
  });
  await page.keyboard.down('ArrowRight');
  await page.evaluate(() => globalThis.keel.frames(20));
  await page.keyboard.up('ArrowRight');
  // How far the boat turns in 1.5 s with the helm the key left, however
  // long the browser took to draw those frames.
  const held = await page.evaluate(() => {
    const k = globalThis.keel;
    k.freeze(200);
    const before = k.boat();
    k.advance(45);
    let turn = (k.boat().state.heading - before.state.heading) % (2 * Math.PI);
    if (turn > Math.PI) {
      turn -= 2 * Math.PI;
    } else if (turn <= -Math.PI) {
      turn += 2 * Math.PI;
    }
    return { helm: before.helm, turn };
  });
  expect(held.helm).toBeGreaterThan(0.1);
  // Turning to starboard: the heading grows.
  expect(held.turn).toBeGreaterThan(0.05);
  await page.keyboard.press('c');
  expect(await page.evaluate(() => globalThis.keel.boat().helm)).toBe(0);
});

test('sheeted hard in on a reach in 20 knots, the boat capsizes and is sailed again', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openScene(page, '', true);
  // The golden capsize scenario's start and controls.
  const over = await page.evaluate(() => {
    const k = globalThis.keel;
    k.setWind(20, 0);
    k.setState({ heading: 1.5708, surge: 3, sheetLimit: 0.6 });
    k.setControls(0, 0.4);
    k.script('steer', 1.5708);
    k.advance(150);
    k.setControls(0, 0);
    for (let i = 0; i < 60; i++) {
      k.advance(30);
      if (k.boat().state.sailorMode !== 0) {
        break;
      }
    }
    k.render();
    return k.boat();
  });
  expect(over.state.sailorMode).not.toBe(0);
  expect(Math.abs(over.state.heel)).toBeGreaterThan(1.2);
  await expect(page.locator('[data-readout=sailor]')).toBeVisible();
  await expect(page.locator('[data-control=helm]')).toHaveClass(/dimmed/);
  await expect(page.locator('[data-control=sheet]')).toHaveClass(/dimmed/);

  const back = await page.evaluate(() => {
    const k = globalThis.keel;
    // The sailor will come back to a sheet let fly.
    k.script(null);
    k.setControls(0, 1);
    for (let i = 1; i <= 45; i++) {
      k.advance(30);
      if (k.boat().state.sailorMode === 0) {
        k.render();
        return i;
      }
    }
    return -1;
  });
  expect(back).toBeGreaterThan(0);
  expect(back).toBeLessThanOrEqual(45);
  await expect(page.locator('[data-readout=sailor]')).toHaveCount(0);
  await expect(page.locator('[data-control=helm]')).not.toHaveClass(/dimmed/);
});

test('the sailor holds the tiller extension at the helm, and crosses the boat when its side changes', async ({
  page,
}) => {
  await openScene(page);
  const r = await page.evaluate(() => {
    const k = globalThis.keel;
    const seen: { side: number; crossing: boolean; tiller: boolean; hold: number; ext: number }[] =
      [];
    const look = (): void => {
      const s = k.sailor();
      if (s !== null) {
        seen.push({
          side: s.side,
          crossing: s.crossing,
          tiller: s.tiller,
          hold: s.hold,
          ext: s.extension,
        });
      }
    };
    // In a calm and upright, to windward on starboard, the boom out to port:
    // until any cross the page began with has ended there.
    k.setWind(0.5, 0);
    for (let f = 0; f < 400; f++) {
      k.setState({ sailor: 0.6, boom: -0.5, heel: 0, sailorMode: 0 });
      k.sailFrames(1, 1);
      const s = k.sailor();
      if (f > 30 && s !== null && s.side === 1 && !s.crossing) {
        break;
      }
    }
    look();
    const before = seen.at(-1);
    seen.length = 0;
    // The boom over to starboard and the sailor to port: a tack's cross.
    for (let f = 0; f < 150; f++) {
      k.setState({ sailor: -0.6, boom: 0.5, heel: 0, sailorMode: 0 });
      k.sailFrames(1, 1);
      look();
    }
    return { before, after: seen.at(-1), crossed: seen.some((x) => x.crossing), seen };
  });
  expect(r.before?.side).toBe(1);
  expect(r.before?.tiller).toBe(true);
  expect(r.crossed).toBe(true);
  expect(r.after?.side).toBe(-1);
  expect(r.after?.tiller).toBe(true);
  // The hand on the extension, never beyond its end.
  for (const s of r.seen.filter((x) => x.tiller)) {
    expect(s.hold).toBeLessThanOrEqual(s.ext + 1e-3);
  }
});

test('a machine sailor’s boat carries its machine, which sails as a sailor does, its lamps pulsing', async ({
  page,
}) => {
  await openScene(page);
  const r = await page.evaluate(async () => {
    const k = globalThis.keel;
    const person = k.sailor();
    await k.machineAboard(true);
    k.setWind(0.5, 0);
    const glow: number[] = [];
    let crossed = false;
    for (let f = 0; f < 400; f++) {
      k.setState({
        sailor: f < 200 ? 0.6 : -0.6,
        boom: f < 200 ? -0.5 : 0.5,
        heel: 0,
        sailorMode: 0,
      });
      k.sailFrames(1, 1);
      const s = k.sailor();
      glow.push(s?.glow ?? 0);
      crossed ||= s?.crossing === true;
    }
    const machine = k.sailor();
    await k.machineAboard(false);
    return { person, machine, crossed, glow, after: k.sailor() };
  });
  expect(r.person?.machine).toBe(false);
  expect(r.machine?.machine).toBe(true);
  expect(r.machine?.tiller).toBe(true);
  expect(r.machine?.side).toBe(-1);
  expect(r.crossed).toBe(true);
  expect(Math.min(...r.glow)).toBeGreaterThanOrEqual(0.7);
  expect(Math.max(...r.glow) - Math.min(...r.glow)).toBeGreaterThan(0.05);
  // Back to a person's boat, the person is aboard again.
  expect(r.after?.machine).toBe(false);
});

test('capsized, the sailor treads water off the high side, clear of the hull', async ({ page }) => {
  await openScene(page);
  const at = await page.evaluate(() => {
    const k = globalThis.keel;
    k.setState({ heel: (85 * Math.PI) / 180, sailorMode: 1, sailorTimer: 8 });
    k.sailFrames(10, 1);
    return k.sailor()?.at ?? null;
  });
  // Heeled to starboard, the high side is port: in the water there, out
  // beyond the hull's bottom (the place in the heeled model, turned back
  // level about the heel's pivot at the centre of gravity, 0.3 m up).
  const heel = (85 * Math.PI) / 180;
  const [x, y] = [at?.[0] ?? 0, (at?.[1] ?? 0) - 0.3];
  expect(x * Math.cos(heel) + y * Math.sin(heel)).toBeLessThan(-0.6);
});

test('a frame the cap skips leaves the last picture on screen', async ({ page }) => {
  await openScene(page, 'sea=fresh');
  const drawn = await picture(page);
  // Draw only every thousandth animation frame from here on, with the scene running.
  await page.evaluate(() => {
    globalThis.keel.capFrames(1000);
    globalThis.keel.world.stage.freeze(false);
  });
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(150);
    const shot = decodePng(await page.locator('canvas.scene').screenshot());
    expect(pictureDifference(drawn, shot)).toBeLessThan(0.5);
  }
});

test('every new material is the factory’s, with the bend', async ({ page }) => {
  await openScene(page);
  const problems = await page.evaluate(() => {
    const k = globalThis.keel;
    k.settings({ windOverlay: true, forcesOverlay: true });
    k.advance(30);
    k.render();
    return k.checkScene();
  });
  expect(problems).toEqual([]);
});

test('sound starts on a tap and stops while the page is hidden', async ({ page }) => {
  await openScene(page, '', true);
  expect(await page.evaluate(() => globalThis.keel.soundState())).toBe('none');
  await page.mouse.click(480, 200);
  await page.waitForFunction(() => globalThis.keel.soundState() === 'running');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => globalThis.keel.soundState() === 'suspended');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => globalThis.keel.soundState() === 'running');
});

test.describe('pictures', () => {
  test('heeled 20° on a reach, with the overlays', async ({ page }) => {
    await openScene(page);
    await page.evaluate(async () => {
      const k = globalThis.keel;
      k.settings({ windOverlay: true, forcesOverlay: true });
      k.setWind(12, 0);
      k.setControls(0, 0.3);
      k.setState({ heading: 1.5708, surge: 3, sheetLimit: 0.75, boom: 0.75 });
      k.advance(1);
      k.setState({ heel: (20 * Math.PI) / 180, heading: 1.5708, boom: 0.75, sailor: -0.9 });
      k.render();
      k.camera('chase');
      await k.show();
    });
    await expect(page.locator('canvas.scene')).toHaveScreenshot('heeled-overlays.png');
  });

  test('a machine sailor’s boat from astern, at play size', async ({ page }) => {
    await openScene(page);
    await page.evaluate(async () => {
      const k = globalThis.keel;
      await k.machineAboard(true);
      k.setSky(12);
      k.setWind(8, 0);
      k.setState({ heading: 1.5708, surge: 2, boom: -0.6, sailor: 0.6, heel: 0.1 });
      k.advance(1);
      k.setState({ heading: 1.5708, boom: -0.6, sailor: 0.6, heel: 0.1 });
      k.render();
      k.camera('chase');
      await k.show();
    });
    await expect(page.locator('canvas.scene')).toHaveScreenshot('machine-astern.png');
  });

  test('capsized', async ({ page }) => {
    await openScene(page);
    await page.evaluate(async () => {
      const k = globalThis.keel;
      k.setWind(20, 0);
      k.setState({ heading: 1.5708, surge: 0.5, sheetLimit: 1.2, boom: 1.1 });
      k.advance(1);
      k.setState({
        heel: (88 * Math.PI) / 180,
        heading: 1.5708,
        boom: 1.1,
        sailorMode: 1,
        sailorTimer: 4,
      });
      k.render();
      k.camera('aboard');
      await k.show();
    });
    await expect(page.locator('canvas.scene')).toHaveScreenshot('capsized.png');
  });
});

// Tagged @long: it takes minutes on CI's SwiftShader, so pr.render runs it in
// a job of its own.
test('the frame allocates nothing that stays, sailing with the controls moving', {
  tag: '@long',
}, async ({ page }) => {
  // What the heap keeps does not depend on the picture's size, and a small
  // one keeps SwiftShader's CPU rendering inside the time. A frame there
  // costs about the same whatever the size, though: about 0.23 s in an x86
  // container at 4 CPUs, and up to twice that on CI's runners. So the test
  // sails as few frames as show the heap level, 1,100: 4 to 8 minutes.
  test.setTimeout(720_000);
  await page.setViewportSize({ width: 160, height: 100 });
  await openScene(page, 'sea=gale');
  const cdp = await page.context().newCDPSession(page);
  const used = async (): Promise<number> => {
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    return (await cdp.send('Runtime.getHeapUsage')).usedSize;
  };
  // The sea's life in view the whole while: a group of each kind about
  // the boat, the birds further out and the life in the water close by,
  // those that stay over a patch staying minutes.
  const kinds = (
    catalog as unknown as { life: { kinds: { id: string; form: string }[] } }
  ).life.kinds.map((k) => ({ id: k.id, near: k.form !== 'bird' }));
  await page.evaluate(async (kinds) => {
    const k = globalThis.keel;
    for (const [n, { id, near }] of kinds.entries()) {
      const r = near ? 30 : 80;
      k.raiseLife(id, r * Math.sin(n), r * Math.cos(n), true);
    }
    k.settings({ windOverlay: true, forcesOverlay: true });
    k.script('wiggle');
    k.thaw();
    // The first 600 frames grow the heap by about 2.4 MB, as the hot paths
    // are compiled and caches fill, the last of it a step of about 360 KB
    // between frames 500 and 600; after them it grows by under 50 KB in a
    // hundred frames, less and less. Measured over the 400 frames after
    // 700, it grew 92 to 119 KB.
    await k.frames(700);
  }, kinds);
  const life = await page.evaluate(() => globalThis.keel.life());
  expect(life.birds).toBeGreaterThan(0);
  expect(life.swimmers).toBeGreaterThan(0);
  const before = await used();
  await page.evaluate(() => globalThis.keel.frames(400));
  const after = await used();
  const steps = await page.evaluate(() => globalThis.keel.boat().steps);
  expect(steps).toBeGreaterThan(3000 + 500);
  expect(after - before).toBeLessThan(256 * 1024);
});
