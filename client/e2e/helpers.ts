// SPDX-License-Identifier: AGPL-3.0-only

import { inflateSync } from 'node:zlib';
import { type APIResponse, type BrowserContext, expect, type Page, test } from '@playwright/test';
import data from '../src/catalog/catalog.gen.json' with { type: 'json' };
import type { KeelHooks } from '../src/dev/hooks';
import { assertPasskey, createPasskey, type Passkey } from './passkey';

declare global {
  // The hooks the game's page puts on window with ?test.
  var keel: KeelHooks;
}

/**
 * Whether the browser draws on CI's software GPU (on Linux, e2e/gpu.ts),
 * where every pixel and every compute pass is the CPU's. There the pages
 * open on the cheapest rung of their ladder, unless a test asks for the
 * best: what the tests of geometry, sailing and the network check does not
 * depend on the tier, and the best rung takes minutes a test. On the Mac
 * every page opens on the best rung.
 */
// SOFTWARE_GPU=1 takes the same paths on any machine, to try them.
export const softwareGPU = process.platform === 'linux' || (process.env.SOFTWARE_GPU ?? '') !== '';

/**
 * The game's page with the test hooks, drawing nothing (?draw=off): no
 * renderer, no canvas, the scene updated every frame and never drawn. For
 * the tests of the connection, the account and the screen's words, which
 * check no picture: on CI's software GPU a page that draws takes most of a
 * minute to start beside another, and leaves the next page its backlog.
 */
export const GAME = '/?test&draw=off';

/**
 * Opens the offline sandbox on the project's back end with the test hooks,
 * waits for the boat, freezes time and puts the boat back at the start, at
 * rest, on the best rung of its ladder (on a software GPU the low tier's,
 * unless best is set). A WebGPU project with no adapter is skipped. The
 * screen's panels and controls are hidden unless hud is true, so pictures
 * show the scene alone.
 */
export async function openScene(page: Page, query = '', hud = false, best = false): Promise<void> {
  const project = test.info().project.name;
  const backend = project === 'webgl2' ? '&backend=webgl2' : project === 'compat' ? '&compat' : '';
  // On a software GPU the page holds the low tier from the start: it builds
  // one set of shaders, which takes seconds there, not two.
  if (softwareGPU && !best && !query.includes('tier=')) {
    query = query === '' ? 'tier=low' : `${query}&tier=low`;
  }
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/?sandbox&test${backend}${query === '' ? '' : `&${query}`}`);
  await page.waitForFunction(() => globalThis.keel !== undefined, null, { timeout: 30_000 });
  await page.evaluate(() => globalThis.keel.ready());
  const info = await page.evaluate(() => globalThis.keel.info());
  test.skip(
    (project === 'webgpu' || project === 'compat') && info.backend !== 'webgpu',
    'this browser offers no WebGPU adapter',
  );
  test.skip(
    project === 'compat' && !info.compat,
    'this browser offers no device held to compatibility mode',
  );
  if (errors.length > 0) {
    throw new Error(`the page failed: ${errors.join('; ')}`);
  }
  if (!hud) {
    await page.addStyleTag({ content: '.hud { visibility: hidden; }' });
  }
  // The best rung of the ladder, whatever the page's first seconds did.
  // The best rung of its ladder, whatever the page's first seconds did.
  await page.evaluate(() => globalThis.keel.setRung(0));
  await page.evaluate(() => {
    globalThis.keel.freeze(100);
    globalThis.keel.reset();
    globalThis.keel.render();
    globalThis.keel.camera('chase');
    globalThis.keel.render();
  });
}

export interface Picture {
  width: number;
  height: number;
  /** RGBA, 8 bits a channel. */
  data: Uint8Array;
}

/**
 * Decodes a PNG as screenshots write them: 8 bits a channel, RGB or RGBA,
 * not interlaced (W3C, Portable Network Graphics, 2003: filters in 9.2).
 */
export function decodePng(png: Buffer): Picture {
  let at = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colour = body[9];
      if (depth !== 8 || (colour !== 2 && colour !== 6) || body[12] !== 0) {
        throw new Error(`unsupported PNG: depth ${depth}, colour type ${colour}`);
      }
      channels = colour === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(body);
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x] ?? 0;
      const a = x >= channels ? (rows[y * stride + x - channels] ?? 0) : 0;
      const b = y > 0 ? (rows[(y - 1) * stride + x] ?? 0) : 0;
      const c = x >= channels && y > 0 ? (rows[(y - 1) * stride + x - channels] ?? 0) : 0;
      let pred = 0;
      if (filter === 1) {
        pred = a;
      } else if (filter === 2) {
        pred = b;
      } else if (filter === 3) {
        pred = (a + b) >> 1;
      } else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      rows[y * stride + x] = (v + pred) & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    for (let k = 0; k < 3; k++) {
      data[i * 4 + k] = rows[i * channels + k] ?? 0;
    }
    data[i * 4 + 3] = channels === 4 ? (rows[i * channels + 3] ?? 255) : 255;
  }
  return { width, height, data };
}

/** Draws a frame and takes it as a picture. */
export async function picture(page: Page): Promise<Picture> {
  await page.evaluate(() => globalThis.keel.show());
  return decodePng(await page.locator('canvas.scene').screenshot());
}

/** The mean absolute difference of two pictures, per channel, 0 to 255. */
export function pictureDifference(pa: Picture, pb: Picture): number {
  const a = pa.data;
  const b = pb.data;
  if (a.length !== b.length) {
    throw new Error('pictures of different sizes');
  }
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      sum += Math.abs((a[i + k] ?? 0) - (b[i + k] ?? 0));
      n++;
    }
  }
  return sum / n;
}

/** A sailor made by sailor(): its name, its passkey and its recovery code. */
export interface Made {
  name: string;
  passkey: Passkey;
  recoveryCode: string;
}

/**
 * Makes a sailor in the context, as the start screen does, through the
 * server's routes, with a passkey of the test's own: its session's cookie
 * is the context's.
 */
export async function sailor(context: BrowserContext, word = 'Sailor'): Promise<Made> {
  const name = `${word} ${Date.now() % 10_000_000}`;
  const begun = await context.request.post('/account/begin', {
    data: { name, look: data.sailors[0]?.id ?? '' },
  });
  expect(begun.status(), await begun.text()).toBe(200);
  const { passkey, answer } = createPasskey(await begun.json(), new URL(begun.url()).origin);
  const done = await context.request.post('/account/finish', { data: answer });
  expect(done.status(), await done.text()).toBe(201);
  const body = (await done.json()) as { name: string; recoveryCode: string };
  return { name: body.name, passkey, recoveryCode: body.recoveryCode };
}

/**
 * Signs in in the context through the server's routes with a passkey of the
 * test's own, as another device holding it would, no page opened: the
 * answer to /signin/finish.
 */
export async function signInWith(context: BrowserContext, p: Passkey): Promise<APIResponse> {
  const begun = await context.request.post('/signin/begin');
  expect(begun.status(), await begun.text()).toBe(200);
  const origin = new URL(begun.url()).origin;
  return context.request.post('/signin/finish', {
    data: assertPasskey({ ...p, origin }, await begun.json()),
  });
}

/**
 * Hands passkeys to the context's virtual authenticator, which stands in
 * for the browser's prompt from then on: the page signs in with them. Call
 * it before the page first asks for a passkey.
 */
export async function holdPasskeys(context: BrowserContext, ...keys: Passkey[]): Promise<void> {
  await context.credentials.install();
  for (const k of keys) {
    await context.credentials.create(k.rpId, {
      id: k.id,
      userHandle: k.userHandle,
      privateKey: k.privateKey,
      publicKey: k.publicKey,
      signCount: k.signCount,
    });
  }
}

/**
 * Sets sail from the player's own sailor, which a page with a session
 * shows before every voyage (after a reload too): taps "Set sail as" the
 * sailor, and waits for the sea.
 */
export async function setSail(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Set sail/ }).click({ timeout: 90_000 });
  await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.your-sailor')).toHaveCount(0);
}

/** Opens the game with the test hooks, drawing nothing, sets sail, and waits until it sails. */
export async function sail(page: Page, base = ''): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}${GAME}`);
  await setSail(page);
  await page.waitForFunction(() => globalThis.keel !== undefined, null, { timeout: 60_000 });
  await page.waitForFunction(() => globalThis.keel.net().status === 'sailing', null, {
    timeout: 30_000,
  });
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => globalThis.keel.info().backend)).toBe('none');
}

/** keel's internal listener, as tools/e2e serves it: its developer commands. */
const internal = 'http://127.0.0.1:19090';

/**
 * Puts the page's boat at rest in water of its own, and waits until the
 * page has it there and the move's corrections have stopped: on its heading, or off degrees off the mean wind
 * (positive with the wind over starboard), whichever way the world's wind
 * blows at the hour the test runs. Every new boat starts in the same roads, beside the
 * boats of the tests before in their grace, and the page project sails
 * three tests at once against one keel: a test that needs clean air, or
 * room beside its boat, moves it first. The spot is 1.2 to 2.1 km from the
 * boat, in a direction of its own (its number turned by the golden angle),
 * so no two tests' boats are put near each other; and within 6 km of the
 * world's centre, well inside the lip.
 */
export async function alone(page: Page, off?: number): Promise<{ east: number; north: number }> {
  const at = await page.evaluate(() => {
    const k = globalThis.keel;
    const b = k.boat();
    return {
      boat: k.net().boat,
      x: b.state.x,
      y: b.state.y,
      heading: b.state.heading,
      wind: b.wind.meanFrom,
    };
  });
  let turn = at.boat * 2.399963;
  const r = 1200 + (at.boat % 7) * 150;
  const spot = () => [at.x + r * Math.sin(turn), at.y + r * Math.cos(turn)] as const;
  if (Math.hypot(...spot()) > 6000) {
    turn += Math.PI;
  }
  const [east, north] = spot().map(Math.round) as [number, number];
  const rad = off === undefined ? at.heading : at.wind - (off * Math.PI) / 180;
  const heading = Math.round(((((rad * 180) / Math.PI) % 360) + 360) % 360);
  const res = await page.request.post(
    `${internal}/debug/place?east=${east}&north=${north}&heading=${heading}&boat=${at.boat}`,
  );
  expect(res.status(), await res.text()).toBe(200);
  await expect
    .poll(
      () =>
        page.evaluate(
          ([e, n]) => {
            const s = globalThis.keel.boat().state;
            return Math.hypot(s.x - e, s.y - n);
          },
          [east, north] as const,
        ),
      { timeout: 15_000 },
    )
    .toBeLessThan(30);
  // Settled: the move's own corrections, in flight with the snapshots,
  // all come before a test counts its own.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const was = globalThis.keel.net().counts.corrections;
          await new Promise((r) => setTimeout(r, 1000));
          return globalThis.keel.net().counts.corrections - was;
        }),
      { timeout: 15_000 },
    )
    .toBe(0);
  return { east, north };
}

/**
 * The regime tools/e2e holds the world's weather to: the catalog's
 * commonest. A spec that sets another weather goes back to it after.
 */
export function heldRegime(): string {
  let best = data.weather.regimes[0];
  for (const r of data.weather.regimes) {
    if (best === undefined || r.share > best.share) {
      best = r;
    }
  }
  return best?.id ?? '';
}
