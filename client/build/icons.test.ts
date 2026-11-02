// SPDX-License-Identifier: AGPL-3.0-only

// The web app manifest and the icons, as the build copies them to the
// page's top level: the fields a phone installs the game by, each icon at
// the size it states, and each icon the drawing as art/icon draws it, so
// a changed drawing is rebuilt (node art/icon/build.ts) before it ships.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { FRAMES, rasterise, readPng } from '../../art/icon/icon.ts';

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
    // The page's own colour, behind the start screen.
    const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const theme = /<meta name="theme-color" content="(#[0-9a-f]{6})"/.exec(page)?.[1];
    expect(manifest.theme_color).toBe(theme);
    expect(manifest.background_color).toBe(theme);
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

  test('the maskable icon keeps the ring within the middle 80%, the slate to the edges', () => {
    const frame = FRAMES.find((f) => f.file === 'icon-maskable-512.png');
    expect(frame?.ring).toBeLessThanOrEqual(0.4);
    const rgba = rasterise(frame as (typeof FRAMES)[number]);
    // Every corner pixel opaque.
    for (const at of [0, 511, 511 * 512, 512 * 512 - 1]) {
      expect(rgba[at * 4 + 3]).toBe(255);
    }
  });
});
