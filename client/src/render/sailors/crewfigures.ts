// SPDX-License-Identifier: AGPL-3.0-only

// A look's figures as the crew's levels keep them (crewlevel.ts): triangle
// lists in the figure's bind pose, each corner with its bones and weights,
// sixteen floats a corner (place and u, normal and v, four bones, four
// weights).
//
// The deck level's is its own skinned mesh. The far level's figure is made
// seated at the helm, as the fleet seats it (fleetparts.ts's seatFigure),
// and has no skin of its own: each of its vertices takes the bones and
// weights of the deck level's vertex nearest it, both seated at the helm's
// clip's first frame, and is taken back from there to the bind pose by
// them, so that the same bones pose both levels.

import { type BufferGeometry, Matrix3, Matrix4, Vector3 } from 'three';
import { type Clip, Pose } from './clips';
import { STRIDE } from './crewlevel';
import type { DeckLook, FleetLook, FleetSeat } from './fleetlooks';
import type { Rig } from './rig';

/** A geometry's triangles, each corner written by vertex. */
function triangles(
  g: BufferGeometry,
  vertex: (i: number, out: Float32Array, o: number) => void,
): Float32Array {
  const index = g.index;
  const corners = index === null ? g.getAttribute('position').count : index.count;
  const out = new Float32Array(STRIDE * corners);
  for (let c = 0; c < corners; c++) {
    vertex(index === null ? c : index.getX(c), out, STRIDE * c);
  }
  return out;
}

/** A look's deck level as a triangle list in its bind pose, with its skin. */
export function deckFigure(deck: DeckLook): Float32Array {
  const g = deck.geometry;
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const uv = g.getAttribute('uv');
  const si = g.getAttribute('skinIndex');
  const sw = g.getAttribute('skinWeight');
  return triangles(g, (i, out, o) => {
    out[o] = pos.getX(i);
    out[o + 1] = pos.getY(i);
    out[o + 2] = pos.getZ(i);
    out[o + 3] = uv.getX(i);
    out[o + 4] = nor.getX(i);
    out[o + 5] = nor.getY(i);
    out[o + 6] = nor.getZ(i);
    out[o + 7] = uv.getY(i);
    for (let k = 0; k < 4; k++) {
      out[o + 8 + k] = si.getComponent(i, k);
      out[o + 12 + k] = sw.getComponent(i, k);
    }
  });
}

/** Every bone's matrix from the bind pose to a clip's first frame, sixteen floats a bone. */
function boneMatrices(rig: Rig, deck: DeckLook, clip: Clip): Float32Array {
  const pose = new Pose(rig.names.length).rest(rig);
  clip.sample(0, pose);
  pose.to(rig);
  rig.fk();
  const out = new Float32Array(16 * rig.names.length);
  const m = new Matrix4();
  const m2 = new Matrix4();
  for (let j = 0; j < rig.names.length; j++) {
    m.fromArray(rig.world, 16 * j).multiply(m2.fromArray(deck.inverse, 16 * j));
    m.toArray(out, 16 * j);
  }
  rig.reset();
  return out;
}

/** The blend of four bones' matrices by their weights, into out. */
function blended(bones: Float32Array, index: number[], weight: number[], out: Matrix4): Matrix4 {
  const e = out.elements;
  e.fill(0);
  for (let k = 0; k < 4; k++) {
    const wk = weight[k] as number;
    if (wk <= 0) {
      continue;
    }
    const b = 16 * (index[k] as number);
    for (let c = 0; c < 16; c++) {
      e[c] = (e[c] as number) + wk * (bones[b + c] as number);
    }
  }
  return out;
}

/** The size of the cells deck vertices are sorted into to find the nearest, m. */
const CELL = 0.06;

/**
 * A look's far figure as a triangle list in the deck level's bind pose,
 * each vertex with the bones and weights of the deck level's vertex
 * nearest it seated at the helm; null until its deck level, its far
 * figure and its clips (the helm's placed) are all there. seat is where
 * the fleet seats its far figure (fleetlooks.ts).
 */
export function farFigure(look: FleetLook, seat: FleetSeat): Float32Array | null {
  const deck = look.deck;
  const far = look.far;
  const helm = look.clips?.get('helm');
  if (deck === null || far === null || helm?.place == null) {
    return null;
  }
  const rig = deck.rig;
  const bones = boneMatrices(rig, deck, helm);
  // The deck level seated at the helm, in the figure's space; and each
  // vertex's bones and weights.
  const g = deck.geometry;
  const pos = g.getAttribute('position');
  const si = g.getAttribute('skinIndex');
  const sw = g.getAttribute('skinWeight');
  const n = pos.count;
  const seated = new Float32Array(3 * n);
  const p = new Vector3();
  const mm = new Matrix4();
  const index = [0, 0, 0, 0];
  const weight = [0, 0, 0, 0];
  const cells = new Map<string, number[]>();
  const key = (x: number, y: number, z: number): string =>
    `${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 4; k++) {
      index[k] = Math.round(si.getComponent(i, k));
      weight[k] = sw.getComponent(i, k);
    }
    p.fromBufferAttribute(pos, i).applyMatrix4(blended(bones, index, weight, mm));
    p.toArray(seated, 3 * i);
    const k = key(p.x, p.y, p.z);
    const list = cells.get(k);
    if (list === undefined) {
      cells.set(k, [i]);
    } else {
      list.push(i);
    }
  }
  const nearest = (x: number, y: number, z: number): number => {
    const cx = Math.floor(x / CELL);
    const cy = Math.floor(y / CELL);
    const cz = Math.floor(z / CELL);
    let best = -1;
    let bestD = Number.POSITIVE_INFINITY;
    for (let r = 1; r < 40 && best < 0; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dz = -r; dz <= r; dz++) {
            for (const i of cells.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
              const ex = (seated[3 * i] as number) - x;
              const ey = (seated[3 * i + 1] as number) - y;
              const ez = (seated[3 * i + 2] as number) - z;
              const d = ex * ex + ey * ey + ez * ez;
              if (d < bestD) {
                bestD = d;
                best = i;
              }
            }
          }
        }
      }
    }
    return Math.max(0, best);
  };
  // From the fleet's seated frame (fleetparts.ts's figureNode's) back to
  // the boat model's, then into the helm clip's figure space.
  const toHelm = new Matrix4()
    .copy(helm.place)
    .invert()
    .multiply(new Matrix4().makeTranslation(seat.out, seat.y, seat.z))
    .multiply(new Matrix4().makeRotationY(Math.PI));
  const toHelmNormal = new Matrix3().getNormalMatrix(toHelm);
  const fpos = far.getAttribute('position');
  const fnor = far.getAttribute('normal');
  const fuv = far.getAttribute('uv');
  const nm = new Vector3();
  const inverse = new Matrix4();
  const normal = new Matrix3();
  // The feet's bones: the far figure's coarse soles are set on the deck
  // level's, in the bind pose, by as much as each vertex goes with them.
  const feet = new Set(
    ['foot_l', 'foot_r', 'ball_l', 'ball_r'].map((b) => rig.bone(b)).filter((b) => b >= 0),
  );
  let deckSole = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    deckSole = Math.min(deckSole, pos.getY(i));
  }
  let farSole = Number.POSITIVE_INFINITY;
  const made = triangles(far, (i, out, o) => {
    p.fromBufferAttribute(fpos, i).applyMatrix4(toHelm);
    nm.fromBufferAttribute(fnor, i).applyMatrix3(toHelmNormal).normalize();
    const d = nearest(p.x, p.y, p.z);
    for (let k = 0; k < 4; k++) {
      index[k] = Math.round(si.getComponent(d, k));
      weight[k] = sw.getComponent(d, k);
    }
    blended(bones, index, weight, mm);
    // Back to the bind pose; the normal by the blend's transpose.
    inverse.copy(mm).invert();
    p.applyMatrix4(inverse);
    nm.applyMatrix3(normal.setFromMatrix4(mm).transpose()).normalize();
    out[o] = p.x;
    out[o + 1] = p.y;
    out[o + 2] = p.z;
    out[o + 3] = fuv.getX(i);
    out[o + 4] = nm.x;
    out[o + 5] = nm.y;
    out[o + 6] = nm.z;
    out[o + 7] = fuv.getY(i);
    for (let k = 0; k < 4; k++) {
      out[o + 8 + k] = index[k] as number;
      out[o + 12 + k] = weight[k] as number;
    }
    if (footShare(index, weight, feet) > 0.5) {
      farSole = Math.min(farSole, p.y);
    }
  });
  if (Number.isFinite(farSole) && Number.isFinite(deckSole)) {
    for (let o = 0; o < made.length; o += STRIDE) {
      for (let k = 0; k < 4; k++) {
        index[k] = made[o + 8 + k] as number;
        weight[k] = made[o + 12 + k] as number;
      }
      made[o + 1] = (made[o + 1] as number) + (deckSole - farSole) * footShare(index, weight, feet);
    }
  }
  return made;
}

/** How much of a vertex goes with the feet's bones. */
function footShare(index: number[], weight: number[], feet: Set<number>): number {
  let w = 0;
  for (let k = 0; k < 4; k++) {
    if (feet.has(index[k] as number)) {
      w += weight[k] as number;
    }
  }
  return w;
}
