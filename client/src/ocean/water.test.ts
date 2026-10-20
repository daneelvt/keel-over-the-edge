// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { SIGN_LOOK, signOf } from './water';

describe('the water’s signs of the wind', () => {
  test('nothing where the wind is the sea’s, a gust front where it is half again, glassy where it is half', () => {
    expect(signOf(1)).toBe(0);
    expect(signOf(1 + SIGN_LOOK.full * SIGN_LOOK.from * 0.99)).toBe(0);
    expect(signOf(1 + SIGN_LOOK.full)).toBe(1);
    expect(signOf(3)).toBe(1);
    expect(signOf(1 - SIGN_LOOK.full)).toBe(-1);
    expect(signOf(0.3)).toBe(-1);
    const a = signOf(1.2);
    const b = signOf(1.3);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(signOf(0.8)).toBeCloseTo(-a, 12);
  });
});
