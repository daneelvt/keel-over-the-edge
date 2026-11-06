// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { type PortraitColours, recolour } from './portrait';

/** sRGB byte of a linear value. */
const byte = (linear: number): number =>
  Math.round(255 * (linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055));
/** A linear value of an sRGB byte. */
const lin = (b: number): number => {
  const c = b / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** The neutral grey the option regions are stored in: 0.5 in linear light. */
const GREY = byte(0.5);

/** Recolours one pixel: its base RGBA and its mask's shares (RGB, 0 to 255). */
function one(base: number[], mask: number[], colours: PortraitColours): number[] {
  const out = new Uint8ClampedArray(4);
  recolour(new Uint8ClampedArray(base), new Uint8ClampedArray([...mask, 255]), colours, out);
  return [...out];
}

const COLOURS: PortraitColours = { main: '#9B2226', skin: '#946145', hair: '#834328' };

describe('recolouring a portrait', () => {
  test('a region’s neutral grey becomes its colour exactly', () => {
    expect(one([GREY, GREY, GREY, 255], [255, 0, 0], COLOURS)).toEqual([0x9b, 0x22, 0x26, 255]);
    expect(one([GREY, GREY, GREY, 255], [0, 255, 0], COLOURS)).toEqual([0x94, 0x61, 0x45, 255]);
    expect(one([GREY, GREY, GREY, 255], [0, 0, 255], COLOURS)).toEqual([0x83, 0x43, 0x28, 255]);
  });

  test('shading is kept: a region in shadow is its colour in shadow, in linear light', () => {
    // A quarter of the light on the grey.
    const [r, g, b] = one([byte(0.125), byte(0.125), byte(0.125), 255], [255, 0, 0], COLOURS);
    const want = [0x9b, 0x22, 0x26].map((c) => byte(lin(c) / 4));
    for (const [i, c] of [r, g, b].entries()) {
      expect(Math.abs((c as number) - (want[i] as number))).toBeLessThanOrEqual(1);
    }
  });

  test('the fixed parts, outside every region, keep their own colours', () => {
    expect(one([40, 120, 200, 255], [0, 0, 0], COLOURS)).toEqual([40, 120, 200, 255]);
  });

  test('a pixel shared between regions takes each colour by its share', () => {
    const [r, g, b] = one([GREY, GREY, GREY, 255], [128, 127, 0], COLOURS);
    const main = [0x9b, 0x22, 0x26].map(lin);
    const skin = [0x94, 0x61, 0x45].map(lin);
    for (let c = 0; c < 3; c++) {
      const want = byte(
        0.5 *
          (1 +
            (128 / 255) * (2 * (main[c] as number) - 1) +
            (127 / 255) * (2 * (skin[c] as number) - 1)),
      );
      expect(Math.abs(([r, g, b][c] as number) - want)).toBeLessThanOrEqual(1);
    }
  });

  test('the alpha round the figure is kept, and a region past white is held at white', () => {
    expect(one([GREY, GREY, GREY, 77], [255, 0, 0], COLOURS)[3]).toBe(77);
    expect(one([250, 250, 250, 255], [255, 0, 0], { ...COLOURS, main: '#FFFFFF' })).toEqual([
      255, 255, 255, 255,
    ]);
  });

  test('a machine has no hair: its colours leave the base where the mask has blue', () => {
    expect(one([GREY, 90, 30, 255], [0, 0, 255], { main: '#1E1E1E', skin: '#D9A957' })).toEqual([
      GREY,
      90,
      30,
      255,
    ]);
  });

  test('every pixel of a picture is recoloured', () => {
    const n = 256 * 320;
    const base = new Uint8ClampedArray(n * 4).fill(GREY);
    const mask = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      mask[i * 4 + (i % 3)] = 255;
      mask[i * 4 + 3] = 255;
    }
    const out = new Uint8ClampedArray(n * 4);
    recolour(base, mask, COLOURS, out);
    const regions = [
      [0x9b, 0x22, 0x26],
      [0x94, 0x61, 0x45],
      [0x83, 0x43, 0x28],
    ];
    for (const i of [0, 1, 2, n - 3, n - 2, n - 1]) {
      expect([...out.subarray(i * 4, i * 4 + 4)]).toEqual([...(regions[i % 3] as number[]), GREY]);
    }
  });
});

// The pictures the sailors' build makes beside each look's levels.
const SAILORS = new URL('../../../art/sailors/', import.meta.url);
const looks = readdirSync(SAILORS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== 'test')
  .filter((d) => readdirSync(new URL(`${d.name}/`, SAILORS)).some((f) => /^[a-z]+\.glb$/.test(f)))
  .map((d) => d.name);

describe.each(looks)('the %s look', (look) => {
  const versions = readdirSync(new URL(`${look}/`, SAILORS))
    .map((f) => /^([a-z]+)\.glb$/.exec(f)?.[1])
    .filter((v) => v !== undefined);

  test.each(versions)('%s has both portraits, at their sizes', (version) => {
    const at = (file: string) => readFileSync(new URL(`${look}/${version}.${file}`, SAILORS));
    const sizes = {
      base: webpSize(at('portrait.webp')),
      mask: webpSize(at('portrait-mask.webp')),
      ink: webpSize(at('ink.webp')),
    };
    expect(sizes).toEqual({ base: [256, 320], mask: [256, 320], ink: [512, 640] });
    // An AVIF file: its box says so.
    expect(at('portrait.avif').subarray(4, 12).toString('latin1')).toBe('ftypavif');
  });
});

/** A WebP file's width and height, from its header (lossy, lossless or extended). */
function webpSize(b: Buffer): [number, number] {
  expect(b.subarray(0, 4).toString('latin1')).toBe('RIFF');
  expect(b.subarray(8, 12).toString('latin1')).toBe('WEBP');
  const kind = b.subarray(12, 16).toString('latin1');
  if (kind === 'VP8X') {
    return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
  }
  if (kind === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return [1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)];
  }
  return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
}
