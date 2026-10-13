// SPDX-License-Identifier: AGPL-3.0-only

// Navigation lights: the glow of each boat's lantern by night, red, green
// or white as the boat is seen. The International Regulations for
// Preventing Collisions at Sea, Rule 21: a sidelight shows from right ahead
// to 22.5° abaft the beam on its own side, green to starboard and red to
// port; a sternlight white over the 135° astern. Each fades across 4° at
// its edges, inside the cut-offs of Annex I, section 9, so from right
// ahead both red and green show. A boat's arcs are its own: measured in
// its frame, heel and pitch included. Which lights a boat carries is the
// catalog's; a sailing vessel under 20 m may carry the three in one
// lantern at the masthead (Rule 25(b)).
//
// Each lantern is a glow added to the picture, one instanced draw for
// every boat in view, the player's among them. It is a place: it bends
// with the dome, so the sea hides it past the horizon. It keeps a least
// size on screen far off, and dims with distance. Lanterns are lit while
// the sun is below the horizon at the boat (Rule 20(b)), coming on through
// the sun's last degree.

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Euler,
  InstancedInterleavedBuffer,
  InstancedMesh,
  Quaternion,
  Vector3,
} from 'three';
import {
  attribute,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  dot,
  exp,
  float,
  instancedDynamicBufferAttribute,
  max,
  smoothstep,
  uniform,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { Light } from '../catalog';
import { headingToRotationY } from './coords';
import { basicMaterial, bendScene } from './materials';
import { toLinear } from './sky';

const DEG = Math.PI / 180;

/** A sidelight's arc from right ahead, in degrees (Rule 21(b)). */
export const SIDELIGHT_ARC = 112.5;
/** The width of the fade across each edge of an arc, in degrees. */
export const ARC_FADE = 4;

/** How much of each colour a boat's lights show toward a bearing. */
export interface LightWeights {
  red: number;
  green: number;
  white: number;
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

/** An angle in degrees, in (−180, 180]. */
function wrap180(a: number): number {
  const d = (((a + 180) % 360) + 360) % 360;
  return d === 0 ? 180 : d - 180;
}

/**
 * The colours a boat's lights show toward a bearing in degrees, from its
 * bow clockwise, to starboard: green over the starboard arc, red over the
 * port, white astern, faded across ARC_FADE at each edge. A tricolour
 * lantern shows all three.
 */
export function lightWeights(
  bearing: number,
  lights: readonly Light[],
  out: LightWeights,
): LightWeights {
  const b = wrap180(bearing);
  const h = ARC_FADE / 2;
  const side = (x: number): number =>
    smooth(-h, h, x) * (1 - smooth(SIDELIGHT_ARC - h, SIDELIGHT_ARC + h, x));
  const all = lights.includes('tricolour');
  out.green = all || lights.includes('starboard') ? side(b) : 0;
  out.red = all || lights.includes('port') ? side(-b) : 0;
  out.white =
    all || lights.includes('stern') ? smooth(SIDELIGHT_ARC - h, SIDELIGHT_ARC + h, Math.abs(b)) : 0;
  return out;
}

/** The lights' colours, display values. */
const RED = [1, 0.14, 0.08] as const;
const GREEN = [0.12, 1, 0.42] as const;
const WHITE = [1, 0.94, 0.82] as const;

/** A boat's pose, as far as its lantern needs it. */
export interface LanternPose {
  east: number;
  north: number;
  heading: number;
  heel: number;
  pitch: number;
  heave: number;
}

/** The most lanterns drawn: every boat in view and the player's. */
export const LANTERN_CAPACITY = 129;
/** A glow's size, metres, and the least it is drawn on screen, CSS pixels. */
const GLOW_SIZE = 0.45;
const LEAST_PIXELS = 7;
/** Across a glow, the bearing it shows for runs this far either side, degrees: from right ahead red and green show side by side. */
const SPREAD = 1.5;
/** The glow is drawn this far toward the camera from the lantern, metres, clear of its glass. */
const CLEAR = 0.2;

export class Lanterns {
  readonly mesh: InstancedMesh;
  /** Each lantern: its scene position, and the bearing it is seen from, in degrees. */
  readonly place = attr();
  /** Each lantern's lights, 1 or 0: port, starboard, stern; and its glow's strength. */
  readonly shows = attr();
  /** Metres a CSS pixel covers one metre from the camera. */
  readonly perPixel = uniform(0.001);
  count = 0;

  /** The lantern in the model's frame, the model's centre of gravity's height, and its lights. */
  readonly #at = new Vector3();
  #cog = 0;
  #lights: readonly Light[] = [];
  readonly #q = new Quaternion();
  readonly #qHeel = new Quaternion();
  readonly #e = new Euler();
  readonly #v = new Vector3();
  readonly #c = new Vector3();

  constructor() {
    const corners = new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]);
    const g = new BufferGeometry();
    g.setAttribute('corner', new BufferAttribute(corners, 2));
    // three.js reads a geometry's size from its positions.
    g.setAttribute('position', new BufferAttribute(new Float32Array(12), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);

    const place = instancedDynamicBufferAttribute(
      this.place,
      'vec4',
      4,
      0,
    ) as unknown as Node<'vec4'>;
    const shows = instancedDynamicBufferAttribute(
      this.shows,
      'vec4',
      4,
      0,
    ) as unknown as Node<'vec4'>;
    const corner = attribute('corner', 'vec2') as unknown as Node<'vec2'>;
    // The material factory's unlit kind: the glow is a place, and its
    // vertex node puts it on the dome itself.
    const m = basicMaterial();
    m.name = 'lanterns';
    m.transparent = true;
    m.depthWrite = false;
    m.blending = AdditiveBlending;
    const view = cameraViewMatrix.mul(vec4(bendScene(place.xyz), 1)).toVar();
    const dist = max(view.z.negate(), 0.5);
    const half = max(float(GLOW_SIZE / 2), dist.mul(this.perPixel).mul(LEAST_PIXELS / 2));
    m.vertexNode = cameraProjectionMatrix.mul(
      vec4(view.xy.add(corner.mul(half)), view.z.add(CLEAR), 1),
    );
    const vCorner = varying(corner);
    const vBearing = varying(place.w);
    const vShows = varying(shows);
    const vDim = varying(float(1).div(dist.div(140).add(1)));
    // Across the glow, the bearing runs from one side to the other: the
    // observer's right is toward the boat's port.
    const b = vBearing.sub(vCorner.x.mul(SPREAD));
    const h = ARC_FADE / 2;
    const side = (x: Node<'float'>): Node<'float'> =>
      smoothstep(-h, h, x).mul(float(1).sub(smoothstep(SIDELIGHT_ARC - h, SIDELIGHT_ARC + h, x)));
    const green = side(b).mul(vShows.y);
    const red = side(b.negate()).mul(vShows.x);
    const white = smoothstep(SIDELIGHT_ARC - h, SIDELIGHT_ARC + h, b.abs()).mul(vShows.z);
    const colour = vec3(...RED)
      .mul(red)
      .add(vec3(...GREEN).mul(green))
      .add(vec3(...WHITE).mul(white));
    const r2 = dot(vCorner, vCorner);
    const glow = exp(r2.mul(-4)).add(exp(r2.mul(-30)).mul(1.5));
    const strength = clamp(vShows.w.mul(vDim), 0, 1);
    m.fragmentNode = vec4(toLinear(colour).mul(glow.mul(strength)), 1) as unknown as Node<'vec4'>;

    this.mesh = new InstancedMesh(g, m, LANTERN_CAPACITY);
    this.mesh.name = 'lanterns';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  /**
   * The lantern of the boats drawn: where it is in the model (the lights'
   * node), the height of the centre of gravity the model turns about, and
   * the lights the catalog gives the boat.
   */
  setLantern(at: Vector3, centreOfGravity: number, lights: readonly Light[]): void {
    this.#at.copy(at);
    this.#cog = centreOfGravity;
    this.#lights = lights;
  }

  get ready(): boolean {
    return this.#lights.length > 0;
  }

  begin(): void {
    this.count = 0;
  }

  /**
   * Adds a boat's lantern: the boat's pose, its scene position (x, z, with
   * the floating origin taken off), the camera's scene position, and how
   * lit it is, 0 to 1, with its opacity.
   */
  add(p: LanternPose, x: number, z: number, camera: Vector3, lit: number): void {
    if (this.count >= LANTERN_CAPACITY || lit <= 0 || !this.ready) {
      return;
    }
    // The boat's turn: the heading, then the pitch and heel about the
    // centre of gravity, as the boat's model is placed.
    this.#q.setFromEuler(this.#e.set(0, headingToRotationY(p.heading), 0));
    this.#qHeel.setFromEuler(this.#e.set(p.pitch, 0, -p.heel));
    const at = this.#v.copy(this.#at);
    at.y -= this.#cog;
    at.applyQuaternion(this.#qHeel);
    at.y += this.#cog;
    at.applyQuaternion(this.#q);
    at.x += x;
    at.y += p.heave;
    at.z += z;
    // The camera seen from the lantern, in the boat's own frame: bow −z,
    // starboard +x.
    const c = this.#c.copy(camera).sub(at);
    c.applyQuaternion(this.#q.invert()).applyQuaternion(this.#qHeel.invert());
    const bearing = Math.atan2(c.x, -c.z) / DEG;
    const o = this.count * 4;
    const place = this.place.array as Float32Array;
    place[o] = at.x;
    place[o + 1] = at.y;
    place[o + 2] = at.z;
    place[o + 3] = bearing;
    const shows = this.shows.array as Float32Array;
    const all = this.#lights.includes('tricolour');
    shows[o] = all || this.#lights.includes('port') ? 1 : 0;
    shows[o + 1] = all || this.#lights.includes('starboard') ? 1 : 0;
    shows[o + 2] = all || this.#lights.includes('stern') ? 1 : 0;
    shows[o + 3] = lit;
    this.count++;
  }

  commit(fovY: number, height: number): void {
    this.perPixel.value = (2 * Math.tan((fovY * DEG) / 2)) / Math.max(height, 1);
    this.mesh.count = this.count;
    this.place.needsUpdate = true;
    this.shows.needsUpdate = true;
  }
}

/** How lit a lantern is with the sun this high at its boat, radians: through the sun's last degree. */
export function lanternLit(sunHeight: number): number {
  return Math.min(Math.max(1 - sunHeight / DEG, 0), 1);
}

function attr(): InstancedInterleavedBuffer {
  const b = new InstancedInterleavedBuffer(new Float32Array(LANTERN_CAPACITY * 4), 4, 1);
  b.setUsage(DynamicDrawUsage);
  return b;
}
