// SPDX-License-Identifier: AGPL-3.0-only

// The sea's look in a real browser: the detail band the GPU transforms is
// the one the CPU makes in float64, what is drawn on a tile stays inside it,
// the foam follows the wind's force, boats leave wakes, and the tiers and
// adaptive quality move between each other without a stall.

import { test as base, expect, type Page } from '@playwright/test';
import { FOAM, foamAt, newFoamLook, whitecapCoverage } from '../src/ocean/look';
import { trackWavelength, type WakeGrid, wakeAngle } from '../src/ocean/wakemeasure';
import { openScene, picture, softwareGPU } from './helpers';

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
async function openLook(page: Page, query = '', best = true): Promise<void> {
  const sea = query === '' ? null : (/^sea=(\w+)$/.exec(query)?.[1] ?? undefined);
  const url = page.url();
  const open =
    sea !== undefined &&
    (best || !softwareGPU) &&
    url.includes('?sandbox&test') &&
    !url.includes('tier=') &&
    (await page.evaluate(() => globalThis.keel?.info().backend ?? '').catch(() => '')) !== '';
  if (!open) {
    await openScene(page, query, false, best);
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
    softwareGPU && test.info().project.name !== 'webgl2',
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
      // The detail band's four, and the wake's waves' four.
      expect(info.dispatches).toBe(8);
    } else {
      expect(info.compat).toBe(false);
      expect(info.workgroup).toBeGreaterThanOrEqual(256);
      expect(info.tier).toBe('high');
      expect(info.detail).toBe('fft 256 × 2');
      expect(info.dispatches).toBe(12);
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
    // The loop drawing, as a page not under test draws it.
    k.thaw();
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

  test('in a calm, none about a boat at rest', async ({ page }) => {
    await openLook(page, 'sea=calm');
    await page.evaluate(() => {
      const k = globalThis.keel;
      k.setState({ surge: 0, sway: 0 });
      k.setControls(0, 1);
      // Two seconds' frames, time running.
      k.sailFrames(30);
    });
    await settled(page);
    const s: Surface = await page.evaluate(() => globalThis.keel.surface(256, 24));
    let foam = 0;
    let white = 0;
    for (let p = 0; p < s.tile.length; p++) {
      foam = Math.max(foam, s.foam[p * 4 + 1] ?? 0);
      white = Math.max(white, s.wake[p * 4] ?? 0, s.crest[p * 4 + 3] ?? 0);
    }
    expect(foam).toBe(0);
    expect(white).toBe(0);
  });

  test('whitecaps only on the crests, lower down them the stronger the wind; streaks only from force 7, long down the wind', async ({
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
    // A gale's whitecaps reach down its crests from the top's 0.75 of half
    // the significant height, by how far their strength is over 1.
    const strength = foamAt(34, newFoamLook()).whitecaps;
    const [from] = FOAM.crest;
    const [per, lowest] = FOAM.crestReach;
    const begins = Math.max(from - Math.max(strength - 1, 0) * per, lowest);
    expect(begins).toBeLessThan(from);
    let caps = 0;
    let low = 0;
    for (let p = 0; p < s.tile.length; p++) {
      if ((s.foam[p * 4 + 2] ?? 0) > 1e-3) {
        caps++;
        if ((s.crest[p * 4] ?? 0) + FOAM.crestDetail * (s.crest[p * 4 + 1] ?? 0) < begins - 1e-3) {
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
    const monahan = Object.values(winds).map((kn) => whitecapCoverage(kn * knot));
    test.info().annotations.push({
      type: 'white share',
      description: Object.entries(winds)
        .map(
          ([name, kn], i) =>
            `${name} (${kn} kn): ${((shares[i] ?? 0) * 100).toFixed(2)}%, Monahan ${((monahan[i] ?? 0) * 100).toFixed(2)}%`,
        )
        .join('; '),
    });
    expect(shares[0]).toBe(0);
    for (let i = 1; i < shares.length; i++) {
      expect(shares[i]).toBeGreaterThanOrEqual(shares[i - 1] ?? 0);
    }
    // A fresh breeze's white is a look, a fraction of Monahan and
    // O'Muircheartaigh's cover; a gale's comes near it.
    expect((shares[2] ?? 0) / (monahan[2] ?? 1)).toBeLessThan(0.35);
    expect((shares[3] ?? 0) / (monahan[3] ?? 1)).toBeGreaterThan(0.25);
    expect((shares[3] ?? 0) / (monahan[3] ?? 1)).toBeLessThan(1.5);
    expect(shares[3]).toBeGreaterThan(5 * (shares[2] ?? 0));
  });
});

/** The wake's waves read back, laid out about a hull's straight track northward from (east, north): rows astern, columns off it. */
async function wakeGrid(
  page: Page,
  boat: { east: number; north: number },
): Promise<WakeGrid & { span: number; kind: string }> {
  const w = await page.evaluate(() => globalThis.keel.wakeWaves());
  const n = w.size;
  const texel = w.span / n;
  const astern: number[] = [];
  const off: number[] = [];
  const height: number[] = [];
  const slope: number[] = [];
  for (let col = 0; col < n; col++) {
    off.push(w.east + (col + 0.5 - n / 2) * texel - boat.east);
  }
  for (let row = 0; row < n; row++) {
    astern.push(boat.north - (w.north + (row + 0.5 - n / 2) * texel));
    for (let col = 0; col < n; col++) {
      const i = (row * n + col) * 4;
      height.push(w.data[i + 3] ?? 0);
      slope.push(Math.hypot(w.data[i] ?? 0, w.data[i + 1] ?? 0));
    }
  }
  return { astern, off, height, slope, span: w.span, kind: w.kind };
}

/** A hull sailed northward from still water at speed for seconds, with the wake's waves alone: their grid about its track. */
async function sailedWake(page: Page, speed: number, seconds = 40): Promise<WakeGrid & { span: number; kind: string }> {
  const end = await page.evaluate(
    ([speed, seconds]) =>
      globalThis.keel.runWakeWaves(seconds as number, [
        { east: 0, north: 0, heading: 0, speed: speed as number },
      ]),
    [speed, seconds],
  );
  return wakeGrid(page, end[0] as { east: number; north: number });
}

/** The length of the waves across a track at a speed, by deep water's dispersion. */
const acrossTrack = (speed: number): number => (2 * Math.PI * speed * speed) / 9.81;

/** The largest height within so far of a distance astern, metres. */
function heightAstern(g: WakeGrid, at: number, within = 0.6): number {
  const cols = g.off.length;
  let most = 0;
  g.astern.forEach((a, row) => {
    if (Math.abs(a - at) <= within) {
      for (let col = 0; col < cols; col++) {
        most = Math.max(most, Math.abs(g.height[row * cols + col] as number));
      }
    }
  });
  return most;
}

test.describe('the wake’s waves', () => {
  test.beforeEach(heavy);

  test('on the GPU are the CPU’s', async ({ page }) => {
    await openLook(page, 'sea=calm');
    const r = await page.evaluate(() => globalThis.keel.wakeWavesAgainstCPU(300));
    test.skip(r === null, 'the waves are the CPU’s own on this tier');
    if (r === null) {
      return;
    }
    // The outputs and the hulls' pressure are half floats: within two thousandths.
    expect(r.height[0]).toBeGreaterThan(1e-4);
    expect(r.height[1] / r.height[0]).toBeLessThan(2e-3);
    expect(r.slope[1] / r.slope[0]).toBeLessThan(2e-3);
    expect(r.worst / r.height[0]).toBeLessThan(0.05);
  });

  test('make Kelvin’s V, waves across the track 2πU²/g long, narrowing when fast', async ({
    page,
  }) => {
    await openLook(page, 'sea=calm');
    const low = (await page.evaluate(() => globalThis.keel.info().tier)) === 'low';
    const smooth = acrossTrack(2) / 2;
    const angles: Record<number, number> = {};
    const lengths: Record<number, number> = {};
    const heights: string[] = [];
    const length = 4.2;
    for (const speed of [2, 2.5, 3.5, 4.6]) {
      const g = await sailedWake(page, speed);
      const most = (g.span / 2) * 0.85;
      angles[speed] = wakeAngle(g, 5, 30, most, smooth);
      const want = acrossTrack(speed);
      lengths[speed] = trackWavelength(g, 3, 30, 0.6 * want, 1.5 * want);
      heights.push(
        `${speed} m/s: ${[1, 2, 5].map((l) => `${(heightAstern(g, l * length) * 100).toFixed(1)}`).join(', ')} cm`,
      );
    }
    test.info().annotations.push(
      {
        type: 'angles',
        description: Object.entries(angles)
          .map(([u, a]) => `${u} m/s ${a.toFixed(1)}°`)
          .join('; '),
      },
      {
        type: 'lengths',
        description: Object.entries(lengths)
          .map(([u, l]) => `${u} m/s ${l.toFixed(2)} m, 2πU²/g ${acrossTrack(Number(u)).toFixed(2)} m`)
          .join('; '),
      },
      { type: 'heights at 1, 2 and 5 lengths astern, linear', description: heights.join('; ') },
    );
    // Kelvin's arcsin ⅓ at a Froude number of a third.
    expect(Math.abs((angles[2] ?? 0) - 19.47)).toBeLessThan(low ? 3 : 2);
    for (const speed of [2.5, 3.5]) {
      const want = acrossTrack(speed);
      expect(Math.abs((lengths[speed] ?? 0) - want) / want).toBeLessThan(0.1);
    }
    // Rabaud and Moisy: narrower above a Froude number of a half.
    expect(angles[4.6] ?? 0).toBeLessThan((angles[2] ?? 0) - 3);
  });

  test('run on ahead and fade after a stop, and make no new V', async ({ page }) => {
    await openLook(page, 'sea=calm');
    // At 3 m/s for 20 s, then stopped dead; looked at 10 and 30 s after.
    const look = async (seconds: number) => {
      const end = await page.evaluate(
        (s) =>
          globalThis.keel.runWakeWaves(s, [{ east: 0, north: 0, heading: 0, speed: 3, stopAt: 20 }]),
        seconds,
      );
      const g = await wakeGrid(page, end[0] as { east: number; north: number });
      let ahead = 0;
      let astern = 0;
      let all = 0;
      g.astern.forEach((a, row) => {
        for (let col = 0; col < g.off.length; col++) {
          const s = (g.slope[row * g.off.length + col] ?? 0) ** 2;
          all += s;
          if (a < -4) {
            ahead = Math.max(ahead, Math.sqrt(s));
          } else if (a > 4 && a < 12 && Math.abs(g.off[col] ?? 0) < 1.5) {
            astern = Math.max(astern, Math.sqrt(s));
          }
        }
      });
      return { ahead, astern, all };
    };
    const under = await look(19);
    const after = await look(30);
    const later = await look(50);
    // The waves that followed the boat run on past it.
    expect(after.ahead).toBeGreaterThan(2 * under.ahead);
    // And fade: no new V forms behind a boat at rest.
    expect(later.all).toBeLessThan(0.5 * after.all);
    expect(later.astern).toBeLessThan(0.5 * under.astern);
  });

  test('curve with the track through a turn', async ({ page }) => {
    await openLook(page, 'sea=calm');
    // At 3 m/s, 15 s straight north, then a quarter turn to starboard over 10 s.
    const turn = Math.PI / 2 / 10;
    const end = await page.evaluate(
      (turn) =>
        globalThis.keel.runWakeWaves(25, [
          { east: 0, north: 0, heading: 0, speed: 3, turn, turnFrom: 15 },
        ]),
      turn,
    );
    const w = await page.evaluate(() => globalThis.keel.wakeWaves());
    const n = w.size;
    const texel = w.span / n;
    const slopeAt = (east: number, north: number): number => {
      const col = Math.round((east - w.east) / texel + n / 2 - 0.5);
      const row = Math.round((north - w.north) / texel + n / 2 - 0.5);
      if (col < 0 || col >= n || row < 0 || row >= n) {
        return 0;
      }
      const i = (row * n + col) * 4;
      return Math.hypot(w.data[i] ?? 0, w.data[i + 1] ?? 0);
    };
    // Across the path sailed in the turn, 2 to 7 s back, the waves lie
    // about it: their slopes' middle on each section within 2 m of the
    // path on average, and never 4 m off. A V drawn rigidly behind the hull
    // as it heads now would lie 4 to 10 m off it 4 to 7 s back.
    const last = end[0] as { east: number; north: number; heading: number };
    const r = 3 / turn;
    const cx = last.east + r * Math.cos(last.heading);
    const cy = last.north - r * Math.sin(last.heading);
    const middles: number[] = [];
    // As far back as the square holds: the low tier's is smaller.
    const back = Math.min(7, w.span / 2 / 3);
    for (let t = 2; t <= back; t += 0.5) {
      const h = last.heading - turn * t;
      const pe = cx - r * Math.cos(h);
      const pn = cy + r * Math.sin(h);
      let sum = 0;
      let moment = 0;
      for (let o = -6; o <= 6; o += 0.25) {
        const v = slopeAt(pe + Math.cos(h) * o, pn - Math.sin(h) * o) ** 2;
        sum += v;
        moment += v * o;
      }
      middles.push(moment / sum);
    }
    test.info().annotations.push({
      type: 'middles across the turn, m',
      description: middles.map((m) => m.toFixed(2)).join(', '),
    });
    const mean = middles.reduce((a, m) => a + Math.abs(m), 0) / middles.length;
    expect(mean).toBeLessThan(2);
    expect(Math.max(...middles.map(Math.abs))).toBeLessThan(4);
  });
});

test.describe('the track', () => {
  test.beforeEach(heavy);

  test('lies on the water where the boat sailed, fades, and drifts with the current', async ({
    page,
  }) => {
    await openLook(page, 'sea=breeze');
    const r = await page.evaluate(async () => {
      const k = globalThis.keel;
      const lane = (w: Awaited<ReturnType<typeof k.wakes>>) => {
        let sum = 0;
        let east = 0;
        let north = 0;
        let most = 0;
        for (let i = 0; i < w.churn.length; i++) {
          const v = w.churn[i] ?? 0;
          most = Math.max(most, v);
          if (v > 4) {
            sum += v;
            east += v * (w.east + ((i % w.size) - w.size / 2 + 0.5) * w.texel);
            north += v * (w.north + (Math.floor(i / w.size) - w.size / 2 + 0.5) * w.texel);
          }
        }
        return { sum, most, east: east / sum, north: north / sum };
      };
      k.wakes();
      // Held still in the water in a current of 1 m/s northward: no track.
      k.world.ocean.wakes.clear();
      k.runTrack(10, [{ east: 0, north: 0, heading: 0, speed: 0 }], { east: 0, north: 1 });
      const held = lane(await k.wakes());
      // Eastward at 3 m/s through the water for 10 s, in the same current;
      // then the hull is gone, and 60 s pass.
      k.world.ocean.wakes.clear();
      k.runTrack(10, [{ east: 0, north: 0, heading: Math.PI / 2, speed: 3, stopAt: 10 }], {
        east: 0,
        north: 1,
      });
      const laid = lane(await k.wakes());
      k.runTrack(10, [{ east: 0, north: 0, heading: Math.PI / 2, speed: 0 }], { east: 0, north: 1 });
      const drifted = lane(await k.wakes());
      k.runTrack(50, [{ east: 0, north: 0, heading: Math.PI / 2, speed: 0 }], { east: 0, north: 1 });
      const later = lane(await k.wakes());
      return { held, laid, drifted, later };
    });
    expect(r.held.most).toBe(0);
    expect(r.laid.most).toBeGreaterThan(40);
    // Ten seconds on, the lane has drifted ten metres north, give or take a texel.
    expect(Math.abs(r.drifted.north - r.laid.north - 10)).toBeLessThan(1.5);
    expect(Math.abs(r.drifted.east - r.laid.east)).toBeLessThan(1.5);
    // A minute on, it is nearly gone.
    expect(r.later.most).toBeLessThan(0.15 * r.laid.most);
  });

  test('follows the path the boat sailed through a turn', async ({ page }) => {
    await openLook(page, 'sea=calm');
    const r = await page.evaluate(async () => {
      const k = globalThis.keel;
      k.wakeScene('turn', 'calm');
      const path: { east: number; north: number }[] = [];
      // 20 s on the reach and 8 s into the turn, a frame a fifteenth of a second.
      for (let i = 0; i < 420; i++) {
        k.sailFrames(1);
        const s = k.boat().state;
        path.push({ east: s.x, north: s.y });
      }
      k.wakeScene(null);
      return { path, map: await k.wakes() };
    });
    const w = r.map;
    const at = (east: number, north: number): number => {
      const col = Math.round((east - w.east) / w.texel + w.size / 2 - 0.5);
      const row = Math.round((north - w.north) / w.texel + w.size / 2 - 0.5);
      return w.churn[row * w.size + col] ?? 0;
    };
    // At each place sailed 3 to 20 s ago, the lane's middle across the
    // path is within a beam of it.
    const beam = 1.39;
    let checked = 0;
    let worst = 0;
    for (let i = r.path.length - 300; i < r.path.length - 45; i += 15) {
      const p = r.path[i] as { east: number; north: number };
      const q = r.path[i + 1] as { east: number; north: number };
      const d = Math.hypot(q.east - p.east, q.north - p.north);
      const ax = -(q.north - p.north) / d;
      const ay = (q.east - p.east) / d;
      let sum = 0;
      let moment = 0;
      for (let o = -5; o <= 5; o += 0.25) {
        const v = at(p.east + ax * o, p.north + ay * o);
        sum += v;
        moment += v * o;
      }
      if (sum > 0) {
        worst = Math.max(worst, Math.abs(moment / sum));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(12);
    expect(worst).toBeLessThan(beam);
  });
});

test.describe('the hulls', () => {
  test('eight boats cost the draw calls one does', async ({ page }) => {
    heavy();
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
    // On a close reach into the gale's seas, where the boat keeps its way:
    // close to the wind it stalls in a second or two, and whether a frame
    // caught its bow plunging before then was the frame rate's doing.
    k.setState({ heading: 0.9, surge: 4, sheetLimit: 0.4 });
    k.setControls(0, 0.2);
    k.script('steer', 0.9);
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
    // A few pixels at the boat's own edges, where the deck meets the
    // cockpit, come out a little lighter with the map: on the boat, and few.
    expect(brighter).toBeLessThan(0.1 * shaded);
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
          megabytes:
            (bytes.detail + bytes.foamMap + bytes.pattern + bytes.shadowMap + bytes.wakeWaves) /
            2 ** 20,
          detail: bytes.detail / 2 ** 20,
          wakeWaves: bytes.wakeWaves / 2 ** 20,
          foamMap: bytes.foamMap / 2 ** 20,
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
      // The detail band's four a patch, and the wake's waves' four.
      expect(t.dispatches).toBe(rung.includes('× 2') ? 12 : rung.includes('²') ? 8 : 0);
      // Everything this look adds to a phone's GPU memory: the wake's waves
      // and the foam map's track 6 MB of it at most.
      expect(t.megabytes as number).toBeLessThan(18);
      expect((t.wakeWaves as number) + (t.foamMap as number)).toBeLessThan(6.5);
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
    // On a software GPU, the low tier's ladder: the same steps on cheap frames.
    await openLook(page, 'sea=fresh', !softwareGPU);
    // On CI's software GPU the page is on the low tier's ladder, of four rungs.
    const down = await page.evaluate(async (few) => {
      const k = globalThis.keel;
      const last = few ? 3 : k.info().rungs.length - 1;
      k.slowFrames(45);
      k.thaw();
      // Windows long enough to hold a dozen frames on this machine, slowed:
      // a window of fewer frames is not judged. On a software GPU a step
      // down can make every frame ten times longer, so the windows are made
      // to fit after each step, by the median of five frames (not one held
      // by a shader compiling).
      const fitWindows = async (): Promise<void> => {
        const times: number[] = [];
        for (let i = 0; i < 5; i++) {
          const t0 = performance.now();
          await k.frames(1);
          times.push(performance.now() - t0);
        }
        times.sort((a, b) => a - b);
        k.qualityTiming(Math.max(250, 12 * (times[2] ?? 0)), 1000);
      };
      await fitWindows();
      k.adapt(true);
      const start = performance.now();
      let rung = k.info().rung;
      while (k.info().rung < last && performance.now() - start < 240_000) {
        await k.frames(5);
        if (k.info().rung !== rung) {
          rung = k.info().rung;
          await fitWindows();
        }
      }
      return { rung: k.info().rung, last, tier: k.info().tier };
    }, softwareGPU);
    expect(down.rung).toBeGreaterThanOrEqual(down.last);
    if (!softwareGPU) {
      expect(down.tier).toBe('low');
    }
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
        // Soft: every picture of the test is taken, even after one differs.
        await expect.soft(page.locator('canvas.scene')).toHaveScreenshot(`look-${sea}-${view}.png`);
      }
    });
  }
});
