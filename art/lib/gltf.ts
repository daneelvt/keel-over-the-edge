// SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
// Art: all rights reserved, not covered by the AGPL. See art/README.md.

// Writes a glTF 2.0 binary (.glb) from a tree of nodes, each with an
// optional mesh of primitives, and a list of materials. Positions, normals,
// texture coordinates and colours are float32; indices are 16- or 32-bit.
// The format: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html

export interface Primitive {
  material: string;
  positions: number[];
  normals: number[];
  /** TEXCOORD_0, and TEXCOORD_1 when given. */
  uvs?: number[];
  uvs2?: number[];
  /** COLOR_0: linear RGB. */
  colors?: number[];
  indices: number[];
}

export interface NodeDef {
  name: string;
  translation?: [number, number, number];
  primitives?: Primitive[];
  children?: NodeDef[];
}

export interface MaterialDef {
  name: string;
  /** Linear RGB. */
  color: [number, number, number];
  roughness: number;
  metalness: number;
  doubleSided?: boolean;
}

interface Accessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

export function writeGlb(roots: NodeDef[], materials: MaterialDef[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const bufferViews: { buffer: number; byteOffset: number; byteLength: number; target: number }[] =
    [];
  const accessors: Accessor[] = [];
  const meshes: { name: string; primitives: unknown[] }[] = [];
  const nodes: Record<string, unknown>[] = [];
  const materialIndex = new Map(materials.map((m, i) => [m.name, i]));

  const view = (bytes: Uint8Array, target: number): number => {
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad > 0) {
      chunks.push(new Uint8Array(pad));
      byteLength += pad;
    }
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength, target });
    chunks.push(bytes);
    byteLength += bytes.byteLength;
    return bufferViews.length - 1;
  };

  const floats = (data: number[], size: number, withBounds: boolean): number => {
    const arr = Float32Array.from(data);
    const acc: Accessor = {
      bufferView: view(new Uint8Array(arr.buffer), ARRAY_BUFFER),
      componentType: FLOAT,
      count: data.length / size,
      type: size === 2 ? 'VEC2' : size === 3 ? 'VEC3' : 'VEC4',
    };
    if (withBounds) {
      const min = new Array(size).fill(Infinity);
      const max = new Array(size).fill(-Infinity);
      for (let i = 0; i < arr.length; i++) {
        const k = i % size;
        min[k] = Math.min(min[k], arr[i] ?? 0);
        max[k] = Math.max(max[k], arr[i] ?? 0);
      }
      acc.min = min;
      acc.max = max;
    }
    accessors.push(acc);
    return accessors.length - 1;
  };

  const indices = (data: number[], vertices: number): number => {
    const wide = vertices > 65535;
    const arr = wide ? Uint32Array.from(data) : Uint16Array.from(data);
    accessors.push({
      bufferView: view(new Uint8Array(arr.buffer), ELEMENT_ARRAY_BUFFER),
      componentType: wide ? UNSIGNED_INT : UNSIGNED_SHORT,
      count: data.length,
      type: 'SCALAR',
    });
    return accessors.length - 1;
  };

  const addNode = (n: NodeDef): number => {
    const node: Record<string, unknown> = { name: n.name };
    if (n.translation !== undefined) {
      node.translation = n.translation;
    }
    if (n.primitives !== undefined && n.primitives.length > 0) {
      const prims = n.primitives.map((p) => {
        const count = p.positions.length / 3;
        const attributes: Record<string, number> = {
          POSITION: floats(p.positions, 3, true),
          NORMAL: floats(p.normals, 3, false),
        };
        if (p.uvs !== undefined) {
          attributes.TEXCOORD_0 = floats(p.uvs, 2, false);
        }
        if (p.uvs2 !== undefined) {
          attributes.TEXCOORD_1 = floats(p.uvs2, 2, false);
        }
        if (p.colors !== undefined) {
          attributes.COLOR_0 = floats(p.colors, 3, false);
        }
        const material = materialIndex.get(p.material);
        if (material === undefined) {
          throw new Error(`${n.name}: no material ${p.material}`);
        }
        return { attributes, indices: indices(p.indices, count), material };
      });
      meshes.push({ name: n.name, primitives: prims });
      node.mesh = meshes.length - 1;
    }
    const index = nodes.length;
    nodes.push(node);
    if (n.children !== undefined && n.children.length > 0) {
      node.children = n.children.map(addNode);
    }
    return index;
  };

  const sceneNodes = roots.map(addNode);
  const json = {
    asset: { version: '2.0', generator: 'Keel Over the Edge art/lib/gltf.ts' },
    scene: 0,
    scenes: [{ nodes: sceneNodes }],
    nodes,
    meshes,
    materials: materials.map((m) => ({
      name: m.name,
      pbrMetallicRoughness: {
        baseColorFactor: [...m.color, 1],
        roughnessFactor: m.roughness,
        metallicFactor: m.metalness,
      },
      doubleSided: m.doubleSided === true,
    })),
    accessors,
    bufferViews,
    buffers: [{ byteLength }],
  };

  const bin = new Uint8Array(byteLength + ((4 - (byteLength % 4)) % 4));
  let at = 0;
  for (const c of chunks) {
    bin.set(c, at);
    at += c.byteLength;
  }
  let text = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (text.byteLength % 4)) % 4;
  if (jsonPad > 0) {
    const padded = new Uint8Array(text.byteLength + jsonPad).fill(0x20);
    padded.set(text);
    text = padded;
  }
  const total = 12 + 8 + text.byteLength + 8 + bin.byteLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // "glTF"
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, text.byteLength, true);
  dv.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(text, 20);
  const binAt = 20 + text.byteLength;
  dv.setUint32(binAt, bin.byteLength, true);
  dv.setUint32(binAt + 4, 0x004e4942, true); // "BIN\0"
  out.set(bin, binAt + 8);
  return out;
}

/** Reads a glb's JSON chunk. */
export function readGlbJson(glb: Uint8Array): Record<string, unknown> {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) {
    throw new Error('not a glTF binary');
  }
  const length = dv.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length)));
}
