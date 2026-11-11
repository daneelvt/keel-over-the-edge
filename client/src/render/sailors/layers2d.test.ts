// SPDX-License-Identifier: AGPL-3.0-only

// Many looks' textures as one array texture: each a layer, its every mip
// level's bytes in place, deeper as looks are added, never less than two
// layers deep; and a texture of another size or format refused.

import {
  type CompressedPixelFormat,
  CompressedTexture,
  RGBA_S3TC_DXT1_Format,
  RGBA_S3TC_DXT5_Format,
} from 'three';
import { expect, test } from 'vitest';
import { LayeredTexture } from './layers2d';

/** A compressed texture of size² with its mips, every byte of it fill. */
function compressed(
  size: number,
  fill: number,
  format: CompressedPixelFormat = RGBA_S3TC_DXT1_Format,
): CompressedTexture {
  const mipmaps = [];
  for (let s = size; s >= 4; s /= 2) {
    mipmaps.push({ data: new Uint8Array((s / 4) * (s / 4) * 8).fill(fill), width: s, height: s });
  }
  return new CompressedTexture(mipmaps as unknown as ImageData[], size, size, format);
}

test('each texture is a layer, the array deeper as they come', () => {
  const t = new LayeredTexture('test');
  expect(t.add(compressed(16, 1))).toBe(0);
  const first = t.texture;
  expect(first?.image.depth).toBe(2);
  // Sent to the GPU, as a renderer tells it.
  first?.onUpdate?.(first);
  expect(t.add(compressed(16, 2))).toBe(1);
  // Room for the second: the same texture, only its layer sent.
  expect(t.texture).toBe(first);
  expect([...(first?.layerUpdates ?? [])]).toEqual([1]);
  const users = [{ value: first as unknown as import('three').Texture }];
  t.users.push(...users);
  expect(t.add(compressed(16, 3))).toBe(2);
  // A third grows it: twice as deep, the old layers copied in.
  const grown = t.texture;
  expect(grown).not.toBe(first);
  expect(grown?.image.depth).toBe(4);
  expect(users[0]?.value).toBe(grown);
  const mips = grown?.mipmaps as unknown as { data: Uint8Array }[];
  for (const [level, bytes] of [
    [0, 128],
    [1, 32],
    [2, 8],
  ] as const) {
    const d = mips[level]?.data as Uint8Array;
    expect(d.length).toBe(4 * bytes);
    expect([d[0], d[bytes], d[2 * bytes], d[3 * bytes]]).toEqual([1, 2, 3, 0]);
  }
});

test('a layer added before the texture is first sent goes with it whole, not alone', () => {
  const t = new LayeredTexture('test');
  t.add(compressed(16, 1));
  const first = t.texture;
  // Two looks loaded between frames: the second's layer in place, but
  // nothing sent yet, so the whole texture is sent, every layer in it.
  expect(t.add(compressed(16, 2))).toBe(1);
  expect(t.texture).toBe(first);
  expect(first?.layerUpdates.size).toBe(0);
  expect(first?.version).toBeGreaterThan(0);
});

test('a texture of another size or format is refused', () => {
  const t = new LayeredTexture('test');
  t.add(compressed(16, 1));
  expect(t.add(compressed(32, 1))).toBe(-1);
  expect(t.add(compressed(16, 1, RGBA_S3TC_DXT5_Format))).toBe(-1);
  expect(t.count).toBe(1);
});
