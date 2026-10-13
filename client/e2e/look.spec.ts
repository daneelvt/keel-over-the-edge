// SPDX-License-Identifier: AGPL-3.0-only

// The sea's look in a real browser: the detail band the GPU transforms is
// the one the CPU makes in float64, what is drawn on a tile stays inside it,
// the foam follows the wind's force, boats leave wakes, and the tiers and
// adaptive quality move between each other without a stall.

import { test as base, expect, type Page } from '@playwright/test';
import { openScene, picture } from './helpers';

/**
 * One page for the tests of a worker, put back between them (resetLook):
 * opening the scene takes ten seconds on CI's software GPU, longer than most
 * of these tests do.
 */
const test = base.extend<object, { shared: Page }>({
  shared: [
    async ({ browser }, use, workerInfo) => {
      const baseURL = workerInfo.project.use.baseURL;
      const page = await browser.newPage({
        ...(baseURL === undefined ? {} : { baseURL }),
        viewport: { width: 960, height: 600 },
        deviceScaleFactor: 1,
      });
      await use(page);
      await page.close();
    },
    { scope: 'worker' },
  ],
  page: async ({ shared }, use) => {
    await use(shared);
  },
});

/** Opens the sandbox with a query, or puts the page already open back as it would open with it. */
async function openLook(page: Page, query = ''): Promise<void> {
  const sea = query === '' ? null : (/^sea=(\w+)$/.exec(query)?.[1] ?? undefined);
  const url = page.url();
  const open =
    sea !== undefined &&
    url.includes('?sandbox&test') &&
    !url.includes('tier=') &&
    (await page.evaluate(() => globalThis.keel?.info().backend ?? '').catch(() => '')) !== '';
  if (!open) {
    await openScene(page, query);
    return;
  }
  const info = await page.evaluate(() => globalThis.keel.info());
  const name = test.info().project.name;
  test.skip((name === 'webgpu' || name === 'compat') && info.backend !== 'webgpu', 'no WebGPU');
  test.skip(name === 'compat' && !info.compat, 'no device held to compatibility mode');
  // The screen's panels hidden, as openScene hides them: a test may have opened the page itself.
  await page.addStyleTag({ content: '.hud { visibility: hidden; }' });
  await page.evaluate(async (sea) => {
    const k = globalThis.keel;
    k.slowFrames(0);
    k.freeze(100);
    await k.resetLook(sea);
    k.reset();
    k.render();
    k.camera('chase');
    k.render();
  }, sea);
}

/**
 * On CI's software GPU (Linux) the look's pixel probes and pictures run on
 * WebGL 2 alone: on WebGPU there they take minutes, and the shaders are the
 * same. On the Mac they run on every back end.
 */
function heavy(): void {
  test.skip(
    process.platform === 'linux' && test.info().project.name !== 'webgl2',
    'on a software GPU this runs on WebGL 2 only; on every back end on the Mac',
  );
}

/** The root mean square of every stride-th value of v from offset. */
function rms(v: number[], offset: number, stride = 4): number {
  let sum = 0;
  let n = 0;
  for (let i = offset; i < v.length; i += stride) {
    sum += (v[i] ?? 0) ** 2;
    n++;
  }
  return Math.sqrt(sum / Math.max(n, 1));
}

/** Whether the page draws with compute passes: WebGPU. */
async function hasCompute(page: Page): Promise<boolean> {
  return (await page.evaluate(() => globalThis.keel.info().backend)) === 'webgpu';
}

test.describe('the detail band’s transform', () => {
  for (const sea of ['breeze', 'gale']) {
    test(`is the CPU’s field, in the ${sea}`, async ({ page }) => {
      await openLook(page, `sea=${sea}`);
      test.skip(!(await hasCompute(page)), 'the transform runs in compute passes');
      const got = await page.evaluate(async () => {
        const k = globalThis.keel;
        // A time late in the loop, and not on a step.
        k.freeze(1234.5);
        k.render();
        const info = k.info();
        const fields = [await k.detailFields(0)];
        if (info.detail.endsWith('× 2')) {
          fields.push(await k.detailFields(1));
        }
        return { info, fields };
      });
      expect(got.info.detail).toMatch(/^fft (128|256) × [12]$/);
      for (const f of got.fields) {
        // Slope east, slope north, height: within a thousandth of each field's own size.
        for (const [gpu, cpu] of [
          [0, 0],
          [1, 1],
          [3, 3],
        ] as const) {
          const size = rms(f.cpu, cpu);
          let worst = 0;
          let sum = 0;
          for (let i = 0; i < f.size * f.size; i++) {
            const d = (f.gpu[i * 4 + gpu] ?? 0) - (f.cpu[i * 4 + cpu] ?? 0);
            worst = Math.max(worst, Math.abs(d));
            sum += d * d;
          }
          expect(size).toBeGreaterThan(1e-4);
          expect(Math.sqrt(sum / (f.size * f.size)) / size).toBeLessThan(1e-3);
          // No texel is far out either: a wave in the wrong place would be.
          expect(worst / size).toBeLessThan(0.02);
        }
        // And the height is the spectrum's.
        expect(
          Math.abs(rms(f.gpu, 3) - Math.sqrt(f.variance)) / Math.sqrt(f.variance),
        ).toBeLessThan(0.02);
      }
    });
  }
});

/** The project's back end, as the page draws it. */
const project = (): string => test.info().project.name;

test.describe('the tiers', () => {
  test('start on the best the device runs, held to its limits', async ({ page }) => {
    await openLook(page);
    // A frame at a new time: with time standing still the band is not made again.
    const info = await page.evaluate(() => {
      globalThis.keel.freeze(101);
      globalThis.keel.render();
      return globalThis.keel.info();
    });
    if (project() === 'webgl2') {
      expect(info.tier).toBe('low');
      expect(info.detail).toBe('baked');
      expect(info.dispatches).toBe(0);
    } else if (project() === 'compat') {
      // Compatibility mode's limits, enforced: and the transform built to them.
      expect(info.compat).toBe(true);
      expect(info.workgroup).toBe(128);
      expect(info.vertexStorageTextures).toBe(0);
      expect(info.tier).toBe('medium');
      expect(info.detail).toBe('fft 128 × 1');
      expect(info.dispatches).toBe(4);
    } else {
      expect(info.compat).toBe(false);
      expect(info.workgroup).toBeGreaterThanOrEqual(256);
      expect(info.tier).toBe('high');
      expect(info.detail).toBe('fft 256 × 2');
      expect(info.dispatches).toBe(8);
    }
  });

  test('?tier holds a tier no better than the device’s, with adaptive quality off', async ({
    page,
  }) => {
    await openLook(page, 'tier=medium');
    const info = await page.evaluate(() => globalThis.keel.info());
    expect(info.tier).toBe(project() === 'webgl2' ? 'low' : 'medium');
    expect(info.adaptive).toBe(false);
    expect(info.rungs.every((r) => !r.startsWith('high'))).toBe(true);
  });

  test('every rung of the ladder draws, with no error', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') {
        errors.push(m.text());
      }
    });
    await openLook(page, 'sea=gale');
    const seen = await page.evaluate(async () => {
      const k = globalThis.keel;
      const out: string[] = [];
      for (let i = 0; i < k.info().rungs.length; i++) {
        await k.setRung(i);
        k.render();
        const info = k.info();
        out.push(`${info.rungs[info.rung]}: ${info.detail}, ${info.dispatches} dispatches`);
      }
      await k.setRung(0);
      return out;
    });
    test.info().annotations.push({ type: 'rungs', description: seen.join('; ') });
    expect(errors.filter((e) => !e.includes('404'))).toEqual([]);
  });
});

test.describe('the detail band’s transform, further', () => {
  test('lets foam form where the surface folds, and fade over its time', async ({ page }) => {
    heavy();
    await openLook(page, 'sea=fresh');
    test.skip(!(await hasCompute(page)), 'the transform runs in compute passes');
    const r = await page.evaluate(async () => {
      const k = globalThis.keel;
      const mean = (v: number[], c: number): [number, number] => {
        let sum = 0;
        let most = 0;
        for (let i = c; i < v.length; i += 4) {
          sum += v[i] ?? 0;
          most = Math.max(most, v[i] ?? 0);
        }
        return [sum / (v.length / 4), most];
      };
      // Everything folds.
      k.setFold({ threshold: 5, chop: 0, decay: 1 });
      k.runDetail(0.5);
      const folded = mean((await k.detailFields(0)).gpu, 2);
      // Nothing folds: what was foam fades over its second.
      k.setFold({ threshold: -5, chop: 0, decay: 1 });
      k.runDetail(3, 30);
      const faded = mean((await k.detailFields(0)).gpu, 2);
      k.setFold(null);
      return { folded, faded };
    });
    expect(r.folded[0]).toBeGreaterThan(0.95);
    expect(r.faded[1]).toBeLessThan(0.05);
    expect(r.faded[1]).toBeGreaterThan(0.03);
  });

  test('is the CPU’s field again after a lost device', async ({ page }) => {
    await openLook(page, 'sea=gale');
    test.skip(!(await hasCompute(page)), 'the transform runs in compute passes');
    await page.evaluate(() => globalThis.keel.loseDevice());
    await page.waitForFunction(() => globalThis.keel.info().recoveries === 1, null, {
      timeout: 5000,
    });
    const f = await page.evaluate(async () => {
      const k = globalThis.keel;
      k.freeze(321.25);
      k.render();
      return k.detailFields(0);
    });
    let sum = 0;
    for (let i = 0; i < f.size * f.size; i++) {
      sum += ((f.gpu[i * 4 + 3] ?? 0) - (f.cpu[i * 4 + 3] ?? 0)) ** 2;
    }
    expect(Math.sqrt(sum / (f.size * f.size)) / rms(f.cpu, 3)).toBeLessThan(1e-3);
  });
});

test('the low tier’s loop is made behind the scene, a few milliseconds a frame', async ({
  page,
}) => {
  test.skip(project() !== 'webgl2', 'the loop is the low tier’s');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?sandbox&test&backend=webgl2&sea=fresh');
  await page.waitForFunction(() => globalThis.keel !== undefined, null, { timeout: 30_000 });
  const r = await page.evaluate(async () => {
    const k = globalThis.keel;
    await k.ready(false);
    let frames = 0;
    while (!k.detail().baked && frames < 600) {
      await k.frames(1);
      frames++;
    }
    return { ...k.detail(), frames };
  });
  expect(errors).toEqual([]);
  expect(r.baked).toBe(true);
  test.info().annotations.push({
    type: 'bake',
    description: `${r.bakeSpent.toFixed(0)} ms, longest slice ${r.bakeLongest.toFixed(1)} ms`,
  });
  if (process.platform === 'darwin') {
    expect(r.bakeLongest).toBeLessThan(8);
  }
});

/** A view from straight above of the look's numbers, with each pixel's tile; and helpers to read it. */
type Surface = Awaited<ReturnType<typeof globalThis.keel.surface>>;

test.describe('what is drawn on a tile', () => {
  test.beforeEach(heavy);

  test('tilts the tile as a whole, and its own ripples stop at its rim', async ({ page }) => {
    await openLook(page, 'sea=fresh');
    const s: Surface = await page.evaluate(() => globalThis.keel.surface(256, 32));
    // Each tile's whole-tile tilt, and the largest difference within it.
    const tilt = new Map<number, [number, number]>();
    let within = 0;
    let largest = 0;
    let rimRipple = 0;
    let ripple = 0;
    for (let p = 0; p < s.tile.length; p++) {
      const t = s.tile[p] ?? -1;
      if (t < 0) {
        continue;
      }
      const x = s.detail[p * 4] ?? 0;
      const z = s.detail[p * 4 + 1] ?? 0;
      const first = tilt.get(t);
      if (first === undefined) {
        tilt.set(t, [x, z]);
      } else {
        within = Math.max(within, Math.abs(x - first[0]), Math.abs(z - first[1]));
      }
      largest = Math.max(largest, Math.abs(x), Math.abs(z));
      const r = Math.hypot(s.detail[p * 4 + 2] ?? 0, s.detail[p * 4 + 3] ?? 0);
      ripple = Math.max(ripple, r);
      if ((s.crest[p * 4 + 2] ?? 0) > 0.93) {
        rimRipple = Math.max(rimRipple, r);
      }
    }
    expect(tilt.size).toBeGreaterThan(40);
    // The tilt is the band's, and every fragment of a tile has the same.
    expect(largest).toBeGreaterThan(0.005);
    expect(within).toBeLessThan(1e-4 + 1e-3 * largest);
    expect(ripple).toBeGreaterThan(0.005);
    expect(rimRipple).toBeLessThan(0.05 * ripple);
  });

  test('has ripples of the tile’s own, not its neighbour’s', async ({ page }) => {
    await openLook(page, 'sea=breeze');
    const s: Surface = await page.evaluate(() => globalThis.keel.surface(256, 32));
    const size = 256;
    // Each tile's centre in pixels, from its pixels.
    const sums = new Map<number, [number, number, number]>();
    for (let p = 0; p < s.tile.length; p++) {
      const t = s.tile[p] ?? -1;
      if (t >= 0) {
        const v = sums.get(t) ?? [0, 0, 0];
        sums.set(t, [v[0] + (p % size), v[1] + Math.floor(p / size), v[2] + 1]);
      }
    }
    // A whole tile is some 890 pixels.
    const whole = [...sums].filter(([, v]) => v[2] > 700);
    let same = 0;
    let differ = 0;
    let n = 0;
    for (const [a, va] of whole.slice(0, 6)) {
      for (const [b, vb] of whole) {
        const dx = Math.round(vb[0] / vb[2] - va[0] / va[2]);
        const dy = Math.round(vb[1] / vb[2] - va[1] / va[2]);
        // Next-door neighbours only: 4 m apart is 32 pixels.
        if (a === b || Math.hypot(dx, dy) > 36) {
          continue;
        }
        for (let p = 0; p < s.tile.length; p += 7) {
          if (s.tile[p] !== a) {
            continue;
          }
          const q = p + dy * size + dx;
          if (s.tile[q] !== b || (s.crest[p * 4 + 2] ?? 1) > 0.6) {
            continue;
          }
          const ra = s.detail[p * 4 + 2] ?? 0;
          const rb = s.detail[q * 4 + 2] ?? 0;
          same += ra * ra;
          differ += (ra - rb) ** 2;
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(200);
    // Unrelated ripples differ by about √2 of their size; the same would by nothing.
    expect(Math.sqrt(differ / same)).toBeGreaterThan(0.8);
  });

  test('the far sea reads the band plainly, without seams', async ({ page }) => {
    await openLook(page, 'sea=fresh');
    // Pixels of 1.6 cm, a tenth of the band's texels: a seam would show as a jump.
    const px = await page.evaluate(() => globalThis.keel.farSurface(128, 2, 170));
    let jump = 0;
    let size = 0;
    let n = 0;
    for (let row = 0; row < 128; row++) {
      for (let col = 1; col < 128; col++) {
        const a = (row * 128 + col) * 4;
        const b = a - 4;
        size += (px[a] ?? 0) ** 2;
        jump = Math.max(jump, Math.abs((px[a] ?? 0) - (px[b] ?? 0)));
        n++;
      }
    }
    const typical = Math.sqrt(size / n);
    if (project() === 'webgl2') {
      // The loop is not filtered with distance, so it fades out before the far sea.
      expect(typical).toBeLessThan(1e-3);
    } else {
      expect(typical).toBeGreaterThan(1e-3);
      expect(jump).toBeLessThan(0.5 * typical);
    }
  });
});

/** Settles the foam the detail band remembers, where it remembers any. */
async function settled(page: Page): Promise<void> {
  await page.evaluate(() => {
    const k = globalThis.keel;
    if (k.info().backend === 'webgpu') {
      k.settleFoam();
    }
    k.render();
  });
}

test.describe('foam', () => {
  test.beforeEach(heavy);

  test('in a calm, only round the hull', async ({ page }) => {
    await openLook(page, 'sea=calm');
    await settled(page);
    const s: Surface = await page.evaluate(() => globalThis.keel.surface(256, 24));
    let foam = 0;
    let away = 0;
    for (let p = 0; p < s.tile.length; p++) {
      if ((s.foam[p * 4 + 1] ?? 0) > 0.01) {
        foam++;
        if ((s.crest[p * 4 + 3] ?? 0) <= 0) {
          away++;
        }
      }
    }
    // The ring at the boat's waterline.
    expect(foam).toBeGreaterThan(20);
    expect(away).toBe(0);
  });

  test('whitecaps only on high crests; streaks only from force 7, long down the wind', async ({
    page,
  }) => {
    await openLook(page, 'sea=fresh');
    const fresh: Surface = await page.evaluate(() => globalThis.keel.surface(128, 64));
    let streaks = 0;
    for (let p = 0; p < fresh.tile.length; p++) {
      streaks = Math.max(streaks, fresh.foam[p * 4 + 3] ?? 0);
    }
    expect(streaks).toBe(0);
    await page.evaluate(() => {
      globalThis.keel.setSea('gale');
      globalThis.keel.render();
    });
    const s: Surface = await page.evaluate(() => globalThis.keel.surface(256, 64));
    let caps = 0;
    let low = 0;
    for (let p = 0; p < s.tile.length; p++) {
      if ((s.foam[p * 4 + 2] ?? 0) > 1e-3) {
        caps++;
        if ((s.crest[p * 4] ?? 0) + 0.35 * (s.crest[p * 4 + 1] ?? 0) < 0.75 - 1e-3) {
          low++;
        }
      }
    }
    expect(caps).toBeGreaterThan(100);
    expect(low).toBe(0);
    // The streaks: alike two metres down the wind (north, up the picture), not across it.
    const size = 256;
    const lag = 8;
    const corr = (dx: number, dy: number): number => {
      let sxy = 0;
      let sxx = 0;
      let syy = 0;
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let row = 0; row < size - lag; row++) {
        for (let col = 0; col < size - lag; col++) {
          const p = row * size + col;
          const q = (row + dy) * size + col + dx;
          if (s.tile[p] !== s.tile[q] || (s.tile[p] ?? -1) < 0) {
            continue;
          }
          const a = s.foam[p * 4 + 3] ?? 0;
          const b = s.foam[q * 4 + 3] ?? 0;
          sx += a;
          sy += b;
          sxy += a * b;
          sxx += a * a;
          syy += b * b;
          n++;
        }
      }
      const cov = sxy / n - (sx / n) * (sy / n);
      return cov / Math.sqrt((sxx / n - (sx / n) ** 2) * (syy / n - (sy / n) ** 2));
    };
    const along = corr(0, lag);
    const across = corr(lag, 0);
    expect(along).toBeGreaterThan(0.5);
    expect(across).toBeLessThan(0.5 * along);
  });

  test('stays inside its tile, with a clear margin at the rim', async ({ page }) => {
    await openLook(page, 'sea=gale');
    await settled(page);
    const s: Surface = await page.evaluate(() => globalThis.keel.surface(256, 64));
    let inner = 0;
    let innerN = 0;
    let rim = 0;
    let rimN = 0;
    for (let p = 0; p < s.tile.length; p++) {
      const r = s.crest[p * 4 + 2] ?? 0;
      const cover = s.foam[p * 4] ?? 0;
      if ((s.tile[p] ?? -1) < 0) {
        continue;
      }
      if (r > 0.9) {
        rim += cover;
        rimN++;
      } else if (r < 0.55) {
        inner += cover;
        innerN++;
      }
    }
    expect(inner / innerN).toBeGreaterThan(0.01);
    expect(rim / rimN).toBeLessThanOrEqual(0.2 * (inner / innerN));
  });

  test('whitens the sea more as the wind rises, and the share is recorded', async ({ page }) => {
    await openLook(page, 'sea=calm');
    const shares: number[] = [];
    const winds = { calm: 6, breeze: 12, fresh: 20, gale: 34 };
    for (const sea of Object.keys(winds)) {
      await page.evaluate((sea) => {
        globalThis.keel.setSea(sea);
        globalThis.keel.render();
      }, sea);
      await settled(page);
      const s: Surface = await page.evaluate(() => globalThis.keel.surface(256, 96));
      let white = 0;
      let n = 0;
      for (let p = 0; p < s.tile.length; p++) {
        // The sea's own foam: away from the hulls.
        if ((s.tile[p] ?? -1) < 0 || (s.crest[p * 4 + 3] ?? 0) > 0) {
          continue;
        }
        white += (s.foam[p * 4] ?? 0) > 0.5 ? 1 : 0;
        n++;
      }
      shares.push(white / n);
    }
    const knot = 1852 / 3600;
    test.info().annotations.push({
      type: 'white share',
      description: Object.entries(winds)
        .map(
          ([name, kn], i) =>
            `${name} (${kn} kn): ${((shares[i] ?? 0) * 100).toFixed(2)}%, Monahan ${(3.84e-4 * (kn * knot) ** 3.41).toFixed(2)}%`,
        )
        .join('; '),
    });
    expect(shares[0]).toBe(0);
    for (let i = 1; i < shares.length; i++) {
      expect(shares[i]).toBeGreaterThanOrEqual(shares[i - 1] ?? 0);
    }
    expect(shares[3]).toBeGreaterThan(shares[1] ?? 0);
  });
});

test.describe('the wakes and the hulls', () => {
  test.beforeEach(heavy);

  test('a boat lays a track that fades, fixed on the water as the map follows the boat', async ({
    page,
  }) => {
    await openLook(page, 'sea=breeze');
    const r = await page.evaluate(async () => {
      const k = globalThis.keel;
      k.setState({ heading: 1.5708, surge: 3, sheetLimit: 0.5 });
      k.setControls(0, 0.3);
      k.script('steer', 1.5708);
      // Eight seconds of sailing, drawn frame by frame however slow the machine.
      k.sailFrames(120);
      k.script(null);
      const strong = (w: Awaited<ReturnType<typeof k.wakes>>) => {
        const out = new Map<string, number>();
        let most = 0;
        for (let i = 0; i < w.data.length; i++) {
          const v = w.data[i] ?? 0;
          most = Math.max(most, v);
          if (v > 40) {
            const e = w.east + ((i % w.size) - w.size / 2 + 0.5) * w.texel;
            const n = w.north + (Math.floor(i / w.size) - w.size / 2 + 0.5) * w.texel;
            out.set(`${e.toFixed(2)},${n.toFixed(2)}`, v);
          }
        }
        return { out, most, east: w.east };
      };
      const a = strong(await k.wakes());
      // The boat put down elsewhere, and the floating origin moved.
      const b0 = k.boat().state;
      k.placeBoat(b0.x + 7.3, b0.y + 3.1);
      const c = k.info().centre;
      k.setOrigin(c.q, c.r);
      k.render();
      const b = strong(await k.wakes());
      let moved = 0;
      for (const [at, v] of a.out) {
        if (Math.abs((b.out.get(at) ?? 0) - v) > 1) {
          moved++;
        }
      }
      // Thirty seconds on, with no boat stamping it.
      k.runWakes(30);
      const later = strong(await k.wakes());
      // The track's area, square metres.
      const area = a.out.size * (await k.wakes()).texel ** 2;
      return { area, most: a.most, moved, shifted: b.east !== a.east, later: later.most };
    });
    expect(r.area).toBeGreaterThan(10);
    expect(r.shifted).toBe(true);
    expect(r.moved).toBe(0);
    expect(r.later).toBeLessThan(0.05 * r.most);
  });

  test('a stopped boat has a ring of foam and no arms; a moving one, arms at Kelvin’s angle', async ({
    page,
  }) => {
    await openLook(page, 'sea=calm');
    const stopped: Surface = await page.evaluate(() => globalThis.keel.surface(256, 16));
    let ring = 0;
    let far = 0;
    for (let p = 0; p < stopped.tile.length; p++) {
      const x = ((p % 256) + 0.5) / 16 - 8;
      const y = (Math.floor(p / 256) + 0.5) / 16 - 8;
      const v = stopped.crest[p * 4 + 3] ?? 0;
      if (v > 0.1) {
        ring++;
        far = Math.max(far, Math.hypot(x, y));
      }
    }
    expect(ring).toBeGreaterThan(50);
    // Nothing trails astern: the ring alone, within a few metres.
    expect(far).toBeLessThan(3);
    // Another boat at 4 m/s, heading north; the picture spans 12 m about a point 3 m astern of it.
    const arms = await page.evaluate(async () => {
      const k = globalThis.keel;
      k.setFleet([{ east: 40, north: 0, heading: 0, speed: 4 }]);
      k.render();
      return k.surface(256, 12, { east: 40, north: -3 });
    });
    // On each row from three metres to six and a half astern, past the
    // ring at its waterline, the arm to starboard: where the hull's foam is
    // greatest.
    const pts: [number, number][] = [];
    for (let row = 0; row < 256; row++) {
      const north = -3 + 6 - ((row + 0.5) * 12) / 256;
      if (north > -3 || north < -6.5) {
        continue;
      }
      let best = 0;
      let at = -1;
      for (let col = 128; col < 256; col++) {
        const v = arms.crest[(row * 256 + col) * 4 + 3] ?? 0;
        if (v > best) {
          best = v;
          at = col;
        }
      }
      if (best > 0.03) {
        pts.push([-north, ((at + 0.5) * 12) / 256 - 6]);
      }
    }
    expect(pts.length).toBeGreaterThan(30);
    // The arm's slope, by least squares.
    const n = pts.length;
    const mx = pts.reduce((s, p) => s + p[0], 0) / n;
    const my = pts.reduce((s, p) => s + p[1], 0) / n;
    const slope =
      pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) /
      pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
    const angle = (Math.atan(slope) * 180) / Math.PI;
    test.info().annotations.push({ type: 'Kelvin', description: `${angle.toFixed(1)}°` });
    expect(Math.abs(angle - 19.47)).toBeLessThan(2);
  });

  test('eight boats cost the draw calls one does', async ({ page }) => {
    await openLook(page, 'sea=fresh');
    const calls = await page.evaluate(async () => {
      const k = globalThis.keel;
      const boats = (n: number) =>
        // All of them near enough to be drawn in full.
        Array.from({ length: n }, (_, i) => ({ east: 4 + 3 * i, north: 8, heading: 1, speed: 3 }));
      k.setFleet(boats(1));
      await k.show();
      const one = k.info().drawCalls;
      k.setFleet(boats(8));
      await k.show();
      return [one, k.info().drawCalls];
    });
    expect(calls[1]).toBe(calls[0]);
  });
});

test('spray is thrown into a gale, in one draw call', async ({ page }) => {
  heavy();
  await openLook(page, 'sea=gale');
  const r = await page.evaluate(async () => {
    const k = globalThis.keel;
    k.setState({ heading: 0.3, surge: 4, sheetLimit: 0.4 });
    k.setControls(0, 0.2);
    k.script('steer', 0.3);
    k.thaw();
    let most = 0;
    for (let i = 0; i < 40 && most === 0; i++) {
      await k.frames(15);
      most = Math.max(most, k.info().spray);
    }
    k.script(null);
    k.freeze(k.game.clock.time);
    // A frame of its own each: the scene is drawn once an animation frame.
    // The first after freezing still moves the foam map on.
    await k.show();
    await k.show();
    const shown = k.info();
    k.showSpray(false);
    await k.show();
    const hidden = k.info().drawCalls;
    k.showSpray(true);
    return { most, spray: shown.spray, shown: shown.drawCalls, hidden, scene: k.checkScene() };
  });
  expect(r.most).toBeGreaterThan(0);
  expect(r.scene).toEqual([]);
  if (r.spray > 0) {
    expect(r.shown - r.hidden).toBe(1);
  }
});

test.describe('shadows', () => {
  test.beforeEach(heavy);

  test('shade the boat, and nothing else', async ({ page }) => {
    await openLook(page, 'sea=breeze');
    test.skip(project() === 'webgl2', 'the low tier has no shadows');
    // The sun abeam to starboard, and two rungs alike but for the shadows.
    const [on, off] = await page.evaluate(() => {
      const k = globalThis.keel;
      const rungs = k.info().rungs;
      const lit = rungs.findIndex((r) => r.includes('0.7, shadows'));
      return [lit, lit + 1];
    });
    const take = async (rung: number, boat: boolean) => {
      await page.evaluate(
        async ([rung, boat]) => {
          const k = globalThis.keel;
          await k.setRung(rung as number);
          k.setState({ heading: (30 * Math.PI) / 180 });
          k.showOwnBoat(boat as boolean);
          k.render();
          k.camera('aboard');
        },
        [rung, boat],
      );
      return picture(page);
    };
    const lit = await take(on, true);
    const plain = await take(off, true);
    const empty = await take(off, false);
    let shaded = 0;
    let brighter = 0;
    let offBoat = 0;
    for (let i = 0; i < lit.data.length; i += 4) {
      const d =
        (lit.data[i] ?? 0) +
        (lit.data[i + 1] ?? 0) +
        (lit.data[i + 2] ?? 0) -
        (plain.data[i] ?? 0) -
        (plain.data[i + 1] ?? 0) -
        (plain.data[i + 2] ?? 0);
      if (Math.abs(d) <= 24) {
        continue;
      }
      shaded += d < 0 ? 1 : 0;
      brighter += d > 0 ? 1 : 0;
      // Where the boat is not drawn, the picture is the same with or without it.
      const boat =
        Math.abs((plain.data[i] ?? 0) - (empty.data[i] ?? 0)) +
          Math.abs((plain.data[i + 1] ?? 0) - (empty.data[i + 1] ?? 0)) +
          Math.abs((plain.data[i + 2] ?? 0) - (empty.data[i + 2] ?? 0)) >
        6;
      offBoat += boat ? 0 : 1;
    }
    expect(shaded).toBeGreaterThan(100);
    expect(brighter).toBeLessThan(0.05 * shaded);
    expect(offBoat).toBeLessThan(0.02 * shaded);
  });
});

test.describe('budgets', () => {
  test('64 boats in a gale, on every tier', async ({ page }) => {
    await openLook(page, 'sea=gale');
    const r = await page.evaluate(async () => {
      const k = globalThis.keel;
      const boats = Array.from({ length: 64 }, (_, i) => ({
        east: 8 * (i % 8) - 28,
        north: 8 * Math.floor(i / 8) + 6,
        heading: i * 0.4,
        speed: 2,
      }));
      k.setFleet(boats);
      k.camera('high');
      const out: Record<string, unknown>[] = [];
      const info = k.info();
      for (const name of ['high', 'medium', 'low']) {
        const i = info.rungs.findIndex((r) => r.startsWith(name));
        if (i < 0) {
          continue;
        }
        await k.setRung(i);
        // A frame at a new time, so the band is made in it.
        k.freeze(200 + i);
        await k.show();
        const now = k.info();
        const bytes = k.textureBytes();
        out.push({
          rung: now.rungs[now.rung],
          drawCalls: now.drawCalls,
          dispatches: now.dispatches,
          triangles: now.triangles,
          // What the look adds, the shadow map included, as three.js counts it.
          megabytes: (bytes.detail + bytes.foamMap + bytes.pattern + bytes.shadowMap) / 2 ** 20,
          detail: bytes.detail / 2 ** 20,
          shadow: bytes.shadowMap / 2 ** 20,
          all: bytes.all / 2 ** 20,
        });
      }
      return out;
    });
    test.info().annotations.push({ type: 'budgets', description: JSON.stringify(r) });
    for (const t of r) {
      expect(t.drawCalls as number).toBeLessThan(150);
      const rung = t.rung as string;
      expect(t.dispatches).toBe(rung.includes('× 2') ? 8 : rung.includes('²') ? 4 : 0);
      // Everything this look adds to a phone's GPU memory.
      expect(t.megabytes as number).toBeLessThan(12);
      expect(t.megabytes as number).toBeGreaterThan(1);
    }
  });
});

test.describe('adaptive quality', () => {
  test('steps down a slow page to the low tier, and up again when it is fast', {
    tag: '@long',
  }, async ({ page }) => {
    test.setTimeout(480_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openLook(page, 'sea=fresh');
    const down = await page.evaluate(async () => {
      const k = globalThis.keel;
      const last = k.info().rungs.length - 1;
      k.slowFrames(45);
      k.thaw();
      // Windows long enough to hold a dozen frames on this machine, slowed:
      // a window of fewer frames is not judged.
      const t0 = performance.now();
      await k.frames(10);
      const frame = (performance.now() - t0) / 10;
      k.qualityTiming(Math.max(250, 12 * frame), 1000);
      k.adapt(true);
      const start = performance.now();
      while (k.info().rung < last && performance.now() - start < 240_000) {
        await k.frames(5);
      }
      return { rung: k.info().rung, last, tier: k.info().tier };
    });
    expect(down.rung).toBe(down.last);
    expect(down.tier).toBe('low');
    if (process.platform !== 'darwin') {
      // CI's software GPU is slow on every rung: it does not come back up.
      return;
    }
    const up = await page.evaluate(async () => {
      const k = globalThis.keel;
      k.slowFrames(0);
      let worst = 0;
      let at = '';
      let before = performance.now();
      const start = before;
      while (k.info().rung > 0 && performance.now() - start < 120_000) {
        await k.frames(1);
        const now = performance.now();
        if (now - before > worst) {
          worst = now - before;
          at = k.info().rungs[k.info().rung] ?? '';
        }
        before = now;
      }
      return { rung: k.info().rung, worst, at, log: k.qualityLog() };
    });
    test.info().annotations.push({
      type: 'steps',
      description: `${up.log.join('; ')}; the longest frame ${up.worst.toFixed(0)} ms, on ${up.at}`,
    });
    expect(up.rung).toBe(0);
    expect(up.worst).toBeLessThan(100);
    expect(errors).toEqual([]);
  });
});

test.describe('pictures', () => {
  test.beforeEach(heavy);

  for (const sea of ['calm', 'breeze', 'fresh', 'gale']) {
    test(sea, async ({ page }) => {
      await openLook(page, `sea=${sea}`);
      await page.evaluate(() => {
        globalThis.keel.setState({ heading: (330 * Math.PI) / 180 - 2 * Math.PI });
        globalThis.keel.render();
      });
      await settled(page);
      // The waves rendering's "Sea states" and "Close aboard".
      for (const view of ['sea', 'aboard']) {
        await page.evaluate(async (v) => {
          globalThis.keel.camera(v);
          await globalThis.keel.show();
        }, view);
        await expect(page.locator('canvas.scene')).toHaveScreenshot(`look-${sea}-${view}.png`);
      }
    });
  }
});
