// SPDX-License-Identifier: AGPL-3.0-only

// A boat on the sea: its model, loaded from the catalog's art with three.js's
// GLTFLoader and the meshopt decoder, with every material replaced by one
// from the factory. The parts are found by their node names (hull, mast,
// boom, sail, telltales, pennant, rudder, tiller, daggerboard, sailor).
//
// Everything that moves is drawn from the physics: the boat is placed by its
// position and heading, then heeled about the fore-and-aft axis through its
// centre of gravity, as the physics rolls it; the boom swings to its angle;
// the rudder and tiller turn; the sail is shaped on the GPU for the boom's
// angle, the twist and the sailor's flattening, and ripples where it
// luffs; the telltales read each sail strip's flow; the pennant streams in
// the apparent wind at the masthead. A stand-in figure shows the sailor.

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
import { Fn, normalLocal, positionGeometry, uv } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { Boat as BoatKind } from '../catalog';
import type { BoatPose } from '../predict/blend';
import { RECORDS } from '../predict/layout.gen';
import { headingToRotationY, type ScenePoint } from './coords';
import { litMaterial } from './materials';
import { Pennant } from './pennant';
import type { Gfx } from './renderer';
import { placeSailor, SAILING, type SailorFrame, type SailorPlace } from './sailor';
import { LUFF_OFFSET, sailPoint, sailUniforms } from './sailshape';
import { FLOW_LUFFING, Telltales } from './telltales';

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

/** The sail's camber at full power, as a fraction of the chord; flattening scales it. */
export const FULL_CAMBER = 0.09;
/** Seconds over which the sail's ripple grows and dies away. */
const RIPPLE_EASE = 0.25;
const DEG = Math.PI / 180;

/**
 * Places a boat's nodes: root at the scene point turned to the heading, and
 * heel rolled about its own origin, which is at the centre of gravity's
 * height (the model below it is lowered by the same height).
 */
export function placeBoatNodes(
  root: Object3D,
  heel: Object3D,
  at: ScenePoint,
  heading: number,
  heelAngle: number,
): void {
  root.position.set(at.x, at.y, at.z);
  root.rotation.set(0, headingToRotationY(heading), 0);
  // Positive heel puts the starboard side (+x) down: a turn of −heel about
  // the axis pointing aft (+z).
  heel.rotation.set(0, 0, -heelAngle);
}

/**
 * How hard a luffing strip ripples, 0.4 to 1: harder the further its angle
 * of attack is below the luffing angle.
 */
export function luffing(attack: number, luffAngle: number): number {
  return 0.4 + 0.6 * Math.max(0, Math.min(1, 1 - Math.abs(attack) / luffAngle));
}

export class Boat {
  readonly root = new Group();
  /** Rolled by the heel about the centre of gravity's height. */
  readonly heel = new Group();
  /** The model, lowered so that the heel's pivot is at its centre of gravity. */
  readonly model = new Group();
  readonly parts = new Map<string, Object3D>();
  readonly sail = sailUniforms();
  readonly telltales = new Telltales();
  readonly pennant = new Pennant();
  /** The stand-in sailor, once loaded. */
  figure: Object3D | null = null;

  readonly #kind: BoatKind;
  readonly #frame: SailorFrame;
  readonly #place: SailorPlace = { x: 0, y: 0, z: 0, facing: 0, tilt: 0 };
  readonly #ripple = new Float64Array(2);
  #side = -1;

  constructor(kind: BoatKind) {
    this.#kind = kind;
    const { hull, rig, foils } = kind.physics;
    this.root.name = 'boat';
    this.heel.position.y = hull.centreOfGravity;
    this.model.position.y = -hull.centreOfGravity;
    this.root.add(this.heel);
    this.heel.add(this.model);
    this.sail.footV.value = rig.footStrip;
    this.sail.headV.value = rig.headStrip;
    this.#frame = {
      seatZ: 0,
      centreOfGravity: hull.centreOfGravity,
      boardZ: -foils.boardPosition,
      boardDepth: hull.hullDraught + 0.45 * foils.boardSpan,
    };
  }

  /** Loads the boat's model from the catalog's art path. */
  async load(sailNumber: string, insignia: string): Promise<void> {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(artUrl(this.#kind.art.model));
    const model = gltf.scene;
    model.traverse((o) => {
      if (o.name !== '') {
        this.parts.set(o.name, o);
      }
    });
    const cloth = sailCloth(sailNumber, insignia);
    model.traverse((o) => {
      if (o instanceof Mesh) {
        o.material = this.#replace(o, o.material as Material, cloth);
        // The shaped sail, the ribbons and the pennant leave their rest bounds.
        o.frustumCulled = false;
      }
    });
    this.model.add(model);
    const seat = this.parts.get('sailor');
    if (seat !== undefined) {
      this.#frame.seatZ = seat.position.z;
    }
  }

  /** Loads the sailor's figure from an art path and seats it in the boat. */
  async loadSailor(path: string): Promise<void> {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(artUrl(path));
    const figure = gltf.scene;
    figure.name = 'sailor figure';
    figure.rotation.order = 'ZYX';
    figure.traverse((o) => {
      if (o instanceof Mesh) {
        const src = o.material as MeshStandardMaterial;
        const m = litMaterial({
          color: (src.color as Color).clone(),
          roughness: src.roughness,
          metalness: 0,
        });
        m.name = src.name;
        src.dispose();
        o.material = m;
      }
    });
    this.figure = figure;
    this.model.add(figure);
  }

  /**
   * Draws the boat in a pose at a scene point, from the latest step's Out.
   * time is world time; dt the world time since the last frame, for what
   * eases, in seconds.
   */
  draw(at: ScenePoint, pose: BoatPose, out: Float64Array, time: number, dt: number): void {
    placeBoatNodes(this.root, this.heel, at, pose.heading, pose.heel);
    const { rig } = this.#kind.physics;
    const boom = this.parts.get('boom');
    if (boom !== undefined) {
      boom.rotation.y = pose.boom;
    }
    // A positive rudder turns the bow to starboard: its blade swings to
    // starboard behind the stock, and the tiller ahead of it to port.
    const rudder = this.parts.get('rudder');
    if (rudder !== undefined) {
      rudder.rotation.y = pose.rudder;
    }

    // The twist and the camber fall to the side the boom is on, turning over
    // as it crosses the centreline, as the physics turns them.
    const turn = Math.max(-1, Math.min(1, pose.boom / (rig.twistTurn * DEG)));
    const flat = out[RECORDS.out.flattening] ?? 0;
    this.sail.boom.value = pose.boom;
    this.sail.side.value = turn;
    this.sail.twist.value = (out[RECORDS.out.twist] ?? 0) * turn;
    this.sail.camber.value = FULL_CAMBER * (flat > 0 ? flat : 1);
    this.sail.time.value = time;
    const ease = dt > 0 ? 1 - Math.exp(-dt / RIPPLE_EASE) : 0;
    for (let i = 0; i < 2; i++) {
      const flow = out[i === 0 ? RECORDS.out.footFlow : RECORDS.out.headFlow] ?? 1;
      const attack = out[i === 0 ? RECORDS.out.footAttack : RECORDS.out.headAttack] ?? 0;
      const want = flow === FLOW_LUFFING ? luffing(attack, rig.luffAngle * DEG) : 0;
      const r = this.#ripple[i] ?? 0;
      this.#ripple[i] = r + (want - r) * ease;
    }
    this.sail.rippleFoot.value = this.#ripple[0] ?? 0;
    this.sail.rippleHead.value = this.#ripple[1] ?? 0;
    this.telltales.update(out, pose.boom, dt);
    this.pennant.update(out, dt);

    const figure = this.figure;
    if (figure !== null) {
      if (pose.sailorMode === SAILING && Math.abs(pose.sailor) > 0.05) {
        this.#side = Math.sign(pose.sailor);
      }
      const p = placeSailor(
        pose.sailor,
        pose.sailorMode,
        pose.heel,
        this.#frame,
        this.#side,
        this.#place,
      );
      figure.position.set(p.x, p.y, p.z);
      figure.rotation.set(0, p.facing, p.tilt);
    }
  }

  /** After a new renderer: everything is kept on the CPU side and uploaded again by itself. */
  attached(_gfx: Gfx): void {}

  #replace(mesh: Mesh, m: Material, cloth: CanvasTexture): Material {
    const src = m as MeshStandardMaterial;
    const vertexColors = mesh.geometry.hasAttribute('color');
    let made: Material;
    if (this.#within(mesh, 'sail')) {
      // Daylight comes through flax: its shaded side glows a little, with the
      // insignia and number showing through.
      made = litMaterial(
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
    } else if (this.#within(mesh, 'telltales')) {
      made = litMaterial(
        { vertexColors: true, roughness: 0.9, metalness: 0, side: DoubleSide },
        this.telltales.node(this.sail),
      );
    } else if (this.#within(mesh, 'pennant')) {
      made = litMaterial(
        { color: (src.color as Color).clone(), roughness: 0.8, metalness: 0, side: DoubleSide },
        this.pennant.node(),
      );
    } else {
      made = litMaterial({
        color: (src.color as Color).clone(),
        roughness: src.roughness,
        metalness: src.metalness,
        vertexColors,
        side: src.side === DoubleSide ? DoubleSide : FrontSide,
      });
    }
    made.name = src.name;
    src.dispose();
    return made;
  }

  #within(o: Object3D, name: string): boolean {
    const part = this.parts.get(name);
    for (let p: Object3D | null = o; p !== null; p = p.parent) {
      if (p === part) {
        return true;
      }
    }
    return false;
  }

  /** The sail's vertex node: each vertex at its place on the shaped sail. */
  #sailNode(): Node<'vec3'> {
    return Fn(() => {
      const at = sailPoint(
        this.sail,
        positionGeometry.z.sub(LUFF_OFFSET),
        uv(1).x,
        uv(1).y,
        positionGeometry.y,
      );
      normalLocal.assign(at.normal);
      return at.position;
    })() as unknown as Node<'vec3'>;
  }
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
