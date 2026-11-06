// SPDX-License-Identifier: AGPL-3.0-only

// Every look told apart from every other in silhouette, from behind and
// from above: what the game shows of a sailor at play size is mostly the
// hat, the hair and what hangs from them, and two looks that make the same
// black shape cannot be told apart in the fleet.
//
// Each look's deck level, as the build committed it (art/sailors/<look>/),
// standing at rest, is drawn in black at play size (a pixel 2.5 cm, the
// figure about 70 pixels high), and only its head and shoulders are
// compared, within a box about the head: below and beside it every look is
// the same body in the same pose, its arms spread, which would hide the
// difference. From behind, the body's crown on one row, so a hat stands as
// high above it as it is; from above, what is higher than the shoulders,
// the figure's middle in the middle.
// Two looks of a version are apart when, in each view, at least DIFFER of
// the pixels either has in the box are not the other's. A look's two
// versions may be as like each other as they are; the test sailor and the
// build's inputs are no looks.

import { readdirSync, readFileSync } from 'node:fs';
import { MeshoptDecoder } from 'meshoptimizer';
import { describe, expect, test } from 'vitest';

const ART = new URL('../../../../art/sailors/', import.meta.url);

/** A pixel's side, in metres, and the drawings' size in pixels. */
const PIXEL = 0.025;
const SIZE = 80;
/** From behind: the room above the crown, and how far below it the box goes. */
const ABOVE_CROWN = 0.3;
const BELOW_CROWN = 0.25;
/** How far the box goes to each side of the middle, and (from above) before and behind it. */
const SIDE = 0.3;
const DEPTH = 0.3;
/** The least share of two looks' pixels not in common, in each view. */
const DIFFER = 0.2;

interface Gltf {
  nodes: { name?: string; mesh?: number }[];
  meshes: { primitives: { attributes: { POSITION: number }; indices: number }[] }[];
  accessors: {
    bufferView: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
  }[];
  bufferViews: {
    byteOffset?: number;
    byteLength: number;
    extensions?: {
      EXT_meshopt_compression?: {
        byteOffset?: number;
        byteLength: number;
        byteStride: number;
        count: number;
        mode: 'ATTRIBUTES' | 'TRIANGLES' | 'INDICES';
        filter?: 'NONE' | 'OCTAHEDRAL' | 'QUATERNION' | 'EXPONENTIAL';
      };
    };
  }[];
}

interface Figure {
  /** Every triangle's corners, x, y (up) and z (forward), as the file has them. */
  triangles: Float32Array;
  /** The height of the crown of the body's head. */
  crown: number;
}

/** A level's meshes as triangles, at rest (the build keeps positions as floats). */
async function figure(path: string): Promise<Figure> {
  const glb = readFileSync(new URL(path, ART));
  const length = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + length).toString('utf8')) as Gltf;
  const bin = glb.subarray(20 + length + 8);
  await MeshoptDecoder.ready;
  const views = json.bufferViews.map((v) => {
    const m = v.extensions?.EXT_meshopt_compression;
    if (m === undefined) {
      return bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
    }
    const out = new Uint8Array(m.count * m.byteStride);
    const source = bin.subarray(m.byteOffset ?? 0, (m.byteOffset ?? 0) + m.byteLength);
    MeshoptDecoder.decodeGltfBuffer(out, m.count, m.byteStride, source, m.mode, m.filter ?? 'NONE');
    return out;
  });
  const read = (index: number): Float32Array | Uint16Array | Uint32Array => {
    const a = json.accessors[index];
    const view = a === undefined ? undefined : views[a.bufferView];
    if (a === undefined || view === undefined) {
      throw new Error(`${path}: no accessor ${index}`);
    }
    const width = a.type === 'VEC3' ? 3 : 1;
    const start = a.byteOffset ?? 0;
    const size = a.componentType === 5123 ? 2 : 4;
    const bytes = view.slice(start, start + a.count * width * size);
    switch (a.componentType) {
      case 5126:
        return new Float32Array(bytes.buffer);
      case 5123:
        return new Uint16Array(bytes.buffer);
      case 5125:
        return new Uint32Array(bytes.buffer);
      default:
        throw new Error(`${path}: an accessor of component type ${a.componentType}`);
    }
  };
  const corners: number[] = [];
  let crown = Number.NEGATIVE_INFINITY;
  for (const node of json.nodes) {
    const mesh = node.mesh === undefined ? undefined : json.meshes[node.mesh];
    for (const prim of mesh?.primitives ?? []) {
      const p = read(prim.attributes.POSITION);
      for (const i of read(prim.indices)) {
        corners.push(p[i * 3] ?? 0, p[i * 3 + 1] ?? 0, p[i * 3 + 2] ?? 0);
      }
      if (node.name === 'body') {
        for (let i = 1; i < p.length; i += 3) {
          crown = Math.max(crown, p[i] ?? 0);
        }
      }
    }
  }
  return { triangles: new Float32Array(corners), crown };
}

/** The figure's triangles that reach higher than y. */
function higher(f: Figure, y: number): Figure {
  const kept: number[] = [];
  const t = f.triangles;
  for (let k = 0; k < t.length; k += 9) {
    if (Math.max(t[k + 1] ?? 0, t[k + 4] ?? 0, t[k + 7] ?? 0) >= y) {
      for (let i = 0; i < 9; i++) {
        kept.push(t[k + i] ?? 0);
      }
    }
  }
  return { ...f, triangles: new Float32Array(kept) };
}

/**
 * The figure in black: across the drawing x (the figure's middle in the
 * middle), down it the coordinate given (from at, at row 0, falling or
 * rising as asked).
 */
function draw(f: Figure, down: 1 | 2, at: number, sign: 1 | -1): Uint8Array {
  const out = new Uint8Array(SIZE * SIZE);
  const t = f.triangles;
  const x = (i: number) => SIZE / 2 + (t[i] ?? 0) / PIXEL;
  const y = (i: number) => (sign * (at - (t[i + down] ?? 0))) / PIXEL;
  for (let k = 0; k < t.length; k += 9) {
    const [ax, ay, bx, by, cx, cy] = [x(k), y(k), x(k + 3), y(k + 3), x(k + 6), y(k + 6)];
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(area) < 1e-9) {
      continue;
    }
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const y1 = Math.min(SIZE - 1, Math.ceil(Math.max(ay, by, cy)));
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const x1 = Math.min(SIZE - 1, Math.ceil(Math.max(ax, bx, cx)));
    for (let row = y0; row <= y1; row++) {
      for (let col = x0; col <= x1; col++) {
        const px = col + 0.5;
        const py = row + 0.5;
        const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / area;
        const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / area;
        if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) {
          out[row * SIZE + col] = 1;
        }
      }
    }
  }
  return out;
}

/** The share of the pixels either drawing has in the box that the other has not. */
function differ(a: Uint8Array, b: Uint8Array, rows: [number, number]): number {
  const half = Math.round(SIDE / PIXEL);
  let both = 0;
  let either = 0;
  for (let y = rows[0]; y < rows[1]; y++) {
    for (let x = SIZE / 2 - half; x < SIZE / 2 + half; x++) {
      const i = y * SIZE + x;
      both += (a[i] ?? 0) & (b[i] ?? 0);
      either += (a[i] ?? 0) | (b[i] ?? 0);
    }
  }
  return either === 0 ? 0 : 1 - both / either;
}

/** The looks the build committed: each folder with a deck level, but the test sailor's and the inputs. */
const looks = readdirSync(ART, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !['test', 'vendor'].includes(d.name))
  .filter((d) => readdirSync(new URL(`${d.name}/`, ART)).some((f) => f.endsWith('.deck.glb')))
  .map((d) => d.name);

/** A look's version drawn from behind and from above. */
async function drawings(look: string, version: string) {
  const f = await figure(`${look}/${version}.deck.glb`);
  return {
    look,
    behind: draw(f, 1, f.crown + ABOVE_CROWN, 1),
    // Only what is higher than the shoulders (the hat, the head and what
    // hangs from them): the shoulders and arms spread under them would
    // fill the drawing alike. Its front toward the bottom of the drawing,
    // its middle (z = 0) in the middle.
    above: draw(higher(f, f.crown - BELOW_CROWN), 2, -(SIZE / 2) * PIXEL, -1),
  };
}

test('there are looks to tell apart', () => {
  expect(looks).toContain('rover');
  expect(looks.length).toBeGreaterThan(1);
});

describe.each(['female', 'male'])('%s', (version) => {
  test('every look is told apart from every other, from behind and from above', async () => {
    const all = await Promise.all(looks.map((look) => drawings(look, version)));
    const behindRows: [number, number] = [0, Math.round((ABOVE_CROWN + BELOW_CROWN) / PIXEL)];
    const depth = Math.round(DEPTH / PIXEL);
    const aboveRows: [number, number] = [SIZE / 2 - depth, SIZE / 2 + depth];
    const close: string[] = [];
    for (const [i, a] of all.entries()) {
      for (const b of all.slice(i + 1)) {
        const behind = differ(a.behind, b.behind, behindRows);
        const above = differ(a.above, b.above, aboveRows);
        if (behind < DIFFER || above < DIFFER) {
          close.push(
            `${a.look} and ${b.look}: ${behind.toFixed(2)} apart from behind, ${above.toFixed(2)} from above`,
          );
        }
      }
    }
    expect(close).toEqual([]);
  });
});
