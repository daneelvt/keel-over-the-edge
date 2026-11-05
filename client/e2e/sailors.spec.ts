// SPDX-License-Identifier: AGPL-3.0-only

// The dressing room (dev.html#sailors) on the project's back end: the test
// sailor's files load with their skin, skeleton, atlas and mask; every
// material in the room is the factory's, with the bend; and the figures are
// drawn posed by the GPU where the skeleton on the CPU says, standing on the
// quay and seated in a dinghy. The silhouettes are drawn black, so a pixel
// says whether a sailor is there: a figure drawn unposed would leave the
// places its pose takes it to empty, and cover the places it left.
//
// The clips are held at a time (t), so every picture is the same.

import { expect, type Page, test } from '@playwright/test';
import type { DressingHooks, Room } from '../src/dev/dressing';
import { decodePng, type Picture } from './helpers';

declare global {
  var dressing: DressingHooks;
}

/** A silhouette's pixel, at most; and the room behind one, at least (channels, 0–255). */
const DARK = 25;
const LIGHT = 40;

async function openRoom(page: Page, hash: string): Promise<void> {
  const project = test.info().project.name;
  const query = project === 'webgl2' ? '?backend=webgl2' : project === 'compat' ? '?compat' : '';
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // The developer page sends the browser on to the dressing room's own.
  await page.goto(`/dev.html${query}#sailors&${hash}`);
  await page.waitForURL(/\/sailors\.html/);
  await page.waitForFunction(
    () => globalThis.dressing?.ready === true || (globalThis.dressing?.error ?? '') !== '',
    null,
    { timeout: 120_000 },
  );
  expect(await page.evaluate(() => globalThis.dressing.error)).toBe('');
  const backend = await page.evaluate(() => globalThis.dressing.backend);
  test.skip(
    (project === 'webgpu' || project === 'compat') && backend !== 'webgpu',
    'this browser offers no WebGPU adapter',
  );
  test.skip(
    project === 'compat' && !(await page.evaluate(() => globalThis.dressing.compat)),
    'this browser offers no device held to compatibility mode',
  );
  expect(errors).toEqual([]);
}

/** Changes the room, draws it, and takes the picture. */
async function show(page: Page, change: Partial<Room>): Promise<Picture> {
  await page.evaluate((c) => globalThis.dressing.set(c), change);
  await page.evaluate(() => globalThis.dressing.draw());
  return decodePng(await page.locator('.dressing-stage canvas').screenshot());
}

type Points = Record<string, { x: number; y: number }>;

/** Where each figure's bones are on the stage, by figure and bone ("0:head"). */
async function bones(page: Page, names: string[]): Promise<Points> {
  return page.evaluate((names) => {
    const out: Points = {};
    globalThis.dressing.figures().forEach((_, f) => {
      for (const b of names) {
        out[`${f}:${b}`] = globalThis.dressing.project(f, b);
      }
    });
    return out;
  }, names);
}

/** The darkest of a 3 × 3 pixel's brightest channels about a point. */
function darkest(p: Picture, at: { x: number; y: number }): number {
  let least = 255;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = Math.round(at.x) + dx;
      const y = Math.round(at.y) + dy;
      const i = (y * p.width + x) * 4;
      least = Math.min(
        least,
        Math.max(p.data[i] ?? 255, p.data[i + 1] ?? 255, p.data[i + 2] ?? 255),
      );
    }
  }
  return least;
}

test('the test sailor stands and sits, skinned and posed on the GPU', async ({ page }) => {
  test.setTimeout(240_000);
  await openRoom(page, 'view=lineup&black=1&t=1&clip=rest&look=test');

  const figures = await page.evaluate(() => globalThis.dressing.figures());
  expect(figures.map((f) => `${f.look} ${f.version}`)).toEqual(['test female', 'test male']);
  for (const f of figures) {
    // The body, its eyes, the shirt and the breeches.
    expect(f).toMatchObject({ level: 'close', skinned: true, bones: 85, meshes: 4, inBoat: false });
  }
  expect(await page.evaluate(() => globalThis.dressing.problems())).toEqual([]);

  // Standing: at rest, the arms held out; in the idle, hanging. Each
  // picture has the figures where its own pose puts them, and not where
  // the other's would.
  const parts = ['head', 'pelvis', 'hand_l', 'hand_r'];
  const rest = await show(page, { clip: 'rest' });
  const atRest = await bones(page, parts);
  const idle = await show(page, { clip: 'standing-idle' });
  const atIdle = await bones(page, parts);
  for (const [name, at] of Object.entries(atRest)) {
    expect(darkest(rest, at), `${name} at rest`).toBeLessThanOrEqual(DARK);
  }
  for (const [name, at] of Object.entries(atIdle)) {
    expect(darkest(idle, at), `${name} in the idle`).toBeLessThanOrEqual(DARK);
  }
  for (const hand of ['0:hand_l', '0:hand_r', '1:hand_l', '1:hand_r']) {
    expect(
      darkest(rest, atIdle[hand] as Points[string]),
      `${hand} of the idle, at rest`,
    ).toBeGreaterThanOrEqual(LIGHT);
    expect(
      darkest(idle, atRest[hand] as Points[string]),
      `${hand} at rest, in the idle`,
    ).toBeGreaterThanOrEqual(LIGHT);
  }

  // Seated in a dinghy at the helm; and shading the eyes, the forward hand
  // at the brow, where at the helm there is only the room behind.
  const helm = await show(page, { clip: 'helm-idle', t: 1 });
  const atHelm = await bones(page, parts);
  expect((await page.evaluate(() => globalThis.dressing.figures())).every((f) => f.inBoat)).toBe(
    true,
  );
  expect(await page.evaluate(() => globalThis.dressing.problems())).toEqual([]);
  for (const [name, at] of Object.entries(atHelm)) {
    expect(darkest(helm, at), `${name} at the helm`).toBeLessThanOrEqual(DARK);
  }
  const shade = await show(page, { clip: 'shade-eyes', t: 5 });
  const atShade = await bones(page, parts);
  for (const [name, at] of Object.entries(atShade)) {
    expect(darkest(shade, at), `${name} shading the eyes`).toBeLessThanOrEqual(DARK);
  }
  for (const hand of ['0:hand_r', '1:hand_r']) {
    expect(
      darkest(helm, atShade[hand] as Points[string]),
      `${hand} shading, at the helm`,
    ).toBeGreaterThanOrEqual(LIGHT);
  }

  // With the bend: the dome's centre 150 m off, the room drops 4.5 m, and
  // the camera with it. The figures are drawn where the bend puts their
  // skinned bones; a figure the bend missed would stand 4.5 m above them,
  // out of the picture.
  await page.evaluate(() => globalThis.dressing.dome(150, 0));
  const bent = await show(page, { clip: 'standing-idle' });
  const atBent = await bones(page, parts);
  for (const [name, at] of Object.entries(atBent)) {
    expect(darkest(bent, at), `${name} on the dome`).toBeLessThanOrEqual(DARK);
  }
});

test('the atlas takes the colours chosen, on the dome', async ({ page }) => {
  test.setTimeout(240_000);
  await openRoom(page, 'view=lineup&t=1&main=9B2226&look=test');
  // The room 4.5 m down the dome, as in the first test: the sailor's own
  // material bends too.
  await page.evaluate(() => globalThis.dressing.dome(150, 0));
  await show(page, {});
  // The chest: half way from the top of the spine to the neck.
  const b = await bones(page, ['spine_03', 'neck_01']);
  const [lo, hi] = [b['0:spine_03'], b['0:neck_01']] as Points[string][];
  const at = { x: ((lo?.x ?? 0) + (hi?.x ?? 0)) / 2, y: ((lo?.y ?? 0) + (hi?.y ?? 0)) / 2 };
  const pixel = (p: Picture): number[] => {
    const i = (Math.round(at.y) * p.width + Math.round(at.x)) * 4;
    return [p.data[i] ?? 0, p.data[i + 1] ?? 0, p.data[i + 2] ?? 0];
  };
  // The shirt, madder red and then sea green, on the chest.
  const [r = 0, g = 0] = pixel(await show(page, {}));
  expect(r).toBeGreaterThan(40);
  expect(r).toBeGreaterThan(2 * g);
  const [r2 = 0, g2 = 0] = pixel(await show(page, { main: '2E7D6B' }));
  expect(g2).toBeGreaterThan(r2 + 30);
});

test('the Rover stands and sits in both versions, dressed, skinned and posed', async ({ page }) => {
  test.setTimeout(240_000);
  await openRoom(page, 'view=lineup&black=1&t=1&clip=rest&look=rover');

  const figures = await page.evaluate(() => globalThis.dressing.figures());
  expect(figures.map((f) => `${f.look} ${f.version}`)).toEqual(['rover female', 'rover male']);
  for (const f of figures) {
    // The body and eyes, hair and hat, ten garments, and the trims.
    expect(f).toMatchObject({
      level: 'close',
      skinned: true,
      bones: 85,
      meshes: 15,
      inBoat: false,
    });
  }
  expect(await page.evaluate(() => globalThis.dressing.problems())).toEqual([]);
  const parts = ['head', 'pelvis', 'hand_l', 'hand_r'];
  for (const clip of ['rest', 'standing-idle']) {
    const picture = await show(page, { clip });
    for (const [name, at] of Object.entries(await bones(page, parts))) {
      expect(darkest(picture, at), `${name}, ${clip}`).toBeLessThanOrEqual(DARK);
    }
  }
  // Seated in the boat in the clips that sit in it, either side deck (a
  // hiking sailor's head is behind the moored boat's boom).
  for (const clip of ['helm', 'helm-port', 'cross', 'climbing-in']) {
    const seated = await show(page, { clip, t: 1 });
    expect(
      (await page.evaluate(() => globalThis.dressing.figures())).every((f) => f.inBoat),
      clip,
    ).toBe(true);
    for (const [name, at] of Object.entries(await bones(page, parts))) {
      expect(darkest(seated, at), `${name}, ${clip}`).toBeLessThanOrEqual(DARK);
    }
  }
});
