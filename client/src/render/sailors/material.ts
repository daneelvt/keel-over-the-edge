// SPDX-License-Identifier: AGPL-3.0-only

// A sailor's material, from the factory, so it carries the dome's bend: in
// three.js r186 a skinned mesh's positionLocal is already skinned when the
// material's positionNode runs, so the bend takes the posed figure, and the
// shadow pass, which copies the node, casts it posed and bent too.
//
// A sailor's look is one atlas and its mask. The atlas holds the fixed
// parts in their colours and the parts a sailor chooses the colour of (the
// main colour, the skin, the hair) in a neutral grey, 0.5 in linear
// values, with their shading and painted variation; the mask says where
// each region is (red the main colour's, green the skin's, blue the hair's)
// and alpha where the sailor is metal. Each region takes the atlas times
// twice its colour, so a grey of 0.5 becomes the colour exactly, and every
// option is drawn from one texture. The colours are the object's own
// (userData main, skin and hair), so one material serves every sailor.
//
// Beyond the scene's lights:
// - skin is lit with a wrap past the terminator, the light carried round
//   the shadow's edge warm, as through skin, more on lighter tones, and its
//   highlight tighter on the deeper ones;
// - a rim of the sky's light on the side away from the main light holds the
//   silhouette against the sea;
// - metal reflects the sky above and the sea below, two colours by the
//   reflected ray's height: the game has no environment map, and metal reads
//   as metal only by what it reflects.
//
// A machine has no skin or hair: its "skin" region is its metal, coloured by
// its finish (the skin colour), and the mask's blue is where its lamps are,
// which glow in its hair colour (the lamps' light), as strong as its own
// glow (the object's userData glow, which pulses) and stronger at night;
// the glass's own colour in the atlas is how it looks unlit.

import {
  Color,
  type DirectionalLight,
  DoubleSide,
  type HemisphereLight,
  type Texture,
  Vector3,
} from 'three';
import {
  cameraPosition,
  dot,
  Fn,
  float,
  int,
  max,
  mix,
  normalize,
  normalWorld,
  positionWorld,
  pow,
  reflect,
  saturate,
  smoothstep,
  texture,
  uniform,
  userData,
  vec3,
  vec4,
} from 'three/tsl';
import type { MeshStandardNodeMaterial, Node } from 'three/webgpu';
import { litMaterial } from '../materials';

/**
 * The light a sailor is lit by besides the scene's lights, in linear values
 * times their strength: set once a frame by whoever draws sailors
 * (readSailorLight).
 */
export const sailorLight = {
  /** Toward the main light (the sun, or the moon at night), in the scene's axes. */
  toward: uniform(new Vector3(0, 1, 0)),
  /** The main light's colour. */
  main: uniform(new Color(1, 1, 1)),
  /** The sky's light: the hemisphere's colour from above. */
  sky: uniform(new Color(0.5, 0.6, 0.7)),
  /** What is seen below the horizon, the sea's. */
  sea: uniform(new Color(0.05, 0.1, 0.12)),
};

/** How far round the terminator light wraps on skin, as cos θ. */
const WRAP = 0.35;
/** The warm colour light carried round the terminator takes on skin. */
const WARM: [number, number, number] = [1, 0.42, 0.28];
/** The rim's strength, and how tight it is to the edge. */
const RIM = 0.6;
const RIM_POWER = 3;
/** The sea's brightness against the sky's, in what metal reflects. */
const SEA_SHARE = 0.25;
/** How much of the sky's and sea's own colour metal keeps in what it reflects. */
const METAL_HUE = 0.3;
/** A machine's lamps: their light by day, and how much more at night. */
const LAMP_DAY = 0.7;
const LAMP_NIGHT = 1.6;
/** The main light's brightness at and above which it is full day. */
const DAYLIGHT = 1.5;

/** Reads the light a sailor is lit by from the scene's main and hemisphere lights. */
export function readSailorLight(main: DirectionalLight, hemisphere: HemisphereLight): void {
  const toward = sailorLight.toward.value as Vector3;
  toward.copy(main.position).sub(main.target.position).normalize();
  (sailorLight.main.value as Color).copy(main.color).multiplyScalar(main.intensity);
  const sky = (sailorLight.sky.value as Color)
    .copy(hemisphere.color)
    .multiplyScalar(hemisphere.intensity);
  // The sea darker than the sky, in the hemisphere's ground colour.
  const sea = sailorLight.sea.value as Color;
  sea.copy(hemisphere.groundColor).multiplyScalar(hemisphere.intensity);
  const seaLum = luminance(sea);
  const want = SEA_SHARE * luminance(sky);
  if (seaLum > 0) {
    sea.multiplyScalar(want / seaLum);
  }
}

function luminance(c: Color): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

const lum = (c: Node<'vec3'>): Node<'float'> =>
  dot(c, vec3(0.2126, 0.7152, 0.0722)) as unknown as Node<'float'>;

/** The three colours a sailor's regions take, kept on each of its meshes' userData. */
export interface SailorColours {
  main: Color;
  skin: Color;
  hair: Color;
}

/** Colours from #RRGGBB, as a sailor's meshes keep them. */
export function sailorColours(main: string, skin: string, hair: string): SailorColours {
  return { main: new Color(main), skin: new Color(skin), hair: new Color(hair) };
}

/** What a sailor's material is made for besides its atlas and mask. */
export interface SailorMaterialOptions {
  /** Placed by this vertex node (the fleet's), else where its skin puts it. */
  vertex?: Node<'vec3'>;
  /** Where in the atlas and mask a fragment reads, else the geometry's uv (a figure read from a texture by its vertex node has none). */
  uv?: Node<'vec2'>;
  /** The fragment's normal in the world, where the vertex node reads it from elsewhere than the geometry; else the geometry's. */
  normal?: Node<'vec3'>;
  /** A machine's: its blue glows. */
  machine?: boolean;
  /** A machine's lamps' strength, 0 to 1 (the fleet's, which pulse together); else each object's userData glow. */
  glow?: Node<'float'>;
  /**
   * The fleet's: each instance's own colours, whether it is a machine (1) or
   * a person (0), and its look's layer of the atlas and mask, which are then
   * array textures. In place of the object's userData and machine.
   */
  instance?: {
    main: Node<'vec3'>;
    skin: Node<'vec3'>;
    hair: Node<'vec3'>;
    machine: Node<'float'>;
    layer: Node<'float'>;
    /** Told of the nodes that sample the atlas and the mask, to give them a new texture when it grows. */
    users: { atlas: { value: Texture }[]; mask: { value: Texture }[] };
  };
}

/**
 * A sailor's material: the atlas (sRGB) recoloured by its mask (data), the
 * colours read from each object's userData (SailorColours); placed by a
 * vertex node, if given (the fleet's), else where its skin puts it.
 */
export function sailorMaterial(
  atlas: Texture,
  mask: Texture,
  options: SailorMaterialOptions = {},
): MeshStandardNodeMaterial {
  const { vertex, instance } = options;
  // Garments are single surfaces, seen from inside at a cuff or a hem.
  const m = litMaterial({ roughness: 0.8, metalness: 0, side: DoubleSide }, vertex);
  m.name = 'sailor';
  let base = texture(atlas, options.uv);
  let regions = texture(mask, options.uv);
  if (instance !== undefined) {
    instance.users.atlas.push(base);
    instance.users.mask.push(regions);
    const layer = int(instance.layer.add(0.5));
    base = base.depth(layer);
    regions = regions.depth(layer);
  }
  const main = instance?.main ?? (userData('main', 'color') as unknown as Node<'vec3'>);
  const skin = instance?.skin ?? (userData('skin', 'color') as unknown as Node<'vec3'>);
  const hair = instance?.hair ?? (userData('hair', 'color') as unknown as Node<'vec3'>);
  // 1 for a machine, 0 for a person: the object's, or each instance's.
  const kind = instance?.machine ?? float(options.machine === true ? 1 : 0);
  const machine = instance !== undefined || options.machine === true;
  const person = float(1).sub(kind);
  // Each region's grey times twice its colour; 1 outside the regions. A
  // machine's blue is its lamps, kept in their own colour.
  const tint = vec3(1)
    .add(regions.r.mul(main.mul(2).sub(1)))
    .add(regions.g.mul(skin.mul(2).sub(1)))
    .add(regions.b.mul(hair.mul(2).sub(1)).mul(person));
  const albedo = base.rgb.mul(tint);
  const metal = regions.a;
  // A machine's "skin" is metal, and takes nothing of skin's light.
  const isSkin = regions.g.mul(person);
  m.colorNode = vec4(albedo, 1);
  m.metalnessNode = metal;
  // Cloth matte; skin's highlight tighter the deeper the tone; metal
  // smoother still.
  const skinRough = mix(float(0.62), float(0.46), saturate(float(1).sub(lum(skin).mul(2))));
  m.roughnessNode = mix(mix(float(0.82), skinRough, isSkin), float(0.35), metal);

  m.emissiveNode = Fn(() => {
    const n = normalize(options.normal ?? normalWorld);
    const v = normalize(cameraPosition.sub(positionWorld));
    const l = sailorLight.toward;
    const nl = dot(n, l);
    // Skin: the light the wrap adds past plain Lambert, warm. Lambert's
    // diffuse is albedo / π times the light.
    const wrapped = max(nl.add(WRAP).div(1 + WRAP), 0).sub(max(nl, 0));
    const warmth = mix(float(0.4), float(1), saturate(lum(skin).mul(3)));
    const warm = vec3(...WARM).mul(warmth);
    const scatter = albedo
      .mul(sailorLight.main)
      .mul(warm)
      .mul(wrapped.mul(isSkin).mul(1 / Math.PI));
    // The rim: the sky's light at the silhouette's edge away from the main light.
    const edge = pow(float(1).sub(saturate(dot(n, v))), RIM_POWER);
    const away = saturate(float(0.5).sub(nl.mul(0.5)));
    const rim = albedo.mul(sailorLight.sky).mul(edge.mul(away).mul(RIM / Math.PI));
    // Metal: the sky above and the sea below, in the reflected ray.
    const r = reflect(v.negate(), n);
    const seen = mix(sailorLight.sea, sailorLight.sky, smoothstep(-0.15, 0.25, r.y));
    // Mostly grey: a warm metal times a blue sky or a green sea turns olive.
    const grey = mix(vec3(lum(seen as unknown as Node<'vec3'>)), seen, METAL_HUE);
    const shine = albedo.mul(grey).mul(metal);
    if (!machine) {
      return scatter.add(rim).add(shine);
    }
    // The lamps, brighter as the day goes.
    const day = saturate(lum(sailorLight.main as unknown as Node<'vec3'>).div(DAYLIGHT));
    const strength = (options.glow ?? (userData('glow', 'float') as unknown as Node<'float'>)).mul(
      mix(float(LAMP_NIGHT), float(LAMP_DAY), day),
    );
    const lamp = hair.mul(regions.b).mul(strength).mul(kind);
    return scatter.add(rim).add(shine).add(lamp);
  })() as unknown as Node<'vec3'>;
  return m;
}
