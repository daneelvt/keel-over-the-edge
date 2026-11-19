// SPDX-License-Identifier: AGPL-3.0-only

// Every kind the collection can hold has its glyph: an inked one for each
// kind of the sea's life and each boat (art/glyphs, lossless WebP, small),
// the chart's mark for each feature and place.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { markOf } from './logglyphs';

const GLYPHS = new URL('../../../art/glyphs/', import.meta.url);

describe('the collection’s glyphs', () => {
  test('each kind of the sea’s life and each boat has its inked glyph, lossless and small', () => {
    const ids = [...catalog.life.kinds.map((k) => k.id), ...catalog.boats.map((b) => b.id)];
    let total = 0;
    for (const id of ids) {
      const b = readFileSync(new URL(`${id}.webp`, GLYPHS));
      expect(b.subarray(0, 4).toString('latin1'), id).toBe('RIFF');
      expect(b.subarray(8, 16).toString('latin1'), id).toBe('WEBPVP8L');
      expect(b.length, id).toBeLessThan(3 * 1024);
      total += b.length;
    }
    expect(total).toBeLessThan(60 * 1024);
  });

  test('each feature and place has the chart’s mark', () => {
    for (const k of catalog.world.features.kinds) {
      expect(markOf('features', k.id), k.id).not.toBe('');
    }
    for (const k of catalog.world.places.kinds) {
      expect(markOf('places', k.id), k.id).not.toBe('');
    }
  });
});
