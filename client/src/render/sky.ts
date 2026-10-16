// SPDX-License-Identifier: AGPL-3.0-only

// The sky, the sun, the moon and the haze. The sky is a sphere centred on
// the camera and drawn without depth: at infinity, since it is a direction
// and not a place, and so the one material without the dome's bend. Its
// gradient runs from the horizon's colour to the zenith's, with a glow at
// the horizon toward the sun, the sun's disc, the moon's disc lit on the
// side that faces the sun, and a few soft fair-weather clouds. Where the
// sun and moon stand is the rule's (the physics module's sky); their
// colours, and every other colour of the hour, are the light table's
// (daylight.ts), written here into the look each frame.
//
// The look's colours are display (sRGB-encoded) values, as an artist picks
// them; shaders that mix them convert their result to linear light at the
// end, and the output transform encodes it again.

import {
  BackSide,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  type Scene,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
} from 'three';
import {
  abs,
  cameraPosition,
  dot,
  exp,
  Fn,
  float,
  floor,
  fract,
  length,
  max,
  mix,
  normalize,
  positionLocal,
  pow,
  sin,
  smoothstep,
  sqrt,
  sRGBTransferEOTF,
  step,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { edgeLook, mistBetween } from '../edge/mist';
import { BODY, SKY } from '../predict/physics';
import {
  LIGHT_TABLE,
  type LightValues,
  type MainLight,
  MOON_COLOUR,
  mainLight,
  newLightValues,
  newMainLight,
  readLight,
} from './daylight';
import { sailGlowColour, skyMaterial } from './materials';

/** The sun at the table's day before the sky is first read: 30° up in the east. */
const START_SUN = new Vector3(Math.cos(Math.PI / 6), Math.sin(Math.PI / 6), 0);

/**
 * The moon's disc's radius, in radians: three times its real 0.26°, so
 * that its phase can be read on a phone.
 */
export const MOON_RADIUS = 0.75 * (Math.PI / 180);

/** The look of the hour, shared by the sky, the sea and the haze. */
export const look = {
  /** Toward the main light, the sun by day and the moon by night, in the scene's axes. */
  light: uniform(START_SUN.clone()),
  /** The main light's colour on the water, by its strength. */
  lightColour: uniform(new Color(1.0, 0.95, 0.85)),
  /** Toward the sun, its disc's colour, and how far its disc is above the horizon (0 to 1). */
  sun: uniform(START_SUN.clone()),
  sunColour: uniform(new Color(1.0, 0.95, 0.85)),
  sunUp: uniform(1),
  /** Toward the moon, how pale its disc is against the sky, and the glow about it. */
  moon: uniform(new Vector3(0, -1, 0)),
  moonDisc: uniform(0.3),
  moonHalo: uniform(0),
  skyTop: uniform(new Color(0.25, 0.48, 0.78)),
  skyHorizon: uniform(new Color(0.78, 0.86, 0.9)),
  /** The glow at the horizon toward the sun, by its strength. */
  glow: uniform(new Color(0, 0, 0)),
  cloud: uniform(new Color(0.97, 0.96, 0.93)),
  /** Deep water, and the light scattered through thin water. */
  deep: uniform(new Color(0.02, 0.16, 0.25)),
  scatter: uniform(new Color(0.07, 0.48, 0.5)),
  /** The main light's wide highlight on the water: its power and strength. */
  broad: uniform(new Vector3(14, 0.22, 0)),
  /** The sea blends toward the horizon's colour from here to there, in metres. */
  hazeNear: uniform(220),
  hazeFar: uniform(1000),
  /** The visual range solid things fade by, m (Koschmieder). */
  visualRange: uniform(6000),
  /** The faintest star that shows, as a magnitude. */
  starLimit: uniform(-3),
  /** The lanterns: 0 unlit, 1 lit. */
  lanterns: uniform(0),
};

/** Display (sRGB-encoded) values to linear light. */
export const toLinear = (c: Node): Node<'vec3'> => sRGBTransferEOTF(c) as Node<'vec3'>;

/** The sky's colour in a direction (display values). */
export const skyColour = /* @__PURE__ */ Fn(([d]: [Node<'vec3'>]) => {
  return mix(look.skyHorizon, look.skyTop, pow(max(d.y, 0), 0.55));
});

const hash2 = Fn(([p]: [Node<'vec2'>]) => fract(sin(dot(p, vec2(41.3, 289.1))).mul(43758.5453)));

/** Value noise, for the clouds. */
const valueNoise = Fn(([p]: [Node<'vec2'>]) => {
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(float(3).sub(f.mul(2)));
  const a = hash2(i);
  const b = hash2(i.add(vec2(1, 0)));
  const c = hash2(i.add(vec2(0, 1)));
  const d = hash2(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

/** How much of the sky a cloud covers in a direction, 0 to 1: the stars dim behind them too. */
export const cloudCover = /* @__PURE__ */ Fn(([d]: [Node<'vec3'>]) => {
  const cp = d.xz.div(max(d.y, 0.04)).mul(1.6);
  const cl = valueNoise(cp)
    .mul(0.6)
    .add(valueNoise(cp.mul(2.3).add(4)).mul(0.4));
  return smoothstep(0.62, 0.95, cl).mul(smoothstep(0, 0.12, d.y));
});

/** The sky's full colour in a direction: gradient, glow, sun, moon, clouds (display values). */
const skyFull = Fn(([dir]: [Node<'vec3'>]) => {
  const d = normalize(dir);
  const y = d.y;
  const c = skyColour(d).toVar();
  // The glow low in the sky toward the sun, at sunset, dusk and dawn.
  const level = vec3(d.x, 0, d.z);
  const sunLevel = vec3(look.sun.x, 0, look.sun.z);
  const toward = max(dot(level, sunLevel), 0).div(
    max(length(level), 1e-4).mul(max(length(sunLevel), 1e-4)),
  );
  c.addAssign(look.glow.mul(pow(toward, 3).mul(float(1).sub(smoothstep(0, 0.4, abs(y))))));
  // The sun's disc and glow, while it is up.
  const sd = max(dot(d, look.sun), 0);
  c.addAssign(
    look.sunColour.mul(
      pow(sd, 900).mul(5).add(pow(sd, 10).mul(0.28)).add(pow(sd, 3).mul(0.08)).mul(look.sunUp),
    ),
  );
  // The moon's disc, each point of it lit as the sun lights a sphere there:
  // the lit side faces the sun, and its share is the phase.
  const md = dot(d, look.moon);
  const q = d.sub(look.moon.mul(md)).div(Math.sin(MOON_RADIUS));
  const r2 = dot(q, q);
  const inside = float(1)
    .sub(smoothstep(0.88, 1, r2))
    .mul(step(0, md));
  const n = q.sub(look.moon.mul(sqrt(max(float(1).sub(r2), 0))));
  const lit = smoothstep(-0.06, 0.06, dot(n, look.sun));
  const face = mix(c.mul(0.9), vec3(...MOON_COLOUR).mul(1.15), lit.mul(look.moonDisc));
  c.assign(mix(c, face, inside));
  c.addAssign(vec3(...MOON_COLOUR).mul(pow(max(md, 0), 4000).mul(look.moonHalo)));
  c.assign(mix(c, look.cloud, cloudCover(d).mul(0.8)));
  return c;
});

/** Radius of the sky sphere, in metres: inside the camera's far plane. */
export const SKY_RADIUS = 3000;

/**
 * How far along a direction the sky's mist is taken, metres: by then the
 * dome has dropped the sea 200 m below a level ray, e^(−5) of the mist's
 * scale height.
 */
const SKY_MIST_REACH = 1000;

/** The sky as the module last gave it, in the scene's axes. */
export interface SkyNow {
  /** Toward the sun and the moon, scene axes. */
  sun: Vector3;
  moon: Vector3;
  /** Their true heights, in radians, and the moon's lit share. */
  sunHeight: number;
  moonHeight: number;
  lit: number;
}

/** A body of the module's sky record, east, north and up, into scene axes. */
export function bodyToScene(record: ArrayLike<number>, at: number, out: Vector3): Vector3 {
  return out.set(
    record[at + BODY.east] ?? 0,
    record[at + BODY.up] ?? 0,
    -(record[at + BODY.north] ?? 0),
  );
}

const DEG = Math.PI / 180;
const DAY_LIGHT = LIGHT_TABLE[0]?.sunLight ?? 1;

export class Sky {
  readonly mesh: Mesh;
  /** The main light: the sun by day, the moon by night. */
  readonly light: DirectionalLight;
  readonly hemisphere: HemisphereLight;
  /** The table read at the sun's height this frame, and the main light. */
  readonly values: LightValues = readLight(30, newLightValues());
  readonly main: MainLight = newMainLight();
  readonly now: SkyNow = {
    sun: START_SUN.clone(),
    moon: new Vector3(0, -1, 0),
    sunHeight: 30 * DEG,
    moonHeight: -Math.PI / 2,
    lit: 0,
  };
  /** Whether the sky follows the rule; until it does, the table's day at the start. */
  ruled = false;
  readonly #colour = new Color();

  constructor(scene: Scene) {
    const material = skyMaterial();
    material.side = BackSide;
    // The band's mist over the sky, along each direction out to where the
    // dome has lifted the ray clear of the mist's layer.
    const toward = normalize(positionLocal);
    const mist = mistBetween(cameraPosition, cameraPosition.add(toward.mul(SKY_MIST_REACH)));
    const seen = mix(edgeLook.colour, skyFull(positionLocal) as Node<'vec3'>, exp(mist.negate()));
    material.fragmentNode = vec4(toLinear(seen), 1);
    this.mesh = new Mesh(new SphereGeometry(SKY_RADIUS, 48, 24), material);
    this.mesh.name = 'sky';
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    this.light = new DirectionalLight(new Color().setRGB(1.0, 0.95, 0.85, SRGBColorSpace), 2.6);
    this.light.position.copy(look.light.value as Vector3).multiplyScalar(100);
    scene.add(this.light, this.light.target);
    this.hemisphere = new HemisphereLight(
      new Color().setRGB(0.78, 0.86, 0.9, SRGBColorSpace),
      new Color().setRGB(0.06, 0.25, 0.32, SRGBColorSpace),
      1.1,
    );
    scene.add(this.hemisphere);
    this.#apply();
  }

  /**
   * Takes the sky from the module's sky record, as the rule gives it at the
   * boat, and lights the scene by the hour.
   */
  read(record: ArrayLike<number>): void {
    const n = this.now;
    bodyToScene(record, SKY.sun, n.sun);
    bodyToScene(record, SKY.moon, n.moon);
    n.sunHeight = record[SKY.sun + BODY.altitude] ?? 0;
    n.moonHeight = record[SKY.moon + BODY.altitude] ?? 0;
    n.lit = record[SKY.lit] ?? 0;
    this.ruled = true;
    this.#apply();
  }

  #apply(): void {
    const n = this.now;
    const v = readLight(n.sunHeight / DEG, this.values);
    const m = mainLight(v, n.sunHeight, n.moonHeight, n.lit, this.main);
    (look.sun.value as Vector3).copy(n.sun);
    (look.moon.value as Vector3).copy(n.moon);
    (look.light.value as Vector3).copy(m.body === 'sun' ? n.sun : n.moon);
    // On the water the light's colour goes as the root of its strength,
    // so a moon lays a path and a setting sun a dimmer one.
    const shine = Math.sqrt(Math.min(m.strength / DAY_LIGHT, 1));
    rgb(look.lightColour, m.colour, shine);
    rgb(look.sunColour, v.sunColour, 1);
    look.sunUp.value = smooth(-0.6 * DEG, 0.3 * DEG, n.sunHeight);
    look.moonDisc.value = v.moonDisc;
    look.moonHalo.value = n.lit * Math.max(v.moonDisc - 0.3, 0) * 0.25;
    rgb(look.skyTop, v.skyTop, 1);
    rgb(look.skyHorizon, v.skyHorizon, 1);
    rgb(edgeLook.colour, v.mist, 1);
    rgb(look.glow, v.glow, v.glowStrength);
    rgb(look.cloud, v.cloud, 1);
    rgb(look.deep, v.deep, 1);
    rgb(look.scatter, v.scatter, 1);
    (look.broad.value as Vector3).set(v.broadPower, v.broadStrength, 0);
    look.hazeNear.value = v.hazeNear;
    look.hazeFar.value = v.hazeFar;
    look.visualRange.value = v.visualRange;
    // The sail's glow is a light, in linear values.
    const glow = this.#colour.setRGB(
      v.sailGlow[0] ?? 0,
      v.sailGlow[1] ?? 0,
      v.sailGlow[2] ?? 0,
      SRGBColorSpace,
    );
    (sailGlowColour.value as Vector3).set(glow.r, glow.g, glow.b);
    look.starLimit.value = v.starLimit;
    look.lanterns.value = v.lanterns;
    this.light.color.setRGB(m.colour[0] ?? 0, m.colour[1] ?? 0, m.colour[2] ?? 0, SRGBColorSpace);
    this.light.intensity = m.strength;
    this.hemisphere.color.setRGB(
      v.hemiSky[0] ?? 0,
      v.hemiSky[1] ?? 0,
      v.hemiSky[2] ?? 0,
      SRGBColorSpace,
    );
    this.hemisphere.groundColor.setRGB(
      v.hemiGround[0] ?? 0,
      v.hemiGround[1] ?? 0,
      v.hemiGround[2] ?? 0,
      SRGBColorSpace,
    );
    this.hemisphere.intensity = v.hemiLight;
  }

  /** Keeps the sky on the camera and the main light over the boat. */
  follow(camera: Vector3, boat: Vector3): void {
    this.mesh.position.copy(camera);
    this.light.target.position.copy(boat);
    this.light.position
      .copy(look.light.value as Vector3)
      .multiplyScalar(100)
      .add(boat);
  }
}

/** Writes a display colour, scaled, into a colour uniform: the look's colours stay display values. */
function rgb(u: { value: unknown }, c: number[], scale: number): void {
  (u.value as Color).setRGB((c[0] ?? 0) * scale, (c[1] ?? 0) * scale, (c[2] ?? 0) * scale);
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}
