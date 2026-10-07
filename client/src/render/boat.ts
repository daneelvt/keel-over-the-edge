// SPDX-License-Identifier: AGPL-3.0-only

// A boat on the sea: its model, loaded from the catalog's art with three.js's
// GLTFLoader and the meshopt decoder, with every material replaced by one
// from the factory. The parts are found by their node names (hull, mast,
// boom, sail, rudder, tiller, daggerboard, sailor).
//
// The sail is shaped on the GPU: the model holds it flat, each vertex with
// its fraction of the chord and of the luff, and a vertex node swings it
// round the mast with the boom, twists it open toward the head and gives it
// camber, from uniforms. Phase 5 drives them from the physics.

import {
  CanvasTexture,
  Color,
  DoubleSide,
  FrontSide,
  Group,
  type Material,
  Mesh,
  type MeshStandardMaterial,
  type Object3D,
  SRGBColorSpace,
} from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  cos,
  Fn,
  float,
  normalize,
  normalLocal,
  positionGeometry,
  sin,
  uniform,
  uv,
  vec3,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { ScenePoint } from './coords';
import { litMaterial } from './materials';
import type { Gfx } from './renderer';

/** Every model under art/, by its path there, as Vite serves it. */
const MODELS = import.meta.glob<string>('../../../art/**/*.glb', {
  query: '?url',
  import: 'default',
  eager: true,
});

/** The URL of an art file named by the catalog. */
export function artUrl(path: string): string {
  const url = MODELS[`../../../art/${path}`];
  if (url === undefined) {
    throw new Error(`no art file ${path}`);
  }
  return url;
}

/** The sail's trim, in radians: the boom's angle (to starboard positive), the twist at the head, the camber's depth. */
export interface SailTrim {
  boom: number;
  twist: number;
  camber: number;
}

/** A beam reach on port tack: the boom well out to starboard. */
export const BEAM_REACH: SailTrim = { boom: 0.96, twist: 0.2, camber: 0.09 };

/** The sail's distance aft of the mast's centre, as the model has it, in metres. */
const LUFF_OFFSET = 0.04;

export class Boat {
  readonly root = new Group();
  readonly parts = new Map<string, Object3D>();
  readonly trim = {
    boom: uniform(BEAM_REACH.boom),
    twist: uniform(BEAM_REACH.twist),
    camber: uniform(BEAM_REACH.camber),
  };

  constructor() {
    this.root.name = 'boat';
  }

  /** Loads a model from the catalog's art path. */
  async load(path: string, sailNumber: string, insignia: string): Promise<void> {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(artUrl(path));
    const model = gltf.scene;
    model.traverse((o) => {
      if (o.name !== '') {
        this.parts.set(o.name, o);
      }
    });
    const sail = this.parts.get('sail');
    const cloth = sailCloth(sailNumber, insignia);
    model.traverse((o) => {
      if (!(o instanceof Mesh)) {
        return;
      }
      o.material = this.#replace(
        o,
        o.material as Material,
        sail !== undefined && isWithin(o, sail),
        cloth,
      );
    });
    this.root.add(model);
    this.setTrim(BEAM_REACH);
  }

  setTrim(t: SailTrim): void {
    this.trim.boom.value = t.boom;
    this.trim.twist.value = t.twist;
    this.trim.camber.value = t.camber;
    const boom = this.parts.get('boom');
    if (boom !== undefined) {
      boom.rotation.y = t.boom;
    }
  }

  /** Puts the boat at a scene position with a rotation about y. */
  place(p: ScenePoint, rotationY: number): void {
    this.root.position.set(p.x, p.y, p.z);
    this.root.rotation.y = rotationY;
  }

  /** After a new renderer: everything is kept on the CPU side and uploaded again by itself. */
  attached(_gfx: Gfx): void {}

  #replace(mesh: Mesh, m: Material, isSail: boolean, cloth: CanvasTexture): Material {
    const src = m as MeshStandardMaterial;
    const vertexColors = mesh.geometry.hasAttribute('color');
    if (isSail) {
      // Daylight comes through flax: its shaded side glows a little, with the
      // insignia and number showing through.
      const sail = litMaterial(
        {
          map: cloth,
          emissiveMap: cloth,
          emissive: new Color(0.42, 0.4, 0.36),
          roughness: src.roughness,
          metalness: 0,
          side: DoubleSide,
        },
        this.#sailNode(),
      );
      sail.name = src.name;
      return sail;
    }
    const lit = litMaterial({
      color: (src.color as Color).clone(),
      roughness: src.roughness,
      metalness: src.metalness,
      vertexColors,
      side: src.side === DoubleSide ? DoubleSide : FrontSide,
    });
    lit.name = src.name;
    src.dispose();
    return lit;
  }

  /**
   * The sail's vertex node. At height v up the luff the sail's chord turns
   * about the mast by the boom's angle plus the twist times v, and stands
   * off its straight line by the camber, 4·depth·u(1 − u) of the chord at
   * fraction u along it, to the side the boom is out on.
   */
  #sailNode(): Node<'vec3'> {
    const { boom, twist, camber } = this.trim;
    return Fn(() => {
      const fu = uv(1).x;
      const fv = uv(1).y;
      const along = positionGeometry.z.sub(LUFF_OFFSET);
      const side = boom.sign();
      const theta = boom.add(twist.mul(fv).mul(side));
      // u(1 − u)·chord is along·(1 − u).
      const d = camber.mul(4).mul(along).mul(float(1).sub(fu)).mul(side);
      const z = along.add(LUFF_OFFSET);
      const c = cos(theta);
      const s = sin(theta);
      const slope = camber
        .mul(4)
        .mul(float(1).sub(fu.mul(2)))
        .mul(side);
      const n = normalize(vec3(1, 0, slope.negate()));
      normalLocal.assign(vec3(n.x.mul(c).add(n.z.mul(s)), 0, n.z.mul(c).sub(n.x.mul(s))));
      return vec3(d.mul(c).add(z.mul(s)), positionGeometry.y, z.mul(c).sub(d.mul(s)));
    })() as unknown as Node<'vec3'>;
  }
}

function isWithin(o: Object3D, ancestor: Object3D): boolean {
  for (let p: Object3D | null = o; p !== null; p = p.parent) {
    if (p === ancestor) {
      return true;
    }
  }
  return false;
}

/**
 * The sail's cloth, drawn into a canvas: cream flax in crosscut panels,
 * the class insignia near the head and the sail number below it. The
 * canvas's width is the foot and its height the luff, at the same scale.
 */
function sailCloth(number: string, insignia: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 960;
  const g = canvas.getContext('2d') as CanvasRenderingContext2D;
  g.fillStyle = '#efe6d2';
  g.fillRect(0, 0, canvas.width, canvas.height);
  // Panel seams, square to the leech, and a faint weave.
  g.strokeStyle = 'rgba(120, 100, 70, 0.28)';
  g.lineWidth = 2;
  for (let y = 40; y < canvas.height; y += 62) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(canvas.width, y - 70);
    g.stroke();
  }
  // The insignia in a ring, 22% of the foot across, near the head.
  const cx = 0.115 * canvas.width;
  const cy = 0.2 * canvas.height;
  const r = 0.085 * canvas.width;
  g.strokeStyle = '#a3362a';
  g.fillStyle = '#a3362a';
  g.lineWidth = 7;
  g.beginPath();
  g.arc(cx, cy, r, 0, 2 * Math.PI);
  g.stroke();
  g.font = `bold ${Math.round(r * 1.3)}px Georgia, serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(insignia, cx, cy + r * 0.06);
  g.fillStyle = '#2b2118';
  g.font = `${Math.round(r * 1.25)}px Georgia, serif`;
  g.fillText(number, 0.16 * canvas.width, 0.38 * canvas.height);
  const t = new CanvasTexture(canvas);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
