// SPDX-License-Identifier: AGPL-3.0-only

// The daylight sky, the sun and the haze. The sky is a sphere centred on the
// camera and drawn without depth: at infinity, since it is a direction and
// not a place, and so the one material without the dome's bend. Its
// gradient runs from a pale horizon to a blue zenith, with the sun's disc
// and glow and a few soft fair-weather clouds. The sun is fixed in the
// afternoon until the day's cycle comes.
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
  dot,
  Fn,
  float,
  floor,
  fract,
  max,
  mix,
  normalize,
  positionLocal,
  pow,
  sin,
  smoothstep,
  sRGBTransferEOTF,
  uniform,
  vec2,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { skyMaterial } from './materials';

/** The sun's elevation and azimuth (clockwise from north), in radians. */
const SUN_ELEVATION = 0.85;
const SUN_AZIMUTH = 2.1;

function sunDirection(): Vector3 {
  const ce = Math.cos(SUN_ELEVATION);
  // Scene axes: x east, y up, z south.
  return new Vector3(
    ce * Math.sin(SUN_AZIMUTH),
    Math.sin(SUN_ELEVATION),
    -ce * Math.cos(SUN_AZIMUTH),
  ).normalize();
}

/** The look of a fair day, shared by the sky, the sea and the haze. */
export const look = {
  /** Toward the sun, in the scene's axes. */
  sun: uniform(sunDirection()),
  sunColour: uniform(new Color(1.0, 0.95, 0.85)),
  skyTop: uniform(new Color(0.25, 0.48, 0.78)),
  skyHorizon: uniform(new Color(0.78, 0.86, 0.9)),
  /** Deep water, and the light scattered through thin water. */
  deep: uniform(new Color(0.02, 0.16, 0.25)),
  scatter: uniform(new Color(0.07, 0.48, 0.5)),
  /** The sun's wide highlight on the water: its power and strength. */
  broad: uniform(new Vector3(14, 0.22, 0)),
  /** Everything blends toward the horizon's colour from here to there, in metres. */
  hazeNear: uniform(220),
  hazeFar: uniform(1000),
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

/** The sky's full colour in a direction: gradient, sun, clouds (display values). */
const skyFull = Fn(([dir]: [Node<'vec3'>]) => {
  const d = normalize(dir);
  const y = d.y;
  const c = skyColour(d).toVar();
  const sd = max(dot(d, look.sun), 0);
  c.addAssign(
    look.sunColour.mul(pow(sd, 900).mul(5).add(pow(sd, 10).mul(0.28)).add(pow(sd, 3).mul(0.08))),
  );
  const cp = d.xz.div(max(y, 0.04)).mul(1.6);
  const cl = valueNoise(cp)
    .mul(0.6)
    .add(valueNoise(cp.mul(2.3).add(4)).mul(0.4));
  const cover = smoothstep(0.62, 0.95, cl).mul(smoothstep(0, 0.12, y));
  c.assign(mix(c, vec4(0.97, 0.96, 0.93, 1).xyz.add(look.sunColour.mul(0.06)), cover.mul(0.8)));
  return c;
});

/** Radius of the sky sphere, in metres: inside the camera's far plane. */
export const SKY_RADIUS = 3000;

export class Sky {
  readonly mesh: Mesh;
  readonly sunLight: DirectionalLight;
  readonly hemisphere: HemisphereLight;

  constructor(scene: Scene) {
    const material = skyMaterial();
    material.side = BackSide;
    material.fragmentNode = vec4(toLinear(skyFull(positionLocal) as Node<'vec3'>), 1);
    this.mesh = new Mesh(new SphereGeometry(SKY_RADIUS, 48, 24), material);
    this.mesh.name = 'sky';
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    this.sunLight = new DirectionalLight(new Color().setRGB(1.0, 0.95, 0.85, SRGBColorSpace), 2.6);
    this.sunLight.position.copy(look.sun.value as Vector3).multiplyScalar(100);
    scene.add(this.sunLight, this.sunLight.target);
    this.hemisphere = new HemisphereLight(
      new Color().setRGB(0.78, 0.86, 0.9, SRGBColorSpace),
      new Color().setRGB(0.06, 0.25, 0.32, SRGBColorSpace),
      1.1,
    );
    scene.add(this.hemisphere);
  }

  /** Keeps the sky on the camera and the sun's light over the boat. */
  follow(camera: Vector3, boat: Vector3): void {
    this.mesh.position.copy(camera);
    this.sunLight.target.position.copy(boat);
    this.sunLight.position
      .copy(look.sun.value as Vector3)
      .multiplyScalar(100)
      .add(boat);
  }
}
