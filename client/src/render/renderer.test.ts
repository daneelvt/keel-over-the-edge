// SPDX-License-Identifier: AGPL-3.0-only

import { HalfFloatType, UnsignedByteType } from 'three';
import { describe, expect, test } from 'vitest';
import { chooseBackend, defaultRenderScale, outputBufferType } from './renderer';
import { percentile } from './stats';

describe('the back end', () => {
  test('is WebGPU where offered, WebGL 2 when forced or without it', () => {
    expect(chooseBackend(new URLSearchParams(''), true)).toBe('webgpu');
    expect(chooseBackend(new URLSearchParams('backend=webgl2'), true)).toBe('webgl2');
    expect(chooseBackend(new URLSearchParams(''), false)).toBe('webgl2');
    expect(chooseBackend(new URLSearchParams('backend=webgpu'), false)).toBe('webgl2');
  });

  test('draws at up to 2 on WebGPU, 1.5 in compatibility mode, 1 on WebGL 2', () => {
    expect(defaultRenderScale('webgpu', false, 3)).toBe(2);
    expect(defaultRenderScale('webgpu', false, 1.25)).toBe(1.25);
    expect(defaultRenderScale('webgpu', true, 3)).toBe(1.5);
    expect(defaultRenderScale('webgl2', false, 3)).toBe(1);
    expect(defaultRenderScale('webgl2', false, 0.5)).toBe(1);
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
