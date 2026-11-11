// SPDX-License-Identifier: AGPL-3.0-only

// The swimmers' bodies as art/life/build.ts writes them: each one a node
// of its name whose extras give the length it was built at, as long as
// that, within its budget of triangles, and carrying what the page reads
// from its vertices: COLOR_0 (the back's share, a dark mark, a paddle) and
// TEXCOORD_0 (its share along the body by its z, and out along a paddle).
// A changed body is rebuilt (node art/life/build.ts) before it ships.

import { readFileSync } from 'node:fs';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { beforeAll, describe, expect, test } from 'vitest';

/** Each body: the length it is built at, m, and its triangles' most. */
const BODIES: Record<string, { length: number; budget: number }> = {
  dolphin: { length: 2.2, budget: 320 },
  turtle: { length: 1.0, budget: 320 },
  flyingfish: { length: 0.3, budget: 160 },
  tarpon: { length: 1.5, budget: 320 },
  humpback: { length: 14, budget: 320 },
  sperm: { length: 12, budget: 320 },
  pilot: { length: 4.5, budget: 320 },
  ray: { length: 1.1, budget: 320 },
  shark: { length: 2.7, budget: 320 },
  booby: { length: 0.75, budget: 320 },
  'booby-asleep': { length: 0.56, budget: 320 },
};

/** The bodies with paddles: the parts that stroke on their own. */
const PADDLES = ['dolphin', 'turtle', 'flyingfish', 'humpback', 'pilot', 'ray', 'shark'];

interface Accessor {
  bufferView: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  normalized?: boolean;
  min?: number[];
  max?: number[];
}

interface Gltf {
  nodes: { name: string; mesh?: number; extras?: { length?: number } }[];
  meshes: { primitives: { attributes: Record<string, number>; indices: number }[] }[];
  accessors: Accessor[];
  bufferViews: {
    byteLength: number;
    byteStride?: number;
    extensions?: {
      EXT_meshopt_compression?: {
        byteOffset?: number;
        byteLength: number;
        byteStride: number;
        count: number;
        mode: string;
        filter?: string;
      };
    };
  }[];
}

const glb = new Uint8Array(readFileSync(new URL('../../art/life/swimmers.glb', import.meta.url)));
const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
const jsonLength = dv.getUint32(12, true);
const gltf = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as Gltf;
const bin = glb.subarray(20 + jsonLength + 8);

const views = new Map<number, Uint8Array>();
beforeAll(async () => {
  await MeshoptDecoder.ready;
  gltf.bufferViews.forEach((v, i) => {
    const m = v.extensions?.EXT_meshopt_compression;
    if (m === undefined) {
      return;
    }
    const out = new Uint8Array(m.count * m.byteStride);
    const src = bin.subarray(m.byteOffset ?? 0, (m.byteOffset ?? 0) + m.byteLength);
    MeshoptDecoder.decodeGltfBuffer(out, m.count, m.byteStride, src, m.mode, m.filter ?? 'NONE');
    views.set(i, out);
  });
});

const SIZES: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/** An accessor's values, as floats (normalised bytes read as 0..1). */
function read(index: number): number[][] {
  const a = gltf.accessors[index] as Accessor;
  const view = views.get(a.bufferView) as Uint8Array;
  const stride = gltf.bufferViews[a.bufferView]?.byteStride ?? 0;
  const size = SIZES[a.type] as number;
  const d = new DataView(view.buffer, view.byteOffset, view.byteLength);
  const out: number[][] = [];
  for (let i = 0; i < a.count; i++) {
    const at = (a.byteOffset ?? 0) + i * stride;
    const row: number[] = [];
    for (let k = 0; k < size; k++) {
      if (a.componentType === 5126) {
        row.push(d.getFloat32(at + k * 4, true));
      } else if (a.componentType === 5121) {
        row.push(d.getUint8(at + k) / (a.normalized === true ? 255 : 1));
      } else {
        row.push(d.getUint16(at + k * 2, true) / (a.normalized === true ? 65535 : 1));
      }
    }
    out.push(row);
  }
  return out;
}

const bodies = Object.entries(BODIES);
const primitive = (name: string) => {
  const node = gltf.nodes.find((n) => n.name === name);
  return gltf.meshes[node?.mesh ?? -1]?.primitives[0];
};

describe('the swimmers', () => {
  test('are the bodies, each named, each with the length it was built at', () => {
    const named = gltf.nodes.filter((n) => n.mesh !== undefined);
    expect(named.map((n) => n.name).sort()).toEqual(Object.keys(BODIES).sort());
    for (const n of named) {
      expect(n.extras?.length, n.name).toBe(BODIES[n.name]?.length);
    }
  });

  test.each(bodies)('%s is as long as it was built, centred, within its budget', (name, b) => {
    const p = primitive(name);
    expect(p).toBeDefined();
    const pos = gltf.accessors[p?.attributes.POSITION ?? -1] as Accessor;
    const [z0, z1] = [pos.min?.[2] ?? 0, pos.max?.[2] ?? 0];
    expect(Math.abs(z1 - z0 - b.length)).toBeLessThanOrEqual(0.02 * b.length);
    expect(Math.abs(z1 + z0) / 2).toBeLessThanOrEqual(0.01 * b.length);
    const triangles = (gltf.accessors[p?.indices ?? -1]?.count ?? Infinity) / 3;
    expect(triangles, 'rebuild the bodies: node art/life/build.ts').toBeLessThanOrEqual(b.budget);
  });

  test.each(bodies)('%s carries its paint and its place along it', (name, b) => {
    const p = primitive(name);
    expect(p?.attributes).toHaveProperty('COLOR_0');
    expect(p?.attributes).toHaveProperty('TEXCOORD_0');
    const at = read(p?.attributes.POSITION ?? -1);
    const colour = read(p?.attributes.COLOR_0 ?? -1);
    const uv = read(p?.attributes.TEXCOORD_0 ?? -1);
    let paddles = 0;
    let reach = 0;
    at.forEach((q, i) => {
      const [u, v] = uv[i] as number[];
      const c = colour[i] as number[];
      // u is the vertex's share along the body, snout tip to tail tip, by its z.
      expect(u).toBeCloseTo((q[2] as number) / b.length + 0.5, 3);
      // b is a paddle or not; off a paddle, v is naught.
      expect([0, 1]).toContain(c[2]);
      if (c[2] === 1) {
        paddles++;
        reach = Math.max(reach, v as number);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      } else {
        expect(v).toBe(0);
      }
    });
    if (PADDLES.includes(name)) {
      expect(paddles).toBeGreaterThan(0);
      expect(reach).toBeCloseTo(1, 3);
    } else {
      expect(paddles).toBe(0);
    }
  });
});
