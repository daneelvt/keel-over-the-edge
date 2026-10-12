// SPDX-License-Identifier: AGPL-3.0-only

import { HalfFloatType, UnsignedByteType } from 'three';
import { describe, expect, test } from 'vitest';
import { chooseBackend, outputBufferType, wantsCompat } from './renderer';
import { percentile } from './stats';

describe('the back end', () => {
  test('is WebGPU where offered, WebGL 2 when forced or without it', () => {
    expect(chooseBackend(new URLSearchParams(''), true)).toBe('webgpu');
    expect(chooseBackend(new URLSearchParams('backend=webgl2'), true)).toBe('webgl2');
    expect(chooseBackend(new URLSearchParams(''), false)).toBe('webgl2');
    expect(chooseBackend(new URLSearchParams('backend=webgpu'), false)).toBe('webgl2');
  });

  test('is held to compatibility mode with ?compat', () => {
    expect(wantsCompat(new URLSearchParams('compat'))).toBe(true);
    expect(wantsCompat(new URLSearchParams('compat=1&dev'))).toBe(true);
    expect(wantsCompat(new URLSearchParams('dev'))).toBe(false);
  });

  test('outputs half float on WebGPU, 8-bit on WebGL 2', () => {
    expect(outputBufferType('webgpu')).toBe(HalfFloatType);
    expect(outputBufferType('webgl2')).toBe(UnsignedByteType);
  });
});

describe('frame statistics', () => {
  test('percentiles of sorted frame times', () => {
    const s = Float64Array.from([10, 11, 12, 13, 14, 15, 16, 17, 18, 40]);
    expect(percentile(s, 10, 0.5)).toBe(14);
    expect(percentile(s, 10, 0.9)).toBe(18);
    expect(percentile(s, 0, 0.9)).toBe(0);
  });
});
