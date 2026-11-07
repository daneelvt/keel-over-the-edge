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
// a machine sailor's boat carries the machine mark on its sail, as the
// fleet's do. A boat with a headsail has it shaped as the main is, about
// its stay, from the clew's angle and its flows; a reefed main is drawn
// short (sailshape.ts), the reef points painted along each reef's row.

import {
  type BufferGeometry,
  CanvasTexture,
  type Color,
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
import { Fn, normalLocal, positionGeometry, uniform, uv } from 'three/tsl';
import type { MeshStandardNodeMaterial, Node, WebGPURenderer } from 'three/webgpu';
import type { Boat as BoatKind, SailorArt } from '../catalog';
import { type HullShape, hullShape } from '../ocean/hulls';
import type { BoatPose } from '../predict/blend';
import { RECORDS } from '../predict/layout.gen';
import { headingToRotationY, type ScenePoint } from './coords';
import { chordAtHalf, type MarkPlace, markInk, markPlace, paintMark } from './machinemark';
import { litMaterial, sailGlow } from './materials';
import { Pennant } from './pennant';
import type { Gfx } from './renderer';
import { BoatSailor } from './sailors/onboat';
import { jibPoint, LUFF_OFFSET, sailPoint, sailUniforms } from './sailshape';
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
  readonly #ripple = new Float64Array(2);
  readonly #jibRipple = new Float64Array(2);
  /** The main's reef rows, where its reefs are slab reefs; else none. */
  #reefRows: number[] = [];
  /** The sail's cloth, what is printed on it, and where the machine mark goes. */
  #cloth: CanvasTexture | null = null;
  #number = '';
  #insignia = '';
  #mark: MarkPlace | null = null;
  #marked = false;
  /** The sailors loaded, by their art, and those loading. */
  readonly #sailors = new Map<SailorArt, BoatSailor>();
  readonly #loading = new Set<SailorArt>();
  /** The sailor drawn, and whether it is a machine; the look last asked for. */
  #shown: BoatSailor | null = null;
  #shownMachine = false;
  #wanted: SailorLook | null = null;
  #renderer: WebGPURenderer | null = null;
  #seed = 1;

  constructor(kind: BoatKind) {
    this.#kind = kind;
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

  /** The kind of boat it is. */
  get kind(): BoatKind {
    return this.#kind;
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
    const cloth = sailCloth(sailNumber, insignia, this.#reefRows);
    this.#cloth = cloth;
    this.#number = sailNumber;
    this.#insignia = insignia;
    const rake = (this.parts.get('jib')?.userData as { rake?: unknown } | undefined)?.rake;
    this.jibRake.value = typeof rake === 'number' && Number.isFinite(rake) ? rake : 0;
    const jibCloth = this.parts.has('jib') ? headsailCloth() : null;
    this.#mark = markPlace(foot, luff, chordAtHalf(sail?.geometry));
    model.traverse((o) => {
      if (o instanceof Mesh) {
        o.material = this.#replace(o, o.material as Material, cloth, jibCloth);
        // The shaped sail, the ribbons and the pennant leave their rest bounds.
        o.frustumCulled = false;
      }
    });
    this.model.add(model);
    this.hullShape = hullShape(this.parts.get('hull')?.userData);
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
    const cloth = this.#cloth;
    if (on === this.#marked || cloth === null || this.#mark === null) {
      return;
    }
    this.#marked = on;
    const g = (cloth.image as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D;
    paintCloth(g, this.#number, this.#insignia, this.#reefRows);
    if (on) {
      paintMark(g, this.#mark, CLOTH_WIDTH, CLOTH_HEIGHT, markInk(CLOTH));
    }
    cloth.needsUpdate = true;
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

  /** After a new renderer: everything is kept on the CPU side and uploaded again by itself. */
  attached(_gfx: Gfx): void {}

  #replace(
    mesh: Mesh,
    m: Material,
    cloth: CanvasTexture,
    jibCloth: CanvasTexture | null,
  ): Material {
    const src = m as MeshStandardMaterial;
    const vertexColors = mesh.geometry.hasAttribute('color');
    let made: Material;
    if (jibCloth !== null && this.#within(mesh, 'jib')) {
      made = litMaterial(
        { map: jibCloth, roughness: src.roughness, metalness: 0, side: DoubleSide },
        this.#jibNode(),
      );
      (made as MeshStandardNodeMaterial).emissiveNode = sailGlow(jibCloth);
    } else if (this.#within(mesh, 'sail')) {
      // Daylight comes through flax: its shaded side glows a little, with the
      // insignia and number showing through, as much as the hour gives.
      made = litMaterial(
        { map: cloth, roughness: src.roughness, metalness: 0, side: DoubleSide },
        this.#sailNode(),
      );
      (made as MeshStandardNodeMaterial).emissiveNode = sailGlow(cloth);
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

  /** The headsail's vertex node: each vertex at its place on the shaped headsail. */
  #jibNode(): Node<'vec3'> {
    return Fn(() => {
      const fv = uv(1).y;
      const at = jibPoint(
        this.jib,
        positionGeometry.z.sub(this.jibRake.mul(fv)),
        uv(1).x,
        fv,
        positionGeometry.y,
        this.jibRake,
      );
      normalLocal.assign(at.normal);
      return at.position;
    })() as unknown as Node<'vec3'>;
  }
}

/** The sail's cloth's colour: cream flax. */
export const CLOTH = '#efe6d2';
/** The cloth's canvas: its width the foot, its height the luff, at the same scale. */
export const CLOTH_WIDTH = 512;
export const CLOTH_HEIGHT = 960;

/**
 * The sail's cloth, drawn into a canvas: cream flax in crosscut panels,
 * the class insignia near the head and the sail number, if any, below it.
 * The canvas's width is the foot and its height the luff, at the same
 * scale.
 */
export function sailCloth(
  number: string,
  insignia: string,
  reefRows: readonly number[] = [],
): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = CLOTH_WIDTH;
  canvas.height = CLOTH_HEIGHT;
  paintCloth(canvas.getContext('2d') as CanvasRenderingContext2D, number, insignia, reefRows);
  return clothTexture(canvas);
}

/** The headsail's cloth: plain flax in its panels, no insignia and no number. */
export function headsailCloth(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = CLOTH_WIDTH / 2;
  canvas.height = CLOTH_HEIGHT / 2;
  const g = canvas.getContext('2d') as CanvasRenderingContext2D;
  g.fillStyle = CLOTH;
  g.fillRect(0, 0, canvas.width, canvas.height);
  seams(g, canvas.width, canvas.height, 31, 35);
  return clothTexture(canvas);
}

/** Panel seams, square to the leech, every gap pixels, falling drop across the width. */
function seams(
  g: CanvasRenderingContext2D,
  width: number,
  height: number,
  gap: number,
  drop: number,
) {
  g.strokeStyle = 'rgba(120, 100, 70, 0.28)';
  g.lineWidth = 2;
  for (let y = gap * 0.65; y < height + drop; y += gap) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(width, y - drop);
    g.stroke();
  }
}

/**
 * Paints the cloth into a canvas's CLOTH_WIDTH × CLOTH_HEIGHT from its
 * origin, as sailCloth has it: and a row of reef points at each reef row's
 * height, a fraction of the luff from the foot.
 */
export function paintCloth(
  g: CanvasRenderingContext2D,
  number: string,
  insignia: string,
  reefRows: readonly number[] = [],
): void {
  const width = CLOTH_WIDTH;
  const height = CLOTH_HEIGHT;
  g.fillStyle = CLOTH;
  g.fillRect(0, 0, width, height);
  // Panel seams, square to the leech, and a faint weave.
  g.strokeStyle = 'rgba(120, 100, 70, 0.28)';
  g.lineWidth = 2;
  for (let y = 40; y < height; y += 62) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(width, y - 70);
    g.stroke();
  }
  // The reef points: a band of reinforcing cloth and short ties, a tack
  // cringle at the luff and a clew cringle at the leech of each row.
  for (const v of reefRows) {
    const y = (1 - v) * height;
    g.fillStyle = 'rgba(214, 199, 166, 0.9)';
    g.fillRect(0, y - 5, width, 10);
    g.fillStyle = '#5b4a36';
    for (let x = 0.05 * width; x < width; x += 0.075 * width) {
      g.fillRect(x - 1.5, y - 9, 3, 18);
    }
  }
  // The insignia in a ring, 22% of the foot across, near the head.
  const cx = 0.115 * width;
  const cy = 0.2 * height;
  const r = 0.085 * width;
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
  g.fillText(number, 0.16 * width, 0.38 * height);
}

/** A cloth's canvas as the sail's texture. */
export function clothTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const t = new CanvasTexture(canvas);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
