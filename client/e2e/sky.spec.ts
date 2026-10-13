// SPDX-License-Identifier: AGPL-3.0-only

// The sky, day and night, in the offline sandbox: each named star drawn by
// the GPU where the physics module's rule and the camera put it, from the
// centre, half way and the rim; the stars by the hour; the light of the
// hour on the sea and the boat; looking up and tapping a star; the
// lanterns' arcs; the draw calls by night; and pictures of the hours.

import { expect, type Page, test } from '@playwright/test';
import { openScene, type Picture, picture } from './helpers';

/** Places on the disk, metres east and north: the centre, half way and the rim. */
const PLACES: Record<string, [number, number]> = {
  centre: [0, 0],
  'half way': [0, 4167],
  rim: [5000, -6667],
};

/** Night at all three places: the sun 25° or more below the horizon. */
const NIGHT_HOURS = [20.5, 23, 1, 3.5];

/** The brightest pixel's channels within r pixels of (x, y). */
function around(p: Picture, x: number, y: number, r: number) {
  let red = 0;
  let green = 0;
  let white = 0;
  for (let j = Math.round(y) - r; j <= Math.round(y) + r; j++) {
    for (let i = Math.round(x) - r; i <= Math.round(x) + r; i++) {
      if (i < 0 || j < 0 || i >= p.width || j >= p.height) {
        continue;
      }
      const o = (j * p.width + i) * 4;
      const [cr, cg, cb] = [p.data[o] ?? 0, p.data[o + 1] ?? 0, p.data[o + 2] ?? 0];
      red = Math.max(red, cr - Math.max(cg, cb));
      green = Math.max(green, cg - Math.max(cr, cb));
      white = Math.max(white, Math.min(cr, cg, cb));
    }
  }
  return { red, green, white };
}

/** The mean of a picture's channels over rows from y0 to y1, 0 to 255. */
function meanRows(p: Picture, y0: number, y1: number): number {
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < p.width; x++) {
      const o = (y * p.width + x) * 4;
      sum += (p.data[o] ?? 0) + (p.data[o + 1] ?? 0) + (p.data[o + 2] ?? 0);
      n += 3;
    }
  }
  return sum / n;
}

async function starsWithin(page: Page, place: [number, number], hours: number[]) {
  return page.evaluate(
    async ({ place, hours }) => {
      const k = globalThis.keel;
      k.placeBoat(place[0], place[1]);
      const worst: { star: string; hour: number; off: number }[] = [];
      let checked = 0;
      for (const hour of hours) {
        k.setSky(hour);
        for (const s of k.namedStars()) {
          if (s.height <= 5) {
            continue;
          }
          const off = await k.starOffset(s.name);
          checked++;
          if (off === null || off > 0.1) {
            worst.push({ star: s.name, hour, off: off ?? Number.NaN });
          }
        }
      }
      return { checked, worst };
    },
    { place, hours },
  );
}

test.describe('the stars stand where the rule puts them', () => {
  test('each named star above 5°, from the centre and the rim, at an hour of the night', async ({
    page,
  }) => {
    await openScene(page);
    for (const name of ['centre', 'rim']) {
      const r = await starsWithin(page, PLACES[name] as [number, number], [23]);
      expect(r.worst, name).toEqual([]);
      expect(r.checked, name).toBeGreaterThanOrEqual(8);
    }
  });

  test('each named star above 5°, from three places, at four hours of the night', {
    tag: '@long',
  }, async ({ page }) => {
    // Nearly two hundred stars, each drawn and read back: minutes on CI's
    // software WebGPU.
    test.setTimeout(300_000);
    await openScene(page);
    const counts: Record<string, number> = {};
    for (const [name, place] of Object.entries(PLACES)) {
      const r = await starsWithin(page, place, NIGHT_HOURS);
      expect(r.worst, name).toEqual([]);
      expect(r.checked, name).toBeGreaterThanOrEqual(30);
      counts[name] = r.checked;
    }
    test.info().annotations.push({ type: 'measured', description: JSON.stringify(counts) });
  });

  test('the stars do not move when the floating origin does', async ({ page }) => {
    await openScene(page);
    const offsets = await page.evaluate(async () => {
      const k = globalThis.keel;
      k.setSky(23);
      const before = await k.starOffset('Vega');
      k.setOrigin(3, -2);
      k.render();
      const after = await k.starOffset('Vega');
      return { before, after, origin: k.info().origin };
    });
    expect(offsets.origin.east).not.toBe(0);
    expect(offsets.before).not.toBeNull();
    expect(Math.abs((offsets.after ?? 1) - (offsets.before ?? 0))).toBeLessThan(0.005);
  });
});

test('no star by day, the brightest at −4°, all at night; one draw for the stars', async ({
  page,
}) => {
  await openScene(page);
  const sky = await page.evaluate(async () => {
    const k = globalThis.keel;
    // The scene is drawn once an animation frame: show() waits for one.
    const at = async (hour: number) => {
      k.setSky(hour);
      const s = k.sky();
      k.drawSky(false);
      await k.show();
      const without = k.info().drawCalls;
      k.drawSky(true);
      await k.show();
      return { ...s, draws: k.info().drawCalls - without };
    };
    // The sun at the centre: 90° up at noon, 4° below at 18:16.
    return { noon: await at(12), dusk: await at(18 + 4 / 15), night: await at(0) };
  });
  expect(sky.noon.sun.height).toBeCloseTo(90, 1);
  expect(sky.noon.starLimit).toBeLessThan(-1.46);
  expect(sky.dusk.sun.height).toBeCloseTo(-4, 1);
  expect(sky.dusk.starLimit).toBeGreaterThan(-1.46);
  expect(sky.dusk.starLimit).toBeLessThan(2);
  expect(sky.night.starLimit).toBeGreaterThanOrEqual(5.5);
  expect(sky.night.main).toBe('moon');
  expect(sky.noon.main).toBe('sun');
  // By day no lantern is drawn, so the stars' one draw is the difference;
  // at night the own boat's lantern adds one more.
  expect(sky.noon.draws).toBe(1);
  expect(sky.night.draws).toBe(2);
  // Nothing of the stars shows at noon: the picture is the same without them.
  const pictures = await Promise.all(
    [true, false].map(async (on) => {
      await page.evaluate((on) => {
        const k = globalThis.keel;
        k.setSky(12);
        k.drawSky(on);
        // Down and on into looking up: one drag the whole way.
        k.dragCamera(0, -400);
      }, on);
      return picture(page);
    }),
  );
  const [a, b] = pictures as [Picture, Picture];
  let differ = 0;
  for (let i = 0; i < a.data.length; i++) {
    differ += a.data[i] === b.data[i] ? 0 : 1;
  }
  expect(differ).toBe(0);
});

test.describe('the light of the hour', () => {
  test('a moonless midnight: nothing bright, nothing black', async ({ page }) => {
    await openScene(page);
    await page.evaluate(() => {
      const k = globalThis.keel;
      k.setSky(0, 0);
      // The lanterns and stars are lights of their own.
      k.drawSky(false);
    });
    const p = await picture(page);
    let brightest = 0;
    let black = 0;
    for (let i = 0; i < p.data.length; i += 4) {
      const m = Math.max(p.data[i] ?? 0, p.data[i + 1] ?? 0, p.data[i + 2] ?? 0);
      brightest = Math.max(brightest, m);
      black += m === 0 ? 1 : 0;
    }
    test
      .info()
      .annotations.push({ type: 'measured', description: JSON.stringify({ brightest, black }) });
    expect(brightest).toBeLessThan(150);
    // WebGL 2 draws the scene into an 8-bit buffer of linear light, which
    // holds nothing darker than 1/255: the faces of the hull that only the
    // sea's dim light reaches round to black there.
    if (test.info().project.name === 'webgpu') {
      expect(black).toBe(0);
    } else {
      expect(black).toBeLessThan(p.width * p.height * 0.002);
    }
  });

  test('a full moon lays its light on the sea toward it', async ({ page }) => {
    await openScene(page);
    // Two hours after sunset, a full moon is 30° up in the east, the way
    // the boat heads and the camera looks.
    const sky = await page.evaluate(() => {
      const k = globalThis.keel;
      k.setSky(20, 0.5);
      k.drawSky(false);
      return k.sky();
    });
    expect(sky.moon.height).toBeGreaterThan(20);
    expect(sky.main).toBe('moon');
    const toward = await picture(page);
    await page.evaluate(() => {
      // Half a turn: the camera looks west.
      globalThis.keel.dragCamera(Math.PI / 0.006, 0);
    });
    const away = await picture(page);
    const sea = (p: Picture) =>
      meanRows(p, Math.round(p.height * 0.35), Math.round(p.height * 0.75));
    test.info().annotations.push({
      type: 'measured',
      description: JSON.stringify({ toward: sea(toward), away: sea(away) }),
    });
    expect(sea(toward)).toBeGreaterThan(sea(away) * 1.15);
  });
});

test.describe('looking up', () => {
  test('from the rim the Hub Star is brought to the middle and named by a tap; empty sky and a drag name nothing', async ({
    page,
  }) => {
    await openScene(page);
    const brought = await page.evaluate(() => {
      const k = globalThis.keel;
      k.placeBoat(0, 8300);
      k.setSky(0);
      const canvas = document.querySelector('canvas.scene') as HTMLCanvasElement;
      const cx = canvas.clientWidth / 2;
      const cy = canvas.clientHeight / 2;
      const star = () => k.starOnScreen('The Hub Star') as { x: number; y: number; front: boolean };
      // Swing round until it is ahead, then learn which way a drag moves it.
      for (let i = 0; i < 20 && !(star().front && Math.abs(star().x - cx) < cx); i++) {
        k.dragCamera(60, 0);
      }
      const x0 = star().x;
      k.dragCamera(5, 0);
      const perPixel = (star().x - x0) / 5;
      for (let i = 0; i < 300; i++) {
        const s = star();
        const ex = s.x - cx;
        const ey = s.y - cy;
        if (Math.abs(ex) < 2 && Math.abs(ey) < 2) {
          break;
        }
        // Across: by what moved it. Up: a star above the middle wants the
        // gaze lifted, which the drag that lowers the camera goes on into.
        const dx = perPixel === 0 ? 0 : Math.max(-30, Math.min(30, -ex / perPixel / 2));
        const dy = Math.max(-20, Math.min(20, ey * 0.2));
        k.dragCamera(dx, dy);
      }
      return { star: star(), cx, cy, camera: k.dragCamera(0, 0) };
    });
    expect(brought).not.toBeNull();
    const { star, cx, cy } = brought as { star: { x: number; y: number }; cx: number; cy: number };
    expect(Math.hypot(star.x - cx, star.y - cy)).toBeLessThan(20);

    const tapped = await page.evaluate(({ x, y }) => globalThis.keel.tapSky(x, y), {
      x: star.x + 5,
      y: star.y - 3,
    });
    expect(tapped, JSON.stringify(brought)).toEqual({
      name: 'The Hub Star',
      label: 'The Hub Star',
    });

    // Empty sky: a point no named star is near.
    const empty = await page.evaluate(() => {
      const k = globalThis.keel;
      const canvas = document.querySelector('canvas.scene') as HTMLCanvasElement;
      const stars = k.namedStars().map((s) => k.starOnScreen(s.name));
      for (let y = 40; y < canvas.clientHeight / 2; y += 20) {
        for (let x = 40; x < canvas.clientWidth - 40; x += 20) {
          if (stars.every((s) => s === null || Math.hypot(s.x - x, s.y - y) > 80)) {
            return k.tapSky(x, y);
          }
        }
      }
      return null;
    });
    expect(empty).toEqual({ name: null, label: null });

    // A drag through the star is not a tap: the real pointer, on the canvas.
    const box = await page.locator('canvas.scene').boundingBox();
    const at = await page.evaluate(() => globalThis.keel.starOnScreen('The Hub Star'));
    if (box === null || at === null) {
      throw new Error('no canvas or no star');
    }
    await page.mouse.move(box.x + at.x, box.y + at.y);
    await page.mouse.down();
    await page.mouse.move(box.x + at.x + 40, box.y + at.y, { steps: 4 });
    await page.mouse.up();
    const after = await page.evaluate(() => {
      globalThis.keel.render();
      const el = document.querySelector<HTMLElement>('.star-label');
      return el === null || el.hidden ? null : el.textContent;
    });
    expect(after).toBeNull();
    // And a click on it is.
    const again = await page.evaluate(() => globalThis.keel.starOnScreen('The Hub Star'));
    if (again === null) {
      throw new Error('no star');
    }
    await page.mouse.click(box.x + again.x, box.y + again.y);
    const shown = await page.evaluate(() => {
      globalThis.keel.render();
      const el = document.querySelector<HTMLElement>('.star-label');
      return el === null || el.hidden ? null : el.textContent;
    });
    expect(shown).toBe('The Hub Star');
  });
});

test.describe('lanterns', () => {
  /** A boat 40 m ahead of the camera, on a heading, at an hour; its lantern's colours on screen. */
  async function lantern(page: Page, heading: number, hour: number, ahead = 40) {
    await page.evaluate(
      ({ heading, hour, ahead }) => {
        const k = globalThis.keel;
        k.showOwnBoat(false);
        k.setSky(hour, 0);
        const b = k.boat().state;
        // The own boat heads east, and the chase camera looks along it.
        k.setFleet([{ east: b.x + ahead, north: b.y, heading, boom: 0.3, sail: 15 }]);
        k.render();
      },
      { heading, hour, ahead },
    );
    const p = await picture(page);
    const at = await page.evaluate(() => globalThis.keel.lanternOnScreen(0));
    return { at, colours: at === null ? null : around(p, at.x, at.y, 5) };
  }

  test('by night, red from the port bow and white from astern; by day none', async ({ page }) => {
    await openScene(page);
    // Heading 315°: the camera, to the boat's west, is 45° off its port bow.
    const port = await lantern(page, (315 * Math.PI) / 180, 0);
    expect(port.at?.bearing).toBeCloseTo(-45, -1);
    expect(port.colours?.red).toBeGreaterThan(80);
    expect(port.colours?.green).toBeLessThan(20);
    // Heading 225°: the camera is 45° off her starboard bow, green.
    const starboard = await lantern(page, (225 * Math.PI) / 180, 0);
    expect(starboard.colours?.green).toBeGreaterThan(80);
    expect(starboard.colours?.red).toBeLessThan(20);
    // Heading east, away from the camera: right astern, white.
    const astern = await lantern(page, Math.PI / 2, 0);
    expect(Math.abs(astern.at?.bearing ?? 0)).toBeGreaterThan(170);
    expect(astern.colours?.white).toBeGreaterThan(150);
    expect(astern.colours?.red).toBeLessThan(20);
    // By day the lantern is brass and glass: no glow is drawn at all.
    const day = await lantern(page, (315 * Math.PI) / 180, 10);
    expect(day.at).toBeNull();
  });

  test('a boat 400 m off is hidden by the sea, lantern and all', async ({ page }) => {
    await openScene(page);
    const far = await lantern(page, (315 * Math.PI) / 180, 0, 400);
    // Drawn, but behind the sea.
    expect(far.at).not.toBeNull();
    expect(far.colours?.red).toBeLessThan(20);
  });

  test('64 boats by night: two draws for the stars and every lantern, under 150 in all', async ({
    page,
  }) => {
    await openScene(page);
    const budget = await page.evaluate(async () => {
      const k = globalThis.keel;
      k.setSky(0, 0.5);
      const b = k.boat().state;
      const boats = [];
      for (let i = 0; i < 64; i++) {
        boats.push({
          east: b.x - 70 + (i % 8) * 20,
          north: b.y + 20 + Math.floor(i / 8) * 20,
          heading: 1.5708,
          boom: 0.6,
          sail: 15 | (1 << 4) | (1 << 6),
        });
      }
      k.setFleet(boats);
      k.drawSky(false);
      await k.show();
      const without = k.info().drawCalls;
      k.drawSky(true);
      await k.show();
      return { ...k.info(), without, lanterns: k.sky().lanternsDrawn };
    });
    test.info().annotations.push({ type: 'measured', description: JSON.stringify(budget) });
    expect(budget.lanterns).toBe(65);
    expect(budget.drawCalls - budget.without).toBe(2);
    expect(budget.drawCalls).toBeLessThan(150);
  });
});

test.describe('pictures', () => {
  for (const [name, hour, moon] of [
    ['noon', 12, null],
    ['sunset', 17.9, null],
    ['dusk', 18.2, null],
    ['full-moon', 21, 0.5],
    ['moonless', 0, 0],
    ['dawn', 5.95, null],
  ] as const) {
    test(`the hours: ${name}`, async ({ page }) => {
      await openScene(page);
      await page.evaluate(
        async ({ hour, moon }) => {
          const k = globalThis.keel;
          k.setSky(hour, moon);
          await k.show();
        },
        { hour, moon },
      );
      await expect(page.locator('canvas.scene')).toHaveScreenshot(`sky-${name}.png`);
    });
  }

  test('a fleet by night', async ({ page }) => {
    await openScene(page);
    await page.evaluate(async () => {
      const k = globalThis.keel;
      k.setSky(23, 0.25);
      const b = k.boat().state;
      const at = (side: number, ahead: number) => ({ east: b.x + ahead, north: b.y - side });
      const drawing = 15 | (1 << 4) | (1 << 6);
      k.setFleet([
        { ...at(-14, 26), heading: 1.5708, heel: 0.35, boom: 0.75, sailor: -0.9, sail: drawing },
        { ...at(10, 30), heading: -1.2, heel: -0.1, boom: -0.9, sailor: 0.5, sail: drawing },
        { ...at(-6, 48), heading: 3.0, boom: 0.02, sail: 15 },
        { ...at(-40, 140), heading: 1.2, heel: 0.2, boom: 0.6, sailor: -0.7, sail: drawing },
        { ...at(60, 180), heading: -0.6, heel: -0.15, boom: -0.4, sailor: 0.6, sail: drawing },
      ]);
      k.camera('sea');
      await k.show();
    });
    await expect(page.locator('canvas.scene')).toHaveScreenshot('sky-fleet-night.png');
  });

  test('the sky from the rim: the Plough and the Hub Star', async ({ page }) => {
    await openScene(page);
    await page.evaluate(async () => {
      const k = globalThis.keel;
      k.placeBoat(0, 8300);
      k.setSky(2, 0);
      // Turn to the south, where the centre and the Hub Star are, and look up.
      k.dragCamera(Math.PI / 2 / 0.006, 0);
      k.dragCamera(0, -350);
      await k.show();
    });
    await expect(page.locator('canvas.scene')).toHaveScreenshot('sky-rim.png');
  });
});
