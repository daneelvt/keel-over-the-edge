// SPDX-License-Identifier: AGPL-3.0-only

// The material factory. Every material in the game is made here, so every
// one carries the dome's bend: the world drops away from the boat by d²/2R,
// d the horizontal distance from the boat and R the dome's radius, so the
// sea hides what lies beyond the horizon and islands rise over it.
//
// How the bend composes, in three.js r186 (NodeMaterial.setupPosition):
// morph targets, skinning and the instance matrix are applied to
// positionLocal first, and the material's positionNode last. So the bend is
// a positionNode that takes the finished local position (or the material's
// own vertex node, such as the sail's) to the world, drops it there, and
// takes it back with the object's inverse world matrix. Everything after it
// (the view and clip positions, positionWorld for lighting and fog) sees the
// bent position.
//
// Two kinds bend differently. The sea's tiles take the bend at each tile's
// centre, as part of the tile's plane, so a tile never curves (seamaterial.ts
// and tilepass.ts); the far sea bends per vertex inside its own wave function.
// The sky is drawn at infinity and is the only kind without a bend: it is a
// direction, not a place.

import { type Material, type Object3D, Vector2 } from 'three';
import {
  dot,
  Fn,
  modelWorldMatrix,
  modelWorldMatrixInverse,
  positionLocal,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import {
  MeshBasicNodeMaterial,
  type MeshBasicNodeMaterialParameters,
  MeshStandardNodeMaterial,
  type MeshStandardNodeMaterialParameters,
  type Node,
  type NodeMaterial,
} from 'three/webgpu';

/** The dome's radius, in metres. */
export const DOME_RADIUS = 2500;

/** How far the dome drops a point d metres from the boat, in metres. */
export function domeDrop(d: number): number {
  return (d * d) / (2 * DOME_RADIUS);
}

/** How far the horizon is from an eye h metres above the sea, in metres. */
export function horizonDistance(h: number): number {
  return Math.sqrt(2 * DOME_RADIUS * Math.max(h, 0));
}

/**
 * The boat's position in the scene (x and z, relative to the floating
 * origin): the point the world drops away from. Set once a frame.
 */
export const domeCentre = uniform(new Vector2());

/** A scene position, dropped by the dome. */
export const bendScene = /* @__PURE__ */ Fn(([p]: [Node<'vec3'>]) => {
  const d = p.xz.sub(domeCentre);
  return vec3(p.x, p.y.sub(dot(d, d).mul(1 / (2 * DOME_RADIUS))), p.z);
});

/** A local position, dropped by the dome where the object puts it in the scene. */
function bendLocal(local: Node<'vec3'>): Node<'vec3'> {
  const world = modelWorldMatrix.mul(vec4(local, 1)).xyz;
  return modelWorldMatrixInverse.mul(vec4(bendScene(world), 1)).xyz;
}

export type MaterialKind = 'lit' | 'basic' | 'sea-tile' | 'sea-far' | 'sky';

/** How a material carries the dome: per vertex, at each tile's centre, or not at all. */
export type Bend = 'vertex' | 'tile-centre' | 'vertex-in-node' | 'none';

export interface MaterialInfo {
  kind: MaterialKind;
  bend: Bend;
}

const made = new WeakMap<Material, MaterialInfo>();

function register<M extends NodeMaterial>(m: M, kind: MaterialKind, bend: Bend): M {
  made.set(m, { kind, bend });
  m.userData.kind = kind;
  return m;
}

/** How the factory made a material, or undefined if it did not. */
export function materialInfo(m: Material): MaterialInfo | undefined {
  return made.get(m);
}

/** A lit material (the boat, and later everything solid). */
export function litMaterial(
  params: MeshStandardNodeMaterialParameters = {},
  vertex?: Node<'vec3'>,
): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial(params);
  m.positionNode = bendLocal(vertex ?? positionLocal);
  return register(m, 'lit', 'vertex');
}

/** An unlit material. */
export function basicMaterial(
  params: MeshBasicNodeMaterialParameters = {},
  vertex?: Node<'vec3'>,
): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial(params);
  m.positionNode = bendLocal(vertex ?? positionLocal);
  return register(m, 'basic', 'vertex');
}

/**
 * A sea material. The sea draws its own geometry from the wave pass, with
 * the dome already in it: the tiles take it at their centres (D2's rigid
 * tiles), the far sea per vertex. Its look is set by the caller.
 */
export function seaMaterial(kind: 'sea-tile' | 'sea-far'): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial({ fog: false });
  return register(m, kind, kind === 'sea-tile' ? 'tile-centre' : 'vertex-in-node');
}

/** The sky's material: drawn at infinity, the one kind without a bend. */
export function skyMaterial(): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial({ fog: false, depthWrite: false });
  return register(m, 'sky', 'none');
}

/**
 * Walks a scene and lists every material the factory did not make, or made
 * without the bend outside the sky kind. An empty list is a pass.
 */
export function checkScene(root: Object3D): string[] {
  const problems: string[] = [];
  root.traverse((o) => {
    const mesh = o as Object3D & { material?: Material | Material[] };
    if (mesh.material === undefined) {
      return;
    }
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of list) {
      const info = made.get(m);
      const name = `${o.name || o.type} (${m.name || m.type})`;
      if (info === undefined) {
        problems.push(`${name}: not made by the material factory`);
      } else if (info.bend === 'none' && info.kind !== 'sky') {
        problems.push(`${name}: no bend`);
      } else if (info.bend !== 'none' && info.kind === 'sky') {
        problems.push(`${name}: the sky must not bend`);
      }
    }
  });
  return problems;
}
