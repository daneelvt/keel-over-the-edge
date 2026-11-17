// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import type { Gfx } from '../render/renderer';
import { bytesOf, FrameCounter, spread } from './counts';

describe('spread', () => {
  it('gives the median, the 90th percentile, the largest and the mean', () => {
    expect(spread([3, 1, 2])).toEqual({ median: 2, p90: 3, max: 3, mean: 2 });
    expect(spread([4, 1, 3, 2])).toEqual({ median: 2.5, p90: 4, max: 4, mean: 2.5 });
    const ten = Array.from({ length: 10 }, (_, i) => i + 1);
    expect(spread(ten).p90).toBe(9);
  });

  it('is all zeros for no values', () => {
    expect(spread([])).toEqual({ median: 0, p90: 0, max: 0, mean: 0 });
  });
});

describe('bytesOf', () => {
  it("counts a typed array's offset and size in its elements", () => {
    const f = new Float32Array(16);
    expect(bytesOf(f)).toBe(64);
    expect(bytesOf(f, 4)).toBe(48);
    expect(bytesOf(f, 4, 2)).toBe(8);
  });

  it("counts an ArrayBuffer's and a DataView's in bytes", () => {
    const b = new ArrayBuffer(100);
    expect(bytesOf(b)).toBe(100);
    expect(bytesOf(b, 10, 20)).toBe(20);
    expect(bytesOf(new DataView(b), 50)).toBe(50);
  });
});

/** Fakes of the browser's WebGPU classes, whose prototypes the counter wraps. */
class FakeQueue {
  sent = 0;
  writeBuffer(_buffer: unknown, _offset: number, data: ArrayBufferView): void {
    this.sent += data.byteLength;
  }
  writeTexture(): void {}
}
class FakeEncoder {
  beginRenderPass(): object {
    return {};
  }
}
class FakeComputePass {
  dispatchWorkgroups(): void {}
}

const globals = globalThis as Record<string, unknown>;

function fakeGfx(): Gfx {
  const info = {
    render: { frameCalls: 3, drawCalls: 40, triangles: 1000 },
    compute: { frameCalls: 2 },
  };
  return {
    backend: 'webgpu',
    canvas: { width: 640, height: 360 },
    renderer: { info, getPixelRatio: () => 1 },
  } as unknown as Gfx;
}

describe('FrameCounter', () => {
  afterEach(() => {
    delete globals.GPUQueue;
    delete globals.GPUCommandEncoder;
    delete globals.GPUComputePassEncoder;
  });

  it("counts each frame's writes, bytes, passes and dispatches, and puts the browser's calls back", () => {
    globals.GPUQueue = FakeQueue;
    globals.GPUCommandEncoder = FakeEncoder;
    globals.GPUComputePassEncoder = FakeComputePass;
    const own = FakeQueue.prototype.writeBuffer;
    const queue = new FakeQueue();
    const encoder = new FakeEncoder();
    const compute = new FakeComputePass();
    const gfx = fakeGfx();
    const c = new FrameCounter({ detail: true });
    // Writes before counting are not counted; the first frame starts the count.
    queue.writeBuffer({ label: 'before' }, 0, new Float32Array(1000));
    c.frame(gfx, 1);
    expect(c.frames).toBe(0);
    for (const n of [1, 2, 3]) {
      for (let i = 0; i < n; i++) {
        queue.writeBuffer({ label: 'bones' }, 0, new Float32Array(16));
        encoder.beginRenderPass();
      }
      queue.writeTexture();
      compute.dispatchWorkgroups();
      c.frame(gfx, n);
    }
    // The writes still reach the queue.
    expect(queue.sent).toBe(4000 + 6 * 64);
    const r = c.report();
    expect(r.frames).toBe(3);
    expect(r.writes).toMatchObject({ median: 2, max: 3 });
    expect(r.bytes).toMatchObject({ median: 128, max: 192 });
    expect(r.passes).toMatchObject({ median: 2, max: 3 });
    expect(r.dispatches.median).toBe(1);
    expect(r.textureWrites.median).toBe(1);
    expect(r.renders.median).toBe(3);
    expect(r.draws.median).toBe(40);
    expect(r.work.median).toBe(2);
    expect(r.largest[0]).toMatchObject({
      label: 'bones',
      size: 64,
      perFrame: 2,
      bytesPerFrame: 128,
    });
    expect(r.width).toBe(640);
    c.detach();
    expect(FakeQueue.prototype.writeBuffer).toBe(own);
    expect(Object.hasOwn(FakeEncoder.prototype, 'beginRenderPass')).toBe(true);
    queue.writeBuffer({ label: 'after' }, 0, new Float32Array(1));
    expect(c.report().writes.max).toBe(3);
  });

  it('wraps nothing of the GPU when asked for the work alone', () => {
    globals.GPUQueue = FakeQueue;
    const own = FakeQueue.prototype.writeBuffer;
    const c = new FrameCounter({ gpu: false });
    const gfx = fakeGfx();
    c.frame(gfx, 0);
    expect(FakeQueue.prototype.writeBuffer).toBe(own);
    new FakeQueue().writeBuffer({}, 0, new Float32Array(4));
    c.frame(gfx, 5);
    const r = c.report();
    expect(r.writes.max).toBe(0);
    expect(r.work.median).toBe(5);
    c.detach();
  });
});
