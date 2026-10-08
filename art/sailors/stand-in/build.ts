// SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
// Art: all rights reserved, not covered by the AGPL. See art/README.md.

// The stand-in sailor: a plain figure that shows where the sailor is and
// what they are doing (sitting in, hiking out, in the water, on the
// daggerboard), with no look of its own. A body with legs, a head and two
// arms, in simple shapes and one neutral colour.
//
// The figure's frame: its origin at the hips, where it sits; y up; it faces
// +x, its thighs reaching forward along +x and its shins down; z runs along
// its shoulders. Its scale is a 1.83 m sailor's.
//
//   node art/sailors/stand-in/build.ts   (from the repository root; npm run art in client/)

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { type MaterialDef, type NodeDef, writeGlb } from '../../lib/gltf.ts';
import { MeshBuilder, srgb, type Vec3 } from '../../lib/mesh.ts';

/** The model this script writes, as the catalog's art.model names it. */
const MODEL = 'sailors/stand-in.glb';

const catalog = JSON.parse(readFileSync('internal/catalog/catalog.gen.json', 'utf8')) as {
  sailors: { art: { model: string } }[];
};
if (!catalog.sailors.some((s) => s.art.model === MODEL)) {
  throw new Error(`no sailor in the catalog has the model ${MODEL}`);
}

const materials: MaterialDef[] = [
  { name: 'figure', color: srgb(0.56, 0.6, 0.64), roughness: 0.7, metalness: 0 },
];

const SEGMENTS = 12;

/** A ball of radius r centred on c, as a tube along a vertical path. */
function ball(m: MeshBuilder, c: Vec3, r: number): void {
  const rings = 8;
  const path: Vec3[] = [];
  const radii: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const a = Math.PI * (i / rings - 0.5);
    path.push([c[0], c[1] + r * Math.sin(a), c[2]]);
    radii.push(Math.max(r * Math.cos(a), 0.004));
  }
  m.tube(path, radii, SEGMENTS);
}

function body(): MeshBuilder {
  const m = new MeshBuilder('figure');
  // The torso, hips to shoulders, narrowing a little at the waist.
  m.tube(
    [
      [0, -0.04, 0],
      [0.01, 0.2, 0],
      [0, 0.42, 0],
      [-0.01, 0.56, 0],
    ],
    [0.15, 0.13, 0.16, 0.12],
    SEGMENTS,
  );
  // The legs: thighs forward, shins down.
  for (const z of [-0.1, 0.1]) {
    m.tube(
      [
        [0, -0.02, z],
        [0.42, 0, z],
        [0.47, -0.42, z],
        [0.58, -0.47, z],
      ],
      [0.075, 0.06, 0.05, 0.045],
      8,
    );
  }
  // The neck.
  m.tube(
    [
      [-0.01, 0.55, 0],
      [-0.01, 0.65, 0],
    ],
    [0.05],
    8,
  );
  return m;
}

function head(): MeshBuilder {
  const m = new MeshBuilder('figure');
  ball(m, [0, 0, 0], 0.11);
  return m;
}

/** An arm from the shoulder, reaching forward and down to the hands, held in front. */
function arm(side: number): MeshBuilder {
  const m = new MeshBuilder('figure');
  m.tube(
    [
      [0, 0, 0],
      [0.12, -0.22, 0.03 * side],
      [0.38, -0.25, -0.06 * side],
    ],
    [0.045, 0.04, 0.035],
    8,
  );
  ball(m, [0.4, -0.25, -0.06 * side], 0.045);
  return m;
}

const nodes: NodeDef[] = [
  { name: 'body', primitives: [body().primitive()] },
  { name: 'head', translation: [-0.01, 0.76, 0], primitives: [head().primitive()] },
  { name: 'arm-left', translation: [0, 0.52, -0.2], primitives: [arm(-1).primitive()] },
  { name: 'arm-right', translation: [0, 0.52, 0.2], primitives: [arm(1).primitive()] },
];

const raw = writeGlb([{ name: 'sailor', children: nodes }], materials);
mkdirSync('.dev/art', { recursive: true });
writeFileSync('.dev/art/stand-in.raw.glb', raw);
mkdirSync('art/sailors', { recursive: true });
execFileSync(
  'client/node_modules/.bin/gltfpack',
  ['-i', '.dev/art/stand-in.raw.glb', '-o', `art/${MODEL}`, '-c', '-kn', '-km', '-noq'],
  { stdio: 'inherit' },
);
process.stdout.write(`wrote art/${MODEL}\n`);
