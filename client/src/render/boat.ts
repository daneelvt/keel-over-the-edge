// SPDX-License-Identifier: AGPL-3.0-only

// A boat on the sea: its model, loaded from the catalog's art with three.js's
// GLTFLoader and the meshopt decoder, with every material replaced by one
// from the factory. The parts are found by their node names (hull, mast,
// boom, sail, telltales, pennant, rudder, tiller, daggerboard, sailor).
//
// Everything that moves is drawn from the physics: the boat is placed by its
// position and heading, lifted by its heave, then pitched and heeled about
// its centre of gravity, as the physics moves it on the waves; the boom swings to its angle;
// the rudder and tiller turn; the sail is shaped on the GPU for the boom's
// angle, the twist and the sailor's flattening, and ripples where it
// luffs; the telltales read each sail strip's flow; the pennant streams in
// the apparent wind at the masthead. The sailor sits at the helm, skinned
// and posed from the physics (sailors/onboat.ts), the tiller extension in
// one hand and the mainsheet in the other.
// The sailor is drawn in its look, loaded the first time it is asked for;
// the boat in its own (boatlook.ts): its topsides in its paint with its
// name on them, its sails in their cloth with its sail number on the
// main; a machine sailor's boat carries the machine mark on its sail, as
// the fleet's do. A boat with a headsail has it shaped as the main is, about
// its stay, from the clew's angle and its flows; a reefed main is drawn
// short (sailshape.ts), the reef points painted along each reef's row.
//
// A square rig (squarerig.ts): the yards' nodes turned by the braces as
// the physics holds them, the square sails bellied by each strip's wind,
// lifting or aback, and taken in as the boat reefs, their cloth the boat's
// with the sail number on the sail the model says; the wheel turned with
// the rudder; and the stern gallery's panes lit by night.

import {
  type BufferGeometry,
  type Color,
  DoubleSide,
  FrontSide,
  Group,
  type Material,
  Matrix4,
  Mesh,
  type MeshStandardMaterial,
  type Object3D,
  type Texture,
  Vector3,
} from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  Fn,
  float,
  normalLocal,
  positionGeometry,
  select,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { MeshStandardNodeMaterial, Node, WebGPURenderer } from 'three/webgpu';
import type { Boat as BoatKind, SailorArt } from '../catalog';
import type { BoatLooks } from '../catalog/boatlooks';
import { type HullShape, hullShape } from '../ocean/hulls';
import type { BoatPose } from '../predict/blend';
import { RECORDS } from '../predict/layout.gen';
import {
  clothColour,
  clothMasks,
  digits,
  type HullName,
  hullColour,
  type LookNodes,
  lookPalette,
  MASK_HEIGHT,
  MASK_WIDTH,
  NameAtlas,
  namePlace,
  numberedSail,
  numberPlace,
  type SailPrint,
  TOPSIDES,
  writeLook,
} from './boatlook';
import { headingToRotationY, type ScenePoint } from './coords';
import { chordAt, chordAtHalf, markPlace } from './machinemark';
import { litMaterial, sailGlow } from './materials';
import { Pennant } from './pennant';
import type { Gfx } from './renderer';
import { BoatSailor } from './sailors/onboat';
import { wheelClips } from './sailors/wheel';
import { headsailFrame, jibPoint, LUFF_OFFSET, sailPoint, sailUniforms } from './sailshape';
import {
  type Belly,
  bandTaken,
  readsMirrored,
  type SquareSail,
  shapeSquare,
  squareBelly,
  squarePoint,
  squareSails,
  squareVertex,
  toNode,
  wheelTurn,
  YARDS_NODES,
  yardDrop,
} from './squarerig';
import { FLOW_LUFFING, Telltales } from './telltales';

/**
 * Every model under art/ the game loads as it starts, by its path there, as
 * Vite serves it: the boats', the towns' and the plants'. No sailor's: the
 * player's own look is loaded once it is known, and every other when it is
 * wanted.
 */
const MODELS = import.meta.glob<string>(['../../../art/**/*.glb', '!../../../art/sailors/**'], {
  query: '?url',
  import: 'default',
  eager: true,
});
/**
 * The sailors' files the game loads only when wanted: the player's own
 * look's once it is known, the other looks' as a boat with one comes into
 * view, and every close level, as the camera comes near.
 */
const LATER = import.meta.glob<string>(
  ['../../../art/sailors/*/*.glb', '!../../../art/sailors/{test,vendor}/**'],
  {
    query: '?url',
    import: 'default',
  },
);

/** The URL of an art file named by the catalog, one the game loads as it starts. */
export function artUrl(path: string): string {
  const url = MODELS[`../../../art/${path}`];
  if (url === undefined) {
    throw new Error(`no art file ${path}`);
  }
  return url;
}

/** The URL of an art file, which the game may load only when it is wanted. */
export async function lazyArtUrl(path: string): Promise<string> {
  const url = MODELS[`../../../art/${path}`];
  if (url !== undefined) {
    return url;
  }
  const load = LATER[`../../../art/${path}`];
  if (load === undefined) {
    throw new Error(`no art file ${path}`);
  }
  return load();
}

/** A sailor's look as it is drawn: its art, its colours (sRGB) and whether it is a machine. */
export interface SailorLook {
  art: SailorArt;
  colours: { main: string; skin: string; hair: string };
  machine: boolean;
}

/** The sail's camber at full power, as a fraction of the chord; flattening scales it. */
export const FULL_CAMBER = 0.09;
/** Seconds over which the sail's ripple grows and dies away. */
const RIPPLE_EASE = 0.25;
const DEG = Math.PI / 180;

/** The node whose meshes are the stern gallery's panes, lit by night. */
export const GALLERY = 'gallery';
/** The gallery's lamplight, display values, at its brightest. */
export const LAMPLIGHT = [1.6, 0.95, 0.45] as const;
/**
 * How lit the boats' cabin lamps are, 0 by day to 1 by night: the scene
 * sets it as the sun sets, and every boat's gallery glows by it.
 */
export const lampsLit = uniform(0);

/** The square sails' cloth's masks' size: wider than high, as the sails are. */
const SQUARE_MASK = { width: 512, height: 320 } as const;

/**
 * Places a boat's nodes: root at the scene point, lifted by the heave and
 * turned to the heading; and heel pitched, then rolled, about its own
 * origin, which is at the centre of gravity's height (the model below it is
 * lowered by the same height).
 */
export function placeBoatNodes(
  root: Object3D,
  heel: Object3D,
  at: ScenePoint,
  heading: number,
  heelAngle: number,
  pitch = 0,
  heave = 0,
): void {
  root.position.set(at.x, at.y + heave, at.z);
  root.rotation.set(0, headingToRotationY(heading), 0);
  // Positive heel puts the starboard side (+x) down: a turn of −heel about
  // the axis pointing aft (+z). Positive pitch lifts the bow (−z): a turn
  // about the axis pointing to starboard. The roll is about the pitched
  // boat's own fore-and-aft axis, so the pitch is the outer turn.
  heel.rotation.set(pitch, 0, -heelAngle);
}

/**
 * How hard a luffing strip ripples, 0.4 to 1: harder the further its angle
 * of attack is below the luffing angle.
 */
export function luffing(attack: number, luffAngle: number): number {
  return 0.4 + 0.6 * Math.max(0, Math.min(1, 1 - Math.abs(attack) / luffAngle));
}

/**
 * The heights of a sail's reef rows, as fractions of its luff from the
 * foot, where its geometry has a row of vertices at each reef's height (a
 * slab reef: the cloth below is gathered along the boom); null where it
 * has not, or the sail does not reef (a smaller rig, drawn smaller).
 */
export function reefRows(
  geometry: BufferGeometry | undefined,
  reefs: readonly number[],
): number[] | null {
  const uv1 = geometry?.getAttribute('uv1');
  const rows = reefs.filter((share) => share < 1).map((share) => 1 - share);
  if (uv1 === undefined || rows.length === 0) {
    return null;
  }
  const has = (v: number): boolean => {
    for (let i = 0; i < uv1.count; i++) {
      if (Math.abs(uv1.getY(i) - v) < 1e-3) {
        return true;
      }
    }
    return false;
  };
  return rows.every(has) ? rows : null;
}

/** The share of its luff a main keeps at a reef level, 0 … 2 and between, by the catalog's reefs. */
export function reefShare(reefs: readonly number[], level: number): number {
  const top = reefs.length - 1;
  const l = Math.min(Math.max(level, 0), top);
  const i = Math.min(Math.floor(l), top - 1);
  const a = reefs[i] ?? 1;
  const b = reefs[i + 1] ?? a;
  return a + (b - a) * (l - i);
}

export class Boat {
  readonly root = new Group();
  /** Rolled by the heel about the centre of gravity's height. */
  readonly heel = new Group();
  /** The model, lowered so that the heel's pivot is at its centre of gravity. */
  readonly model = new Group();
  readonly parts = new Map<string, Object3D>();
  readonly sail = sailUniforms();
  /** The headsail's shape, and how far aft of its tack its head is (its node's rake). */
  readonly jib = sailUniforms();
  readonly jibRake = uniform(0);
  readonly telltales = new Telltales();
  readonly pennant = new Pennant();
  /** The sailor aboard and drawn, once loaded, in the look last asked for (or the one before, while it loads). */
  get sailor(): BoatSailor | null {
    return this.#shown;
  }

  /** Whether the sailor drawn is a machine sailor's machine. */
  get machineAboard(): boolean {
    return this.#shownMachine;
  }

  /** The sailor drawn's look: its deck level's path and whether it is a machine; null before one is. */
  drawnLook(): { model: string; machine: boolean } | null {
    for (const [art, s] of this.#sailors) {
      if (s === this.#shown) {
        return { model: art.model, machine: this.#shownMachine };
      }
    }
    return null;
  }
  /** The hull's volume, which the sea is kept out of, from the model; null until loaded. */
  hullShape: HullShape | null = null;

  readonly #kind: BoatKind;
  /** The square sails' strips' bellies and ripples (fore foot, fore head, after foot, after head), the reef and the time. */
  readonly square = {
    depth: [uniform(0), uniform(0), uniform(0), uniform(0)],
    ripple: [uniform(0), uniform(0), uniform(0), uniform(0)],
    reef: uniform(0),
  };
  /** The model's square sails, and their meshes. */
  #squareSails: SquareSail[] = [];
  readonly #squareMeshes = new Set<Object3D>();
  /** Each headsail's mesh, and its head's rake aft of its tack. */
  readonly #headsails = new Map<Object3D, number>();
  /** The yards that come down as their sails' bands are taken in: each, its height at rest and its drop. */
  readonly #yards: { node: Object3D; rest: number; drop: number; sail: SquareSail }[] = [];
  readonly #belly: Belly = { depth: 0, ripple: 0 };
  /** Set when the boat is put somewhere at once: its sails take the wind as it is at the next frame. */
  #settled = false;
  readonly #ripple = new Float64Array(2);
  readonly #jibRipple = new Float64Array(2);
  /** The main's reef rows, where its reefs are slab reefs; else none. */
  #reefRows: number[] = [];
  /** The catalog's looks, and the boat's own as its shaders read it. */
  readonly #looks: BoatLooks;
  readonly #look = {
    paint: uniform(0),
    cloth: uniform(0),
    number: uniform(0),
    row: uniform(-1),
    machine: uniform(0),
  };
  readonly #lookValues = new Float32Array(3);
  /** The boat's name, lettered on its topsides from a texture of one row; null until loaded. */
  #names: NameAtlas | null = null;
  #name = '';
  /** The sailors loaded, by their art, and those loading. */
  readonly #sailors = new Map<SailorArt, BoatSailor>();
  readonly #loading = new Set<SailorArt>();
  /** The sailor drawn, and whether it is a machine; the look last asked for. */
  #shown: BoatSailor | null = null;
  #shownMachine = false;
  #wanted: SailorLook | null = null;
  #renderer: WebGPURenderer | null = null;
  #seed = 1;

  constructor(kind: BoatKind, looks: BoatLooks) {
    this.#kind = kind;
    this.#looks = looks;
    const { hull, rig } = kind.physics;
    this.root.name = 'boat';
    this.heel.position.y = hull.centreOfGravity;
    this.model.position.y = -hull.centreOfGravity;
    this.root.add(this.heel);
    this.heel.add(this.model);
    this.sail.footV.value = rig.footStrip;
    this.sail.headV.value = rig.headStrip;
    this.sail.luff.value = rig.luff;
    const { headsails } = kind.physics;
    this.jib.footV.value = headsails.headsailFootStrip;
    this.jib.headV.value = headsails.headsailHeadStrip;
  }

  /** The boat put somewhere at once: what eases with the wind is drawn as the wind is at the next frame. */
  settle(): void {
    this.#settled = true;
  }

  /** A named node's place in the model's frame, wherever it hangs; null for none. */
  nodeAt(name: string): Vector3 | null {
    const o = this.parts.get(name);
    const model = this.model.children[0];
    if (o === undefined || model === undefined) {
      return null;
    }
    model.updateMatrixWorld(true);
    const inModel = new Matrix4().copy(model.matrixWorld).invert().multiply(o.matrixWorld);
    return new Vector3().setFromMatrixPosition(inModel);
  }

  /** The kind of boat it is. */
  get kind(): BoatKind {
    return this.#kind;
  }

  /** Loads the boat's model from the catalog's art path; its sails carry the class insignia. */
  async load(insignia: string): Promise<void> {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(artUrl(this.#kind.art.model));
    const model = gltf.scene;
    model.traverse((o) => {
      if (o.name !== '') {
        this.parts.set(o.name, o);
      }
    });
    let sail: Mesh | undefined;
    this.parts.get('sail')?.traverse((o) => {
      if (sail === undefined && o instanceof Mesh) {
        sail = o;
      }
    });
    const { foot, luff, reefs } = this.#kind.physics.rig;
    const rows = reefRows(sail?.geometry, reefs);
    this.#reefRows = rows ?? [];
    this.sail.reefGather.value = rows === null ? 0 : 1;
    // Each headsail in its own frame, at its tack: a mesh hung below that
    // frame's node is taken into it, so its own vertices are the frame's.
    this.#headsails.clear();
    const headsails: Mesh[] = [];
    // A square sail under the headsails' node (a spritsail) is not one.
    const square = new Set(squareSails(model).flatMap((s) => s.meshes));
    this.parts.get('jib')?.traverse((o) => {
      if (o instanceof Mesh && !square.has(o)) {
        headsails.push(o);
      }
    });
    model.updateMatrixWorld(true);
    for (const m of headsails) {
      const frame = headsailFrame(m);
      if (frame.node !== m) {
        const inFrame = new Matrix4().copy(frame.node.matrixWorld).invert().multiply(m.matrixWorld);
        m.geometry = m.geometry.clone().applyMatrix4(inFrame);
        frame.node.add(m);
        m.position.set(0, 0, 0);
        m.quaternion.identity();
        m.scale.set(1, 1, 1);
      }
      this.#headsails.set(m, frame.rake);
    }
    const rake = this.#headsails.values().next().value;
    this.jibRake.value = rake ?? 0;
    // The sail that carries the number, by the model's word.
    const numbered = numberedSail(this.parts.values());
    const number = {
      place: numberPlace(foot, luff, (v) => chordAt(sail?.geometry, v)),
      digits: digits(),
      mirrored: NUMBER_MIRRORED,
    };
    const cloth: SailPrint = {
      masks: clothMasks({
        insignia,
        reefRows: this.#reefRows,
        mark: markPlace(foot, luff, chordAtHalf(sail?.geometry)),
      }),
      number: numbered === 'sail' ? number : null,
    };
    const jibCloth: SailPrint | null = this.parts.has('jib')
      ? {
          masks: clothMasks(
            { insignia: '', reefRows: [], mark: null },
            MASK_WIDTH / 2,
            MASK_HEIGHT / 2,
          ),
          number: numbered === 'jib' ? number : null,
        }
      : null;
    this.#names = new NameAtlas(1, this.#looks.boatLooks.lettering);
    // The square sails: each mesh given its shape's values.
    this.#squareSails = squareSails(model);
    let squareCloth: SailPrint | null = null;
    for (const s of this.#squareSails) {
      for (const m of s.meshes) {
        shapeSquare(m.geometry, s, toNode(m, s, model));
        this.#squareMeshes.add(m);
      }
      if (s.yard !== null && yardDrop(s) > 0) {
        this.#yards.push({ node: s.yard, rest: s.yard.position.y, drop: yardDrop(s), sail: s });
      }
    }
    if (this.#squareSails.length > 0) {
      squareCloth = squarePrint(this.#squareSails);
    }
    model.traverse((o) => {
      if (o instanceof Mesh) {
        o.material = this.#replace(o, o.material as Material, cloth, jibCloth, squareCloth);
        // The shaped sail, the ribbons and the pennant leave their rest bounds.
        o.frustumCulled = false;
      }
    });
    this.model.add(model);
    this.hullShape = hullShape(this.parts.get('hull')?.userData);
    this.#letter();
  }

  /**
   * The boat takes its own look: a boat look code (negative for none told:
   * the first paint and cloth, no number) and its name ("" for none).
   */
  setBoatLook(code: number, name: string): void {
    writeLook(this.#looks, code, this.#lookValues, 0);
    this.#look.paint.value = this.#lookValues[0] ?? 0;
    this.#look.cloth.value = this.#lookValues[1] ?? 0;
    this.#look.number.value = this.#lookValues[2] ?? 0;
    this.#name = name;
    this.#letter();
  }

  /** The look drawn: the paint's and cloth's places, the sail number, the name lettered and its row (−1 for none). */
  drawnBoatLook(): { paint: number; cloth: number; number: number; name: string; row: number } {
    return {
      paint: this.#look.paint.value,
      cloth: this.#look.cloth.value,
      number: this.#look.number.value,
      name: this.#names?.rows.names[this.#look.row.value] ?? '',
      row: this.#look.row.value,
    };
  }

  /** Letters the name into its texture, if it has changed. */
  #letter(): void {
    const names = this.#names;
    if (names === null) {
      return;
    }
    this.#look.row.value = names.rowOf(this.#name, 0);
    names.commit();
  }

  /**
   * The sailor aboard takes a look: its art, loaded the first time (the
   * sailor drawn till then stays), and its colours; a machine sailor's look
   * prints the machine mark on the sail. Resolves once the look is drawn.
   */
  async setLook(look: SailorLook): Promise<void> {
    this.#wanted = look;
    this.#printMark(look.machine);
    const renderer = this.#renderer;
    if (renderer === null) {
      return;
    }
    let sailor = this.#sailors.get(look.art);
    if (sailor === undefined) {
      if (this.#loading.has(look.art)) {
        return;
      }
      this.#loading.add(look.art);
      try {
        sailor = await this.#load(look, renderer);
      } finally {
        this.#loading.delete(look.art);
      }
      this.#sailors.set(look.art, sailor);
    }
    const wanted = this.#wanted;
    if (wanted === null || wanted.art !== look.art) {
      // Another look was asked for meanwhile: it is drawn when it loads.
      if (wanted !== null && this.#sailors.has(wanted.art)) {
        await this.setLook(wanted);
      }
      return;
    }
    sailor.colour(wanted.colours);
    this.#shown = sailor;
    this.#shownMachine = wanted.machine;
    for (const s of this.#sailors.values()) {
      s.shown = s === sailor;
    }
  }

  async #load(look: SailorLook, renderer: WebGPURenderer): Promise<BoatSailor> {
    const a = look.art;
    return BoatSailor.load(
      {
        model: await lazyArtUrl(a.model),
        close: () => lazyArtUrl(a.close),
        clips: await lazyArtUrl(a.clips),
        wheel: () => lazyArtUrl(wheelClips(a.clips)),
        colours: look.colours,
      },
      renderer,
      this.model,
      this.parts,
      this.#kind,
      this.#seed,
      look.machine,
    ).then((s) => {
      s.shown = false;
      return s;
    });
  }

  /** Prints the machine mark on the sail, or takes it off. */
  #printMark(on: boolean): void {
    this.#look.machine.value = on ? 1 : 0;
  }

  /**
   * Seats a sailor in the boat, once the boat's model is loaded, in a look;
   * the renderer decides how its textures are transcoded. seed sets the
   * sailor's own rhythms.
   */
  async loadSailor(look: SailorLook, renderer: WebGPURenderer, seed = 1): Promise<void> {
    this.#renderer = renderer;
    this.#seed = seed;
    // A look asked for before (the boat watched) is the one drawn.
    await this.setLook(this.#wanted ?? look);
  }

  /**
   * Draws the boat in a pose at a scene point, from the latest step's Out.
   * time is world time; dt the world time since the last frame, for what
   * eases, in seconds.
   */
  draw(at: ScenePoint, pose: BoatPose, out: Float64Array, time: number, dt: number): void {
    placeBoatNodes(this.root, this.heel, at, pose.heading, pose.heel, pose.pitch, pose.heave);
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
    // The GPU holds time as a float32, too coarse for a world's time since
    // its epoch: the flutter's frequencies are whole radians a second, so
    // time modulo 2π seconds draws the same, without a seam.
    this.sail.time.value = time % (2 * Math.PI);
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
    // Reefed, the main keeps a share of its luff; an Out not yet stepped says 0.
    const share = out[RECORDS.out.reefShare] ?? 1;
    this.sail.reefShare.value = share > 0 ? share : 1;
    this.#drawJib(pose, out, flat, ease);
    this.#drawSquare(pose, out, ease);
    this.telltales.update(out, pose.boom, dt);
    this.pennant.update(out, dt);

    this.sailor?.draw(pose, out, dt);
  }

  /** The headsail from the clew's angle, its twist and its flows, as the main is drawn. */
  #drawJib(pose: BoatPose, out: Float64Array, flat: number, ease: number): void {
    const { rig } = this.#kind.physics;
    const j = this.jib;
    const turn = Math.max(-1, Math.min(1, pose.jib / (rig.twistTurn * DEG)));
    j.boom.value = pose.jib;
    j.side.value = turn;
    j.twist.value = (out[RECORDS.out.jibTwist] ?? 0) * turn;
    j.camber.value = FULL_CAMBER * (flat > 0 ? flat : 1);
    j.time.value = this.sail.time.value;
    for (let i = 0; i < 2; i++) {
      const flow = out[i === 0 ? RECORDS.out.jibFootFlow : RECORDS.out.jibHeadFlow] ?? 1;
      const attack = out[i === 0 ? RECORDS.out.jibFootAttack : RECORDS.out.jibHeadAttack] ?? 0;
      const want = flow === FLOW_LUFFING ? luffing(attack, rig.luffAngle * DEG) : 0;
      const r = this.#jibRipple[i] ?? 0;
      this.#jibRipple[i] = r + (want - r) * ease;
    }
    j.rippleFoot.value = this.#jibRipple[0] ?? 0;
    j.rippleHead.value = this.#jibRipple[1] ?? 0;
  }

  /** The yards turned, the square sails filled by each strip's wind, and the wheel turned with the rudder. */
  #drawSquare(pose: BoatPose, out: Float64Array, ease: number): void {
    for (const name of Object.keys(YARDS_NODES) as (keyof typeof YARDS_NODES)[]) {
      const node = this.parts.get(name);
      if (node !== undefined) {
        node.rotation.y = YARDS_NODES[name] === 'fore' ? pose.foreYardsTurn : pose.yardsTurn;
      }
    }
    const wheel = this.parts.get('wheel');
    if (wheel !== undefined) {
      wheel.rotation.z = wheelTurn(pose.rudder, this.#kind.physics.foils.rudderAngle);
    }
    if (this.#squareSails.length === 0) {
      return;
    }
    const o = RECORDS.out;
    const strips = [
      [o.foreFootAttack, o.foreFootFlow],
      [o.foreHeadAttack, o.foreHeadFlow],
      [o.afterFootAttack, o.afterFootFlow],
      [o.afterHeadAttack, o.afterHeadFlow],
    ] as const;
    const sq = this.square;
    // Eased as the wind changes; a frame with no time gone (held, or the
    // first), or the first after the boat is settled, shows the wind as it is.
    const k = ease > 0 && !this.#settled ? ease : 1;
    this.#settled = false;
    for (let i = 0; i < 4; i++) {
      const [attack, flow] = strips[i] as readonly [number, number];
      const b = squareBelly(out[attack] ?? 0, out[flow] ?? 1, this.#belly);
      const d = sq.depth[i] as typeof sq.reef;
      const r = sq.ripple[i] as typeof sq.reef;
      d.value += (b.depth - d.value) * k;
      r.value += (b.ripple - r.value) * k;
    }
    sq.reef.value = pose.reef;
    for (const y of this.#yards) {
      y.node.position.y = y.rest - y.drop * bandTaken(y.sail.reef, pose.reef);
    }
  }

  /** After a new renderer: everything is kept on the CPU side and uploaded again by itself. */
  attached(_gfx: Gfx): void {}

  #replace(
    mesh: Mesh,
    m: Material,
    cloth: SailPrint,
    jibCloth: SailPrint | null,
    squareCloth: SailPrint | null,
  ): Material {
    const src = m as MeshStandardMaterial;
    const vertexColors = mesh.geometry.hasAttribute('color');
    const look = this.#look as unknown as LookNodes;
    const palette = lookPalette(this.#looks);
    let made: Material;
    if (squareCloth !== null && this.#squareMeshes.has(mesh)) {
      // The square sails: their cloth's v runs down from the head; the
      // number only on the sail that carries it.
      made = litMaterial(
        { roughness: src.roughness, metalness: 0, side: DoubleSide },
        this.#squareNode(),
      );
      const sv = squareVertex();
      const numbered = { ...look, number: look.number.mul(varying(sv.numbered)) } as LookNodes;
      const at = vec2(uv().x, float(1).sub(uv().y));
      const c = vec4(clothColour(palette, numbered, at, squareCloth), 1);
      (made as MeshStandardNodeMaterial).colorNode = c;
      (made as MeshStandardNodeMaterial).emissiveNode = sailGlow(c);
    } else if (this.#within(mesh, GALLERY)) {
      // The stern gallery's panes: dark glass by day, lamplit by night.
      made = litMaterial({
        color: (src.color as Color).clone(),
        roughness: src.roughness,
        metalness: src.metalness,
        vertexColors,
      });
      (made as MeshStandardNodeMaterial).emissiveNode = vec3(...LAMPLIGHT).mul(lampsLit);
    } else if (jibCloth !== null && this.#within(mesh, 'jib')) {
      made = litMaterial(
        { roughness: src.roughness, metalness: 0, side: DoubleSide },
        this.#jibNode(this.#headsails.get(mesh) ?? this.jibRake.value),
      );
      const c = vec4(clothColour(palette, look, uv(), jibCloth), 1);
      (made as MeshStandardNodeMaterial).colorNode = c;
      (made as MeshStandardNodeMaterial).emissiveNode = sailGlow(c);
    } else if (this.#within(mesh, 'sail')) {
      // Daylight comes through flax: its shaded side glows a little, with the
      // insignia and number showing through, as much as the hour gives.
      made = litMaterial(
        { roughness: src.roughness, metalness: 0, side: DoubleSide },
        this.#sailNode(),
      );
      const c = vec4(clothColour(palette, look, uv(), cloth), 1);
      (made as MeshStandardNodeMaterial).colorNode = c;
      (made as MeshStandardNodeMaterial).emissiveNode = sailGlow(c);
    } else if (src.name === TOPSIDES) {
      // The topsides in the boat's paint, times each plank's tone, with
      // its name on them.
      made = litMaterial({
        roughness: src.roughness,
        metalness: src.metalness,
        vertexColors,
        side: src.side === DoubleSide ? DoubleSide : FrontSide,
      });
      const place = namePlace(
        mesh.geometry.getAttribute('position').array,
        this.parts.get('hull')?.userData,
      );
      const names = this.#names;
      const name: HullName | null =
        place === null || names === null
          ? null
          : { texture: names.texture as Texture, rows: names.rows.rows, place };
      (made as MeshStandardNodeMaterial).colorNode = vec4(
        hullColour(palette, look, varying(positionGeometry), name),
        1,
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

  /** The square sails' vertex node: each vertex bellied by its strip's wind, and taken in by the reef. */
  #squareNode(): Node<'vec3'> {
    const sq = this.square;
    return Fn(() => {
      const sv = squareVertex();
      const slot = sv.index.sub(sv.index.div(4).floor().mul(4));
      const pick = (u: readonly Node<'float'>[]): Node<'float'> =>
        select(
          slot.lessThan(0.5),
          u[0] as Node<'float'>,
          select(
            slot.lessThan(1.5),
            u[1] as Node<'float'>,
            select(slot.lessThan(2.5), u[2] as Node<'float'>, u[3] as Node<'float'>),
          ),
        ) as unknown as Node<'float'>;
      const at = squarePoint(
        {
          depth: pick(sq.depth as unknown as Node<'float'>[]),
          ripple: pick(sq.ripple as unknown as Node<'float'>[]),
          reef: sq.reef as unknown as Node<'float'>,
          time: this.sail.time as unknown as Node<'float'>,
        },
        sv,
        positionGeometry as unknown as Node<'vec3'>,
        uv().x,
        sv.down,
      );
      normalLocal.assign(at.normal);
      return at.position;
    })() as unknown as Node<'vec3'>;
  }

  /** A headsail's vertex node: each vertex at its place on the shaped headsail, its head rake aft of its tack. */
  #jibNode(rake: number): Node<'vec3'> {
    const r = float(rake);
    return Fn(() => {
      const fv = uv(1).y;
      const at = jibPoint(
        this.jib,
        positionGeometry.z.sub(r.mul(fv)),
        uv(1).x,
        fv,
        positionGeometry.y,
        r,
      );
      normalLocal.assign(at.normal);
      return at.position;
    })() as unknown as Node<'vec3'>;
  }
}

/**
 * The square sails' print: their cloth's masks (no insignia, no reef rows:
 * they are many sails of one mask), and the number's place on the sail
 * that carries it, by its width and height, read the way its face reads.
 */
export function squarePrint(sails: readonly SquareSail[]): SailPrint {
  const masks = clothMasks(
    { insignia: '', reefRows: [], mark: null, upright: true },
    SQUARE_MASK.width,
    SQUARE_MASK.height,
  );
  const numbered = sails.find((s) => s.numbered);
  if (numbered === undefined) {
    return { masks, number: null };
  }
  const geometry = numbered.meshes[0]?.geometry;
  return {
    masks,
    number: {
      place: numberPlace(numbered.width, numbered.head - numbered.foot, () => 1),
      digits: digits(),
      mirrored: geometry === undefined ? false : readsMirrored(geometry),
    },
  };
}

/**
 * Whether a sail's front face reads its cloth's u (along the foot from the
 * luff) from right to left, as the boats' models are made: its number's
 * digits are laid out the other way on that face.
 */
export const NUMBER_MIRRORED = true;
