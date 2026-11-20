// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { foldedAtFirst, keptFolds } from './fold';

describe('the world’s cards folded', () => {
  test('on a phone all start folded but the few read most; on a wide screen none', () => {
    expect(foldedAtFirst('Islands', true)).toBe(true);
    expect(foldedAtFirst('Boats at sea', true)).toBe(false);
    expect(foldedAtFirst('The world', true)).toBe(false);
    expect(foldedAtFirst('Islands', false)).toBe(false);
  });

  test('what was kept is read, and anything else is nothing kept', () => {
    expect(keptFolds('{"Islands":true,"Towns":false}')).toEqual({ Islands: true, Towns: false });
    expect(keptFolds('{"Islands":"yes","Towns":1}')).toEqual({});
    expect(keptFolds(null)).toEqual({});
    expect(keptFolds('[true]')).toEqual({});
    expect(keptFolds('not json')).toEqual({});
  });
});
