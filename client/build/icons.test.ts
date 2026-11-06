// SPDX-License-Identifier: AGPL-3.0-only

// The web app manifest and the icons, as the build copies them to the
// page's top level: the fields a phone installs the game by, each icon at
// the size it states, and each icon the drawing as art/icon draws it, so
// a changed drawing is rebuilt (node art/icon/build.ts) before it ships.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { FRAMES, rasterise, readPng, SLATE, TILE, TILE_BOAT } from '../../art/icon/icon.ts';

const pub = (name: string) => new URL(`../public/${name}`, import.meta.url);

interface Icon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

describe('the web app manifest', () => {
  const manifest = JSON.parse(readFileSync(pub('manifest.webmanifest'), 'utf8')) as Record<
    string,
    unknown
  >;

  test('opens the game full screen from its icon, either way up', () => {
    expect(manifest).toMatchObject({
      id: '/',
      name: 'Keel Over the Edge',
      short_name: 'Keel',
      start_url: '/',
      scope: '/',
      display: 'fullscreen',
    });
    expect(manifest).not.toHaveProperty('orientation');
    // One colour from the icon on: the splash a phone draws from the
    // manifest, the page's first paint, its cover and the icon's slate.
    const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const theme = /<meta name="theme-color" content="(#[0-9a-f]{6})"/.exec(page)?.[1];
    expect(theme).toBe(SLATE);
    expect(manifest.theme_color).toBe(theme);
    expect(manifest.background_color).toBe(theme);
    expect(page).toContain(`background: ${theme};`);
  });

  test('names Chrome’s icons, 192 and 512, and a maskable one, each at the size it states', () => {
    const icons = manifest.icons as Icon[];
    expect(icons.map((i) => [i.sizes, i.purpose])).toEqual([
      ['192x192', 'any'],
      ['512x512', 'any'],
      ['512x512', 'maskable'],
    ]);
    for (const i of icons) {
      expect(i.type).toBe('image/png');
      const { width, height } = readPng(readFileSync(pub(i.src.replace(/^\//, ''))));
      expect(`${width}x${height}`, i.src).toBe(i.sizes);
    }
  });

  test('is linked from the page, with the favicon and the iPhone’s icon', () => {
    const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    expect(page).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(page).toContain('href="/icon-192.png"');
    expect(page).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(readPng(readFileSync(pub('apple-touch-icon.png'))).width).toBe(180);
  });
});

describe('the icons', () => {
  test.each(FRAMES.map((f) => [f.file, f] as const))('%s is the drawing', (_, frame) => {
    const { width, rgba } = readPng(readFileSync(pub(frame.file)));
    expect(width).toBe(frame.size);
    const drawn = rasterise(frame);
    let worst = 0;
    for (let i = 0; i < drawn.length; i++) {
      worst = Math.max(worst, Math.abs((drawn[i] as number) - (rgba[i] as number)));
    }
    // One step of rounding either way; anything more is a changed drawing.
    expect(worst, 'rebuild the icons: node art/icon/build.ts').toBeLessThanOrEqual(1);
  });

  test('every icon is the one drawing, the tile, the favicon and the cover too', () => {
    for (const frame of FRAMES) {
      expect(frame.drawing, frame.file).toBe(TILE);
      expect(frame.unit, frame.file).toBe(0.5);
    }
  });

  test('the home screen icons keep the boat within the middle 80%, sky and sea to the edges', () => {
    // The circle of radius 0.8 about the middle every launcher's mask keeps.
    for (const s of TILE_BOAT) {
      for (const c of s.contours) {
        for (const [x, y] of c) {
          expect(Math.hypot(x, y)).toBeLessThanOrEqual(0.8);
        }
      }
    }
    for (const file of ['icon-maskable-512.png', 'apple-touch-icon.png']) {
      const frame = FRAMES.find((f) => f.file === file) as (typeof FRAMES)[number];
      expect(frame.corner, file).toBe(0);
      const rgba = rasterise(frame);
      const n = frame.size;
      // Every edge pixel opaque, and none of it the slate beneath.
      for (let i = 0; i < n; i++) {
        for (const at of [i, (n - 1) * n + i, i * n, i * n + n - 1]) {
          expect(rgba[at * 4 + 3], file).toBe(255);
          expect(rgba[at * 4 + 2], file).toBeGreaterThan(0x2c);
        }
      }
    }
  });
});
