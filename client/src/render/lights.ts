// SPDX-License-Identifier: AGPL-3.0-only

// The lighthouses: their towers on their sites, their lights by night, and
// beyond a tower's horizon its light's loom. A tower is stone with an iron
// gallery, a glass lantern and a copper cupola, banded by its daymark so
// that towers are told apart by day as at sea, all of them one instanced
// draw. Its light shows its character by world time: each light's light
// and dark from its steps and phase (lights/character.ts), the same flash
// for every player; a flashing light's flash rises and falls as a turning
// lens's beam sweeps past, and near it two faint beams turn with the flash;
// an occulting or isophase light is cut sharply by its screen. The light is
// lit while the sun is below the horizon at the lighthouse, coming on
// through the sun's last degree, as the lanterns are at a boat.
//
// How bright a light is follows Allard's law, E = I T^d / d²: its intensity
// is the one that falls to the threshold at its nominal range in the clear
// air, and the glow drawn grows with E over the threshold; the mist band at
// the edge dims it by the mist along the ray. A light whose lantern is below
// the horizon, further than the eye's horizon and the lantern's together on
// the dome, shows as its loom: a glow on the horizon at the light's true
// bearing, flashing its character, as a loom may (IALA Dictionary: "the
// diffused glow observed from a light below the horizon"). Glows, looms and
// beams are one instanced draw, as the lanterns are another.

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedInterleavedBuffer,
  InstancedMesh,
  Matrix4,
  type Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
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
  mix,
  select,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { WorldLights } from '../catalog/types.gen';
import { type MistFrame, type MistParams, mistAlong } from '../edge/mist';
import {
  type Character,
  illuminance,
  intensity,
  level,
  sweep,
  transmissivity,
} from '../lights/character';
import type { LightSeen, PlaceSeen } from '../net/messages';
import { basicMaterial, bendScene, horizonDistance, litMaterial } from './materials';
import { toLinear } from './sky';

const DEG = Math.PI / 180;

/** The most lights, looms and beams drawn at once. */
export const LIGHT_CAPACITY = 128;
/** The most towers drawn. */
export const TOWER_CAPACITY = 64;

/** A tower's parts, as its vertices are tagged. */
const PART = { body: 0, band: 1, iron: 2, glass: 3, copper: 4 } as const;

/** How the glows' instances are drawn. */
const MODE = { glow: 0, loom: 1, beam: 2 } as const;

/** A colour for a light whose colour the catalog has not. */
const WHITE = [1, 1, 1] as const;

/** A beam's length and width, m. */
const BEAM_LENGTH = 420;
const BEAM_WIDTH = 7;

/**
 * A tower a metre high, its lantern's centre at the top, standing on the
 * ground at the origin: a tapering stone body in bands, an iron gallery, a
 * glass lantern and a copper cupola. Scaled by the tower's height.
 */
export function towerGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const tag = (g: BufferGeometry, part: number): BufferGeometry => {
    const n = g.getAttribute('position').count;
    g.setAttribute('part', new Float32BufferAttribute(new Float32Array(n).fill(part), 1));
    // Merged geometries share their attributes; uvs are not used.
    g.deleteAttribute('uv');
    return g;
  };
  // The body, from 0 to 0.9, in six bands, every other one the daymark's.
  const bands = 6;
  const bottom = 0.11;
  const top = 0.075;
  for (let k = 0; k < bands; k++) {
    const y0 = (0.9 * k) / bands;
    const y1 = (0.9 * (k + 1)) / bands;
    const r0 = bottom + (top - bottom) * (y0 / 0.9);
    const r1 = bottom + (top - bottom) * (y1 / 0.9);
    const g = new CylinderGeometry(r1, r0, y1 - y0, 14, 1, true);
    g.translate(0, (y0 + y1) / 2, 0);
    parts.push(tag(g, k % 2 === 1 ? PART.band : PART.body));
  }
  // The gallery and its rail.
  const gallery = new CylinderGeometry(0.115, 0.115, 0.014, 14);
  gallery.translate(0, 0.907, 0);
  parts.push(tag(gallery, PART.iron));
  const rail = new CylinderGeometry(0.112, 0.112, 0.03, 14, 1, true);
  rail.translate(0, 0.929, 0);
  parts.push(tag(rail, PART.iron));
  // The lantern, its centre at the top: where the light is.
  const glass = new CylinderGeometry(0.058, 0.058, 0.11, 12);
  glass.translate(0, 0.969, 0);
  parts.push(tag(glass, PART.glass));
  // The cupola and its ball.
  const cupola = new ConeGeometry(0.07, 0.07, 12);
  cupola.translate(0, 1.059, 0);
  parts.push(tag(cupola, PART.copper));
  const merged = mergeGeometries(parts);
  if (merged === null) {
    throw new Error('the tower’s parts would not merge');
  }
  return merged;
}

/** How lit a light is with the sun this high at the lighthouse, radians: through the sun's last degree. */
export function lightLit(sunHeight: number): number {
  return Math.min(Math.max(1 - sunHeight / DEG, 0), 1);
}

/** Whether a lantern this high, d metres off, stands above the horizon of an eye this high, on the dome. */
export function lanternSeen(d: number, eye: number, focal: number): boolean {
  return d < horizonDistance(eye) + horizonDistance(focal);
}

/** A glow's strength from its illuminance over the threshold: faint at its range, full ten times within. */
export function glowStrength(ratio: number): number {
  if (!(ratio > 0)) {
    return 0;
  }
  if (ratio < 1) {
    return 0.2 * ratio;
  }
  return Math.min(0.2 + Math.log10(ratio) / 2.5, 1);
}

/** A colour, #rrggbb, as linear values, for a lit material. */
function linear(hex: string): [number, number, number] {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
}

/** A colour, #rrggbb, as display values, which the glows' shader makes linear. */
function display(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** A light as the page keeps it. */
interface Held extends LightSeen {
  intensity: number;
  character: number;
  /** The sun's height at it, rad, and when it was last asked, ms. */
  sun: number;
  asked: number;
}

/** What a frame needs to draw the lights. */
export interface LightsFrame {
  /** The floating origin, m east and north. */
  origin: { x: number; y: number };
  /** The camera, a scene point. */
  camera: Vector3;
  /** World time, µs. */
  worldUs: number;
  /** Real time, ms: when to ask the sun again. */
  now: number;
  /** The sun's height at a place, rad, or null if the sky is not known. */
  sunAt: (east: number, north: number) => number | null;
  /** The mist band's numbers, and where the dome bends about. */
  mist: MistParams;
  dome: [number, number];
  /** The camera's field of view, degrees, and the canvas's height, CSS pixels. */
  fovY: number;
  height: number;
  /** Whether lights are drawn at all (the sky is drawn). */
  on: boolean;
}

export class Lighthouses {
  readonly towers: InstancedMesh;
  readonly glows: InstancedMesh;
  /** Each tower's daymark's band colour, and its lantern lit, 0 to 1. */
  readonly band = attr(TOWER_CAPACITY);
  /** Each glow: its scene position and mode; its colour and strength; a beam's direction and length. */
  readonly place = attr(LIGHT_CAPACITY);
  readonly shows = attr(LIGHT_CAPACITY);
  readonly beam = attr(LIGHT_CAPACITY);
  readonly perPixel = uniform(0.001);
  /** The lighthouses known, by place number, and the lights, by light number. */
  readonly sites = new Map<number, PlaceSeen>();
  readonly lights = new Map<number, Held>();
  count = 0;

  readonly #cat: WorldLights;
  readonly #lighthouse: number;
  readonly #air: number;
  readonly #m = new Matrix4();
  readonly #colours: Record<string, readonly number[]>;

  /** The catalog's lights, and the index of its kind of place that is a lighthouse. */
  constructor(cat: WorldLights, lighthouse: number) {
    this.#cat = cat;
    this.#lighthouse = lighthouse;
    this.#air = transmissivity(cat.clearAir);
    this.#colours = {
      white: display(cat.colours.white),
      red: display(cat.colours.red),
      green: display(cat.colours.green),
    };
    this.towers = this.#makeTowers();
    this.glows = this.#makeGlows();
  }

  #makeTowers(): InstancedMesh {
    const look = this.#cat.look;
    const band = instancedDynamicBufferAttribute(
      this.band,
      'vec4',
      4,
      0,
    ) as unknown as Node<'vec4'>;
    const part = attribute('part', 'float') as unknown as Node<'float'>;
    const vBand = varying(band);
    const vPart = varying(part);
    const body = vec3(...linear(look.daymarks[0]?.body ?? look.stone));
    const stone = vec3(...linear(look.stone));
    const iron = vec3(...linear(look.iron));
    const copper = vec3(...linear(look.copper));
    const glass = vec3(0.16, 0.18, 0.17);
    const m = litMaterial({ roughness: 0.85, metalness: 0 });
    m.name = 'lighthouse towers';
    const near = (p: number): Node<'bool'> => vPart.sub(p).abs().lessThan(0.5);
    const colour = select(
      near(PART.band),
      vBand.xyz,
      select(
        near(PART.iron),
        iron,
        select(near(PART.glass), glass, select(near(PART.copper), copper, mix(stone, body, 0.85))),
      ),
    );
    m.colorNode = colour as unknown as Node<'vec3'>;
    m.emissiveNode = select(
      near(PART.glass),
      vec3(1, 0.86, 0.6).mul(vBand.w.mul(2.2)),
      vec3(0, 0, 0),
    ) as unknown as Node<'vec3'>;
    const mesh = new InstancedMesh(towerGeometry(), m, TOWER_CAPACITY);
    mesh.name = 'lighthouse towers';
    mesh.count = 0;
    mesh.frustumCulled = false;
    // Hidden while there is nothing to draw, so that a world without
    // lighthouses never builds its shaders.
    mesh.visible = false;
    return mesh;
  }

  #makeGlows(): InstancedMesh {
    const corners = new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]);
    const g = new BufferGeometry();
    g.setAttribute('corner', new BufferAttribute(corners, 2));
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
    const beam = instancedDynamicBufferAttribute(
      this.beam,
      'vec4',
      4,
      0,
    ) as unknown as Node<'vec4'>;
    const corner = attribute('corner', 'vec2') as unknown as Node<'vec2'>;
    const look = this.#cat.look;
    const m = basicMaterial();
    m.name = 'lights';
    m.transparent = true;
    m.depthWrite = false;
    m.blending = AdditiveBlending;
    const mode = place.w;
    // A glow or a loom: a square facing the camera, a loom three times as
    // wide as it is high, never smaller on screen than the least.
    const view = cameraViewMatrix.mul(vec4(bendScene(place.xyz), 1)).toVar();
    const dist = max(view.z.negate(), 0.5);
    const isLoom = mode.sub(MODE.loom).abs().lessThan(0.5);
    const size = select(isLoom, float(look.glow * 6), float(look.glow));
    const half = max(size.mul(0.5), dist.mul(this.perPixel).mul(look.least / 2));
    const stretch = vec2(select(isLoom, float(3), float(1)), 1);
    const billboard = vec4(view.xy.add(corner.mul(stretch).mul(half)), view.z.add(1), 1);
    // A beam: a strip along the sea from the lantern, its width turned to
    // the camera.
    const along = corner.x.add(1).mul(0.5);
    const dir = vec3(beam.x, 0, beam.y);
    const across = vec3(beam.y.negate(), 0, beam.x);
    const strip = place.xyz
      .add(dir.mul(along.mul(beam.z)))
      .add(across.mul(corner.y.mul(BEAM_WIDTH / 2)));
    const stripView = cameraViewMatrix.mul(vec4(bendScene(strip), 1));
    const isBeam = mode.sub(MODE.beam).abs().lessThan(0.5);
    m.vertexNode = cameraProjectionMatrix.mul(select(isBeam, stripView, billboard));
    const vCorner = varying(corner);
    const vShows = varying(shows);
    const vBeam = varying(select(isBeam, float(1), float(0)));
    const vLoom = varying(select(isLoom, float(1), float(0)));
    const r2 = dot(vCorner, vCorner);
    const glow = exp(r2.mul(-4)).add(exp(r2.mul(-30)).mul(1.5));
    const loom = exp(
      vCorner.x
        .mul(vCorner.x)
        .mul(-2.5)
        .add(vCorner.y.add(0.6).max(0).mul(vCorner.y.add(0.6).max(0)).mul(-6)),
    );
    const t = vCorner.x.add(1).mul(0.5);
    const streak = float(1)
      .sub(t)
      .mul(float(1).sub(t))
      .mul(exp(vCorner.y.mul(vCorner.y).mul(-3)));
    const shape = mix(mix(glow, loom, vLoom), streak, vBeam);
    const strength = clamp(vShows.w, 0, 1);
    m.fragmentNode = vec4(
      toLinear(vShows.xyz).mul(shape.mul(strength)),
      1,
    ) as unknown as Node<'vec4'>;
    const mesh = new InstancedMesh(g, m, LIGHT_CAPACITY);
    mesh.name = 'lights';
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.visible = false;
    return mesh;
  }

  /** Places handed with their chunks: the lighthouses among them are kept. */
  setPlaces(places: readonly PlaceSeen[]): void {
    for (const p of places) {
      if (p.kind === this.#lighthouse) {
        this.sites.set(p.number, p);
      }
    }
  }

  /** Lights come into range, and lights to drop; 'all' drops every light first. */
  setLights(lights: readonly LightSeen[], drop: readonly number[] | 'all'): void {
    if (drop === 'all') {
      this.lights.clear();
    } else {
      for (const n of drop) {
        this.lights.delete(n);
      }
    }
    for (const l of lights) {
      const ch = this.#cat.characters[l.character];
      const range = l.range;
      this.lights.set(l.number, {
        ...l,
        intensity: intensity(range, this.#air, this.#cat.threshold),
        character: ch === undefined ? 0 : l.character,
        sun: 0,
        asked: Number.NEGATIVE_INFINITY,
      });
    }
  }

  /** Forgets every place and light: a new world. */
  clear(): void {
    this.sites.clear();
    this.lights.clear();
  }

  /** Places the towers and works out each light's glow, loom and beams for this frame. */
  frame(f: LightsFrame): void {
    const o = f.origin;
    const cam = f.camera;
    const eyeE = cam.x + o.x;
    const eyeN = -cam.z + o.y;
    const eyeH = Math.max(cam.y, 0.5);
    // The towers.
    let t = 0;
    const band = this.band.array as Float32Array;
    for (const p of this.sites.values()) {
      if (t >= TOWER_CAPACITY) {
        break;
      }
      const s = p.tower;
      this.#m.makeScale(s, s, s).setPosition(p.east - o.x, p.ground - 0.3, -(p.north - o.y));
      this.towers.setMatrixAt(t, this.#m);
      const dm = this.#cat.look.daymarks[p.daymark] ?? this.#cat.look.daymarks[0];
      const c = linear(dm?.band ?? this.#cat.look.stone);
      band[t * 4] = c[0];
      band[t * 4 + 1] = c[1];
      band[t * 4 + 2] = c[2];
      band[t * 4 + 3] = this.#lanternAt(p.east, p.north, f);
      t++;
    }
    this.towers.count = t;
    this.towers.visible = t > 0;
    this.towers.instanceMatrix.needsUpdate = true;
    this.band.needsUpdate = true;

    // The lights.
    this.count = 0;
    const look = this.#cat.look;
    const frame: MistFrame = { origin: [o.x, o.y], dome: f.dome };
    for (const l of this.lights.values()) {
      if (!f.on || this.count >= LIGHT_CAPACITY - 2) {
        break;
      }
      if (f.now - l.asked > 1000) {
        const h = f.sunAt(l.east, l.north);
        l.sun = h ?? 0;
        l.asked = f.now;
      }
      const lit = lightLit(l.sun);
      if (lit <= 0) {
        continue;
      }
      const ch = this.#cat.characters[l.character] as Character;
      const shown = level(ch, l.phase, f.worldUs, look.rise);
      const dx = l.east - eyeE;
      const dy = l.north - eyeN;
      const d = Math.max(Math.hypot(dx, dy), 1);
      const ratio = illuminance(l.intensity, d, this.#air) / this.#cat.threshold;
      const sx = l.east - o.x;
      const sz = -(l.north - o.y);
      const seen = lanternSeen(d, eyeH, l.focal);
      const colour = this.#colours[ch.colour] ?? WHITE;
      let strength = glowStrength(ratio) * shown * lit;
      if (seen) {
        strength *= Math.exp(
          -mistAlong([cam.x, cam.y, cam.z], [sx, l.focal, sz], frame, f.mist, 8),
        );
        this.#add(sx, l.focal, sz, MODE.glow, colour, strength, 0, 0, 0);
        // Two faint beams, turning with a flashing light's flash, seen near it.
        if (d < look.beams && (ch.class === 'Fl' || ch.class === 'LFl' || ch.class === 'Mo')) {
          const toEye = Math.atan2(-dx, -dy);
          const a = toEye + Math.PI * sweep(ch.steps, l.phase, f.worldUs);
          const fade = 0.14 * lit * (1 - d / look.beams);
          for (const b of [a, a + Math.PI]) {
            this.#add(
              sx,
              l.focal,
              sz,
              MODE.beam,
              colour,
              fade,
              Math.sin(b),
              -Math.cos(b),
              BEAM_LENGTH,
            );
          }
        }
      } else {
        // The loom: on the horizon at its true bearing, dimmed by the mist
        // as far as the horizon.
        const reach = Math.min(horizonDistance(eyeH) * 0.97, d);
        const hx = cam.x + (dx / d) * reach;
        const hz = cam.z - (dy / d) * reach;
        strength *=
          look.loom * Math.exp(-mistAlong([cam.x, cam.y, cam.z], [hx, 1, hz], frame, f.mist, 8));
        this.#add(hx, 2, hz, MODE.loom, colour, strength, 0, 0, 0);
      }
    }
    this.perPixel.value = (2 * Math.tan((f.fovY * DEG) / 2)) / Math.max(f.height, 1);
    this.glows.count = this.count;
    this.glows.visible = this.count > 0;
    this.place.needsUpdate = true;
    this.shows.needsUpdate = true;
    this.beam.needsUpdate = true;
  }

  /** How lit a tower's lantern is: its light's level if it is known, else lit by the sun alone. */
  #lanternAt(east: number, north: number, f: LightsFrame): number {
    for (const l of this.lights.values()) {
      if (Math.abs(l.east - east) < 1 && Math.abs(l.north - north) < 1) {
        const ch = this.#cat.characters[l.character] as Character;
        return lightLit(l.sun) * (0.35 + 0.65 * level(ch, l.phase, f.worldUs, this.#cat.look.rise));
      }
    }
    return 0;
  }

  #add(
    x: number,
    y: number,
    z: number,
    mode: number,
    colour: readonly number[],
    strength: number,
    bx: number,
    bz: number,
    length: number,
  ): void {
    if (!(strength > 0.001)) {
      return;
    }
    const i = this.count * 4;
    const p = this.place.array as Float32Array;
    p[i] = x;
    p[i + 1] = y;
    p[i + 2] = z;
    p[i + 3] = mode;
    const s = this.shows.array as Float32Array;
    s[i] = colour[0] ?? 1;
    s[i + 1] = colour[1] ?? 1;
    s[i + 2] = colour[2] ?? 1;
    s[i + 3] = strength;
    const b = this.beam.array as Float32Array;
    b[i] = bx;
    b[i + 1] = bz;
    b[i + 2] = length;
    b[i + 3] = 0;
    this.count++;
  }
}

function attr(n: number): InstancedInterleavedBuffer {
  const b = new InstancedInterleavedBuffer(new Float32Array(n * 4), 4, 1);
  b.setUsage(DynamicDrawUsage);
  return b;
}
