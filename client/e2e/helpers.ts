// SPDX-License-Identifier: AGPL-3.0-only

import { inflateSync } from 'node:zlib';
import { type Page, test } from '@playwright/test';
import type { KeelHooks } from '../src/dev/hooks';

declare global {
  // The hooks the game's page puts on window with ?test.
  var keel: KeelHooks;
}

/**
 * Opens the scene on the project's back end with the test hooks, waits for
 * the boat, freezes time and puts the boat back at the start, at rest. A
 * WebGPU project with no adapter is skipped. The screen's panels and
 * controls are hidden unless hud is true, so pictures show the scene alone.
 */
export async function openScene(page: Page, query = '', hud = false): Promise<void> {
  const backend = test.info().project.name === 'webgl2' ? '&backend=webgl2' : '';
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/?test${backend}${query === '' ? '' : `&${query}`}`);
  await page.waitForFunction(() => globalThis.keel !== undefined, null, { timeout: 30_000 });
  await page.evaluate(() => globalThis.keel.ready());
  const info = await page.evaluate(() => globalThis.keel.info());
  test.skip(
    test.info().project.name === 'webgpu' && info.backend !== 'webgpu',
    'this browser offers no WebGPU adapter',
  );
  if (errors.length > 0) {
    throw new Error(`the page failed: ${errors.join('; ')}`);
  }
  if (!hud) {
    await page.addStyleTag({ content: '.hud { visibility: hidden; }' });
  }
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
