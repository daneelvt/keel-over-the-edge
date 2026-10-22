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
  type BufferAttribute,
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
  length,
  max,
  mix,
  normalize,
  positionLocal,
  pow,
  smoothstep,
  sqrt,
  sRGBTransferEOTF,
  step,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { edgeLook, mistTo } from '../edge/mist';
import { BODY, SKY } from '../predict/physics';
import { sheets, sheetsOver } from '../sky/sheets';
import {
  LIGHT_TABLE,
  type LightValues,
  luminance,
  type MainLight,
  MOON_COLOUR,
  mainLight,
  newLightValues,
  newMainLight,
  readLight,
} from './daylight';
import { airBetween, haloBetween } from './fog';
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
  /** The foam's and the falls' white. */
  cloud: uniform(new Color(0.97, 0.96, 0.93)),
  /** The clouds' lit tops and dark bases. */
  cloudTop: uniform(new Color(0.98, 0.98, 0.97)),
  cloudBase: uniform(new Color(0.55, 0.6, 0.66)),
  /** How overcast it is at the camera, 0 to 1: the light dimmed, the sky and the sea greyed. */
  overcast: uniform(0),
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

/** The sky's full colour in a direction: gradient, glow, sun, moon, sheet cloud (display values). */
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
  // The sun's glow, while it is up; its disc after the sheets, which hide it.
  const sd = max(dot(d, look.sun), 0);
  const overcast = float(1).sub(look.overcast.mul(0.8));
  c.addAssign(
    look.sunColour.mul(
      pow(sd, 10).mul(0.28).add(pow(sd, 3).mul(0.08)).mul(look.sunUp).mul(overcast),
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
  const s = sheetsOver(
    sheets,
    {
      top: look.cloudTop as unknown as Node<'vec3'>,
      base: look.cloudBase as unknown as Node<'vec3'>,
      horizon: look.skyHorizon as unknown as Node<'vec3'>,
    },
    d,
    c,
    look.sun,
    look.sunColour as unknown as Node<'vec3'>,
    look.sunUp,
  );
  c.assign(s.colour);
  c.addAssign(look.sunColour.mul(pow(sd, 900).mul(5).mul(look.sunUp).mul(s.disc)));
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

/**
 * The sky's sphere, its rings crowded toward the horizon: a ring at
 * elevation φ is moved to 90° (φ / 90°)², so the first lie a fraction of a
 * degree apart, where the mist, taken at the vertices, changes most.
 */
function skyGeometry(): SphereGeometry {
  const g = new SphereGeometry(SKY_RADIUS, 48, 40);
  const p = g.attributes.position as BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) / SKY_RADIUS;
    const across = Math.hypot(p.getX(i), p.getZ(i));
    const up = Math.asin(Math.min(Math.max(y, -1), 1));
    const moved = (Math.sign(up) * (up * up)) / (Math.PI / 2);
    const scale = across > 0 ? (SKY_RADIUS * Math.cos(moved)) / across : 0;
    p.setXYZ(i, p.getX(i) * scale, SKY_RADIUS * Math.sin(moved), p.getZ(i) * scale);
  }
  return g;
}

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
  /**
   * How overcast it is at the camera, 0 to 1 (the clouds' weather sets
   * it): the main light dims by up to 0.6, the sky's colours and the sea's
   * grey, and the sun's highlight on the water goes.
   */
  overcast = 0;
  /**
   * The visibility at the camera, m, as the physics module gives it from
   * the weather: Infinity while none is known. The sea's horizon blend is
   * held within it; the fog and the rain along each ray are the weather's
   * own optical depth (render/fog.ts).
   */
  cameraRange = Number.POSITIVE_INFINITY;
  readonly #colour = new Color();

  constructor(scene: Scene) {
    const material = skyMaterial();
    material.side = BackSide;
    // The band's mist over the sky, along each direction out to where the
    // dome has lifted the ray clear of the mist's layer: at the vertices;
    // and the weather's fog and rain, whose banks' edges are finer than the
    // sphere's vertices are apart, at each fragment, the sun's disc and the
    // sky hidden by the depth in their direction, white overhead in a
    // bank. A lit light in a bank lights the fog about it.
    const toward = normalize(positionLocal);
    const reach = cameraPosition.add(toward.mul(SKY_MIST_REACH));
    const depth = mistTo(reach).add(airBetween(cameraPosition, reach));
    const seen = mix(edgeLook.colour, skyFull(positionLocal) as Node<'vec3'>, exp(depth.negate()));
    material.fragmentNode = vec4(toLinear(seen).add(haloBetween(cameraPosition, reach)), 1);
    this.mesh = new Mesh(skyGeometry(), material);
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
    // Under overcast the sky greys toward its horizon's brightness, the
    // zenith a little darker, and the sea with it.
    const o = this.overcast;
    const grey = luminance(v.skyHorizon);
    look.overcast.value = o;
    greyed(look.skyTop, v.skyTop, grey * OVERCAST.top, OVERCAST.sky * o);
    greyed(look.skyHorizon, v.skyHorizon, grey * OVERCAST.horizon, OVERCAST.sky * o);
    greyed(edgeLook.colour, v.mist, luminance(v.mist) * OVERCAST.horizon, OVERCAST.sky * o);
    rgb(look.glow, v.glow, v.glowStrength * (1 - o));
    rgb(look.cloud, v.cloud, 1);
    rgb(look.cloudTop, v.cloudTop, 1 - OVERCAST.tops * o);
    rgb(look.cloudBase, v.cloudBase, 1 - OVERCAST.tops * o);
    greyed(look.deep, v.deep, luminance(v.deep), OVERCAST.sea * o);
    greyed(look.scatter, v.scatter, luminance(v.scatter), OVERCAST.sea * o);
    (look.broad.value as Vector3).set(v.broadPower, v.broadStrength * (1 - o), 0);
    // In fog or rain the sea's horizon blend shortens to the visibility at
    // the camera.
    const range = Math.min(v.visualRange, this.cameraRange);
    look.hazeNear.value = Math.min(v.hazeNear, 0.3 * range);
    look.hazeFar.value = Math.min(v.hazeFar, range);
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
    this.light.intensity = m.strength * (1 - OVERCAST.light * o);
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
    this.hemisphere.intensity = v.hemiLight * (1 + OVERCAST.hemisphere * o);
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

/**
 * What overcast does to the light, at its fullest: the main light dims by
 * light and the hemisphere's rises by hemisphere; the sky's colours go
 * toward grey by sky, its zenith to top and its horizon to horizon of the
 * horizon's brightness; the sea's colours toward grey by sea; the clouds'
 * own light dims by tops.
 */
const OVERCAST = {
  light: 0.6,
  hemisphere: 0.15,
  sky: 0.85,
  top: 0.78,
  horizon: 0.9,
  sea: 0.5,
  tops: 0.25,
};

/** Writes a display colour into a colour uniform, gone toward a grey of brightness g by share. */
function greyed(u: { value: unknown }, c: number[], g: number, share: number): void {
  const k = Math.min(Math.max(share, 0), 1);
  (u.value as Color).setRGB(
    (c[0] ?? 0) + (g - (c[0] ?? 0)) * k,
    (c[1] ?? 0) + (g - (c[1] ?? 0)) * k,
    (c[2] ?? 0) + (g - (c[2] ?? 0)) * k,
  );
}

/** Writes a display colour, scaled, into a colour uniform: the look's colours stay display values. */
function rgb(u: { value: unknown }, c: number[], scale: number): void {
  (u.value as Color).setRGB((c[0] ?? 0) * scale, (c[1] ?? 0) * scale, (c[2] ?? 0) * scale);
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}
