// SPDX-License-Identifier: AGPL-3.0-only

import type { WebGPURenderer } from 'three/webgpu';
import { describe, expect, test } from 'vitest';
import { sharedByStage } from './uploads';

// three.js's own classes, which its types leave out.
interface BindingsLike {
  getSharedBindGroup(group: unknown, context: object): unknown;
  get(object: unknown): { usedTimes: number };
  _destroyBindings(groups: unknown[]): void;
}
const common = 'three/src/renderers/common';
const { default: Bindings } = (await import(/* @vite-ignore */ `${common}/Bindings.js`)) as {
  default: new (...args: unknown[]) => BindingsLike;
};
const { default: BindGroup } = (await import(/* @vite-ignore */ `${common}/BindGroup.js`)) as {
  default: new (name: string, bindings: unknown[]) => unknown;
};

const VERTEX = 1;
const FRAGMENT = 2;

/** A uniform array's binding, as a build makes it: its node's id and the stages that read it. */
function array(id: number, visibility: number): unknown {
  return { nodeUniform: { id }, visibility };
}

/** three.js's own Bindings, with the renderer's other parts stubbed, and sharedByStage on it. */
function bindings(): {
  shared(...b: unknown[]): unknown;
  letGo(group: unknown): void;
} {
  const backend = {
    renderer: { _currentRenderContext: null },
    deleteBindGroupData() {},
  };
  const b = new Bindings(backend, null, null, null, {}, {});
  sharedByStage({ _bindings: b } as unknown as WebGPURenderer);
  const context = {};
  return {
    shared: (...list) => b.getSharedBindGroup(new BindGroup('kept', list), context),
    letGo: (group) => {
      b.get(group).usedTimes = 1;
      b._destroyBindings([group]);
    },
  };
}

describe('a shared bind group', () => {
  test('is shared by builds that read its arrays in the same stages', () => {
    const b = bindings();
    const first = b.shared(array(7, FRAGMENT), array(9, VERTEX | FRAGMENT));
    expect(b.shared(array(7, FRAGMENT), array(9, VERTEX | FRAGMENT))).toBe(first);
  });

  test('is a group of its own for a build that reads an array in other stages', () => {
    // three.js keys the groups by their uniforms alone: the second build
    // would have the first's group, laid out for the fragment stage only.
    const b = bindings();
    const fragment = b.shared(array(7, FRAGMENT));
    const vertex = b.shared(array(7, VERTEX));
    expect(vertex).not.toBe(fragment);
    expect(b.shared(array(7, VERTEX))).toBe(vertex);
    expect(b.shared(array(7, FRAGMENT))).toBe(fragment);
  });

  test('let go, is made again when next asked for', () => {
    const b = bindings();
    const fragment = b.shared(array(7, FRAGMENT));
    b.letGo(fragment);
    expect(b.shared(array(7, FRAGMENT))).not.toBe(fragment);
  });
});
