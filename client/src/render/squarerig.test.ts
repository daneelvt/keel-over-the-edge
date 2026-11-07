// SPDX-License-Identifier: AGPL-3.0-only

// A square rig as drawn, on small scenes made here: the yards' turn and its
// sign, the wheel's, a strip's belly from its wind, which sail each mesh of
// a model is and how it is taken in, the shape's values each vertex is
// given, which way a sail's face reads, the fleet's packed yards, and the
// fleet's parts of a model with yards.

import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  Vector3,
} from 'three';
import { describe, expect, test } from 'vitest';
import { boatParts, GALLERY_PART, JOINT } from './fleetparts';
import {
  ABACK,
  BELLY,
  bandTaken,
  nodeIndex,
  packRule,
  packYards,
  readsMirrored,
  type SquareSail,
  shapeSquare,
  squareBelly,
  squareSails,
  toNode,
  unpackYardsCPU,
  WHEEL_TURNS,
  wheelTurn,
  yardDrop,
  yardsTurn,
} from './squarerig';

const DEG = Math.PI / 180;

/** A flat sail across the boat (x port to starboard, y up), u across, v down from the head; its front face aft (+z). */
function sailMesh(head: number, foot: number, width: number, flip = false): Mesh {
  const g = new BufferGeometry();
  const pos: number[] = [];
  const uv: number[] = [];
  const rows = 3;
  const cols = 4;
  for (let i = 0; i <= rows; i++) {
    const v = i / rows;
    for (let j = 0; j <= cols; j++) {
      const u = j / cols;
      pos.push((u - 0.5) * width, head + (foot - head) * v, -0.4);
      uv.push(u, v);
    }
  }
  const index: number[] = [];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const a = i * (cols + 1) + j;
      const b = a + 1;
      const c = a + cols + 1;
      const d = c + 1;
      // Seen from +z, with y up and x to the right: counter-clockwise.
      if (flip) {
        index.push(a, b, c, b, d, c);
      } else {
        index.push(a, c, b, b, c, d);
      }
    }
  }
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(pos.length).fill(0), 3));
  g.setIndex(index);
  return new Mesh(g, new MeshStandardMaterial({ name: 'flax' }));
}

function box(name: string): Mesh {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  g.setIndex([0, 1, 2]);
  const m = new Mesh(g, new MeshStandardMaterial({ name }));
  return m;
}

/** A node at a place, its extras given. */
function node(name: string, at: [number, number, number], extras: object = {}): Group {
  const g = new Group();
  g.name = name;
  g.position.set(...at);
  g.userData = extras;
  return g;
}

/** A sail under its node, with its square extras. */
function withSail(parent: Object3D, name: string, extras: object, mesh: Mesh): Mesh {
  mesh.name = name;
  mesh.userData = extras;
  parent.add(mesh);
  return mesh;
}

/** A small ship: three yards' nodes, a spritsail, a wheel, a gallery, a hull. */
function ship(named = false): Group {
  const root = node('boat', [0, 0, 0]);
  const hull = node('hull', [0, 0, 0]);
  hull.add(box('topsides'));
  root.add(hull);
  const fore = node('fore-yards', [0, 0, -10]);
  const main = node('main-yards', [0, 0, 0]);
  const mizzen = node('mizzen-yards', [0, 0, 9]);
  root.add(fore, main, mizzen);
  fore.add(box('spar'));
  for (const [n, parent] of [
    ['fore', fore],
    ['main', main],
  ] as const) {
    const group = n === 'fore' ? 'fore' : 'after';
    const word = (w: string) => (named ? { sail: w } : {});
    withSail(
      parent,
      `${n}-course`,
      { square: { group, strip: 0, ...word('course') } },
      sailMesh(12, 5, 16),
    );
    withSail(
      parent,
      `${n}-topsail`,
      {
        square:
          n === 'main'
            ? { group, strip: 1, split: 0.6, reefs: [0.12, 0.25], ...word('topsail') }
            : { group, strip: 0, reefBands: [0.12, 0.25], ...word('topsail') },
        ...(n === 'main' ? { number: true } : {}),
      },
      sailMesh(20, 12.5, 13),
    );
    withSail(
      parent,
      `${n}-topgallant`,
      { square: { group, strip: 1, ...word('topgallant') } },
      sailMesh(27, 20.5, 9),
    );
  }
  // The main topsail's yard, a node of its own, comes down as its band is taken in.
  const yard = node('main-topsail-yard', [0, 20, 0], { yard: 'topsail' });
  yard.add(box('spar'));
  main.add(yard);
  withSail(mizzen, 'mizzen-topsail', { square: { group: 'after', strip: 1 } }, sailMesh(19, 13, 8));
  const sprit = node('spritsail', [0, 0, -20], { furl: 2 });
  sprit.add(sailMesh(4, 1, 7));
  root.add(sprit);
  const wheel = node('wheel', [0, 5.2, 12.5], { wheel: { radius: 0.75, spokes: 8 } });
  wheel.add(box('spar'));
  root.add(wheel);
  const gallery = node('gallery', [0, 0, 0]);
  gallery.add(box('glass'));
  root.add(gallery);
  const lantern = node('stern', [0, 6, 16]);
  lantern.add(box('brass'));
  root.add(lantern);
  root.updateMatrixWorld(true);
  return root;
}

describe('the yards', () => {
  test('are square at rest, at ±π/2 and when never braced', () => {
    expect(yardsTurn(0)).toBe(0);
    expect(Math.abs(yardsTurn(Math.PI / 2))).toBe(0);
    expect(Math.abs(yardsTurn(-Math.PI / 2))).toBe(0);
  });

  test('braced for the wind over port bring the port yardarm forward, at the angle off the centreline', () => {
    for (const angle of [30 * DEG, 50 * DEG, 80 * DEG]) {
      const n = new Group();
      n.rotation.y = yardsTurn(angle);
      n.updateMatrixWorld(true);
      const port = new Vector3(-1, 0, 0).applyMatrix4(n.matrixWorld);
      const starboard = new Vector3(1, 0, 0).applyMatrix4(n.matrixWorld);
      // Forward is −z.
      expect(port.z).toBeLessThan(0);
      expect(starboard.z).toBeGreaterThan(0);
      // The yard's line off the centreline (the z axis).
      expect(Math.atan2(Math.abs(port.x), Math.abs(port.z))).toBeCloseTo(angle, 9);
    }
    const n = new Group();
    n.rotation.y = yardsTurn(-30 * DEG);
    n.updateMatrixWorld(true);
    expect(new Vector3(1, 0, 0).applyMatrix4(n.matrixWorld).z).toBeLessThan(0);
  });

  test('turn smoothly through square from one side to the other', () => {
    const near = 89.9 * DEG;
    expect(Math.abs(yardsTurn(near) - yardsTurn(-near))).toBeLessThan(0.01);
  });

  test('pack into one float32 within a twentieth of a degree each', () => {
    for (const [fore, after] of [
      [0, 0],
      [-1.0472, -1.0472],
      [1.2, -0.3],
      [Math.PI / 2, -Math.PI / 2],
    ] as const) {
      const p = Math.fround(packYards(fore, after));
      expect(p).toBe(packYards(fore, after));
      const u = unpackYardsCPU(p);
      expect(Math.abs(u.fore - fore)).toBeLessThan(0.05 * DEG);
      expect(Math.abs(u.after - after)).toBeLessThan(0.05 * DEG);
    }
  });
});

describe('the wheel', () => {
  test('turns its turns each way to the rudder’s stop, its top to the side the bow goes', () => {
    expect(wheelTurn(0, 35)).toBeCloseTo(0, 12);
    expect(wheelTurn(35 * DEG, 35)).toBeCloseTo(-WHEEL_TURNS * 2 * Math.PI, 9);
    expect(wheelTurn(-35 * DEG, 35)).toBeCloseTo(WHEEL_TURNS * 2 * Math.PI, 9);
    expect(wheelTurn(70 * DEG, 35)).toBeCloseTo(-WHEEL_TURNS * 2 * Math.PI, 9);
    // A positive turn about +z seen from aft is anticlockwise: the top goes
    // to port. So for a rudder to starboard the top goes to starboard (+x).
    const w = new Group();
    w.rotation.z = wheelTurn(5 * DEG, 35);
    w.updateMatrixWorld(true);
    expect(new Vector3(0, 1, 0).applyMatrix4(w.matrixWorld).x).toBeGreaterThan(0);
  });
});

describe('a strip of square sails', () => {
  const b = { depth: 0, ripple: 0 };
  test('draws bellied forward, lifts rippling, and lies aback against the mast', () => {
    expect(squareBelly(30 * DEG, 1, b)).toEqual({ depth: BELLY, ripple: 0 });
    expect(squareBelly(30 * DEG, 2, b)).toEqual({ depth: BELLY, ripple: 0 });
    const lifting = squareBelly(2 * DEG, 0, b);
    expect(lifting.depth).toBeGreaterThan(0);
    expect(lifting.depth).toBeLessThan(BELLY);
    expect(lifting.ripple).toBeGreaterThan(0);
    expect(squareBelly(-20 * DEG, 3, b)).toEqual({ depth: -ABACK, ripple: 0 });
  });
});

describe('a model’s square sails', () => {
  test('are found under their yards and the spritsail, each its node, strip and reefs', () => {
    for (const named of [false, true]) {
      const sails = squareSails(ship(named));
      const by = (n: string, s: string) => sails.find((x) => x.node === n && x.sail === s);
      expect(sails).toHaveLength(8);
      for (const n of ['fore-yards', 'main-yards']) {
        const tg = by(n, 'topgallant');
        const ts = by(n, 'topsail');
        const c = by(n, 'course');
        expect(tg?.reef).toEqual({ furl: 1, reef: 0, band: 0 });
        expect(ts?.reef).toEqual({ furl: 0, reef: 2, band: 0.25 });
        expect(c?.reef).toEqual({ furl: 0, reef: 0, band: 0 });
        expect(tg?.slot).toBe(n === 'fore-yards' ? 1 : 3);
        expect(c?.slot).toBe(n === 'fore-yards' ? 0 : 2);
        expect(c?.head).toBeCloseTo(12, 6);
        expect(c?.foot).toBeCloseTo(5, 6);
        expect(c?.width).toBeCloseTo(16, 6);
      }
      // The mizzen's one sail, its topsail; the number on the main topsail.
      const mt = by('mizzen-yards', 'topsail');
      expect(mt?.slot).toBe(3);
      expect(mt?.reef.reef).toBe(2);
      expect(sails.filter((s) => s.numbered).map((s) => `${s.node} ${s.sail}`)).toEqual([
        'main-yards topsail',
      ]);
      expect(by('main-yards', 'topsail')?.yard?.name).toBe('main-topsail-yard');
      expect(by('fore-yards', 'topsail')?.yard).toBeNull();
      expect(yardDrop(by('main-yards', 'topsail') as SquareSail)).toBeCloseTo(0.25 * 7.5, 6);
      expect(bandTaken({ furl: 0, reef: 2, band: 0.25 }, 1)).toBe(0);
      expect(bandTaken({ furl: 0, reef: 2, band: 0.25 }, 1.5)).toBe(0.5);
      expect(bandTaken({ furl: 0, reef: 2, band: 0.25 }, 2)).toBe(1);
      const sprit = sails.find((s) => s.node === 'spritsail');
      expect(sprit?.reef).toEqual({ furl: 2, reef: 0, band: 0 });
    }
  });

  test('a model without yards has none', () => {
    const root = node('boat', [0, 0, 0]);
    root.add(node('sail', [0, 1, 0]));
    expect(squareSails(root)).toEqual([]);
  });

  test('give each vertex its height down the sail and its packed values', () => {
    const root = ship();
    const sails = squareSails(root);
    const ts = sails.find((s) => s.node === 'main-yards' && s.sail === 'topsail');
    if (ts === undefined) {
      throw new Error('no main topsail');
    }
    const mesh = ts.meshes[0] as Mesh;
    const g = shapeSquare(mesh.geometry.clone(), ts, toNode(mesh, ts, root));
    const uv1 = g.getAttribute('uv1');
    const sq = g.getAttribute('square');
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      expect(uv1.getY(i)).toBeCloseTo((20 - pos.getY(i)) / 7.5, 5);
      expect(uv1.getX(i)).toBe(g.getAttribute('uv').getX(i));
      // The main topsail spans both strips: below its split the foot's.
      const v = g.getAttribute('uv').getY(i);
      expect(sq.getX(i)).toBe(nodeIndex('main-yards') * 4 + (v > 0.6 ? 2 : 3));
      expect(sq.getY(i)).toBeCloseTo(7.5, 5);
      expect(sq.getZ(i)).toBe(packRule(ts.reef, true));
      expect(sq.getW(i)).toBeCloseTo(0.25, 6);
    }
    expect(packRule({ furl: 1, reef: 0, band: 0 }, false)).toBe(1);
    expect(packRule({ furl: 0, reef: 2, band: 0.2 }, true)).toBe(15);
  });
});

describe('a sail’s face', () => {
  test('reads its u right to left when it faces forward, left to right when it faces aft', () => {
    // Its front face toward +z (aft): seen from astern, u runs to the right.
    expect(readsMirrored(sailMesh(10, 2, 8).geometry)).toBe(false);
    expect(readsMirrored(sailMesh(10, 2, 8, true).geometry)).toBe(true);
  });
});

describe('the fleet’s parts of a model with yards', () => {
  test('merge the square sails, turn the yards and wheel as joints, and mark the gallery', () => {
    const parts = boatParts(ship(), 'test');
    expect(parts.square).not.toBeNull();
    const g = parts.square?.geometry as BufferGeometry;
    expect(Object.keys(g.attributes).sort()).toEqual(['position', 'square', 'uv', 'uv1']);
    // Every square sail's vertex: 8 sails of 20 vertices.
    expect(g.getAttribute('position').count).toBe(8 * 20);
    expect(parts.yardsAt.map((v) => v.z)).toEqual([-10, 0, 9, -20]);
    expect(parts.wheelAt?.toArray()).toEqual([0, 5.2, 12.5]);
    expect(parts.gallery).toBe(true);
    const joints = new Set<number>();
    const marks = new Set<number>();
    for (const s of parts.solids) {
      const part = s.geometry.getAttribute('part');
      for (let i = 0; i < part.count; i++) {
        joints.add(part.getX(i));
        marks.add(part.getW(i));
      }
    }
    expect([...joints].sort()).toEqual([JOINT.hull, JOINT.wheel, JOINT.foreYards, JOINT.mainYard]);
    expect(parts.yardDrops[1]?.drop).toBeCloseTo(0.25 * 7.5, 6);
    expect(parts.yardDrops[1]?.level).toBe(2);
    expect(parts.yardDrops[0]?.drop).toBe(0);
    // The lantern's brass is drawn with the hull on a model with yards.
    expect(marks.has(GALLERY_PART)).toBe(true);
    expect(marks.has(1)).toBe(true);
  });
});
