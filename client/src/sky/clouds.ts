// SPDX-License-Identifier: AGPL-3.0-only

// Heaped cloud: the weather systems' clouds and the fair-weather cumulus,
// "clusters of flattened, low-polygon puffs with white tops and grey bases".
// Every puff of every cloud is one instance of one mesh, an icosahedron of
// one subdivision, so the whole sky's heaped cloud is one draw. A cloud's
// puffs are laid out by its form's recipe (art/clouds), placed from its
// system's seed, so every phone draws the same cloud, and grown by its
// cloud strength: the base comes first, the tower rises, the anvil spreads
// last. They are opaque: the game draws with no MSAA, so there is no alpha
// to coverage to fade them, and a cloud grows rather than fading in.
//
// The puffs are laid out five times a second, each with its cloud's
// velocity, and the vertex shader carries it on between. Each fades toward
// the sky's colour in its direction by its distance, halfway at about 3 km
// in clear air and nearer in rain: a high cloud is seen through less of
// the low, hazy air than land on the horizon is, so the clouds take this
// haze and not the scene's.

import {
  DynamicDrawUsage,
  IcosahedronGeometry,
  InstancedInterleavedBuffer,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
  Vector4,
} from 'three';
import {
  cameraPosition,
  dot,
  exp,
  float,
  instancedDynamicBufferAttribute,
  max,
  mix,
  normalize,
  normalWorld,
  positionLocal,
  positionWorld,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import cumulonimbus from '../../../art/clouds/cumulonimbus.json';
import cumulus from '../../../art/clouds/cumulus.json';
import storm from '../../../art/clouds/storm.json';
import { edgeLook } from '../edge/mist';
import { RECORDS, SIZES } from '../predict/layout.gen';
import { FORMS } from '../predict/weather';
import { depthTo } from '../render/fog';
import { basicMaterial, bendScene } from '../render/materials';
import { look, skyColour, toLinear } from '../render/sky';

/** A layer of a recipe's puffs. */
export interface PuffLayer {
  name: string;
  count: number;
  /** box: along and across its track; disc: radius from and to; arc: its radius, and its angle either side, rad; spiral: its radius from and to, and its turns. */
  shape: 'box' | 'disc' | 'arc' | 'spiral';
  along: number[];
  across: number[];
  /** Shares of the cloud's height above its base as it stands now. */
  height: number[];
  /** Shares of the cloud's size. */
  radius: number[];
  /** Its height over its width, and how far it is stretched along its track. */
  flat: number;
  stretch: number;
  /** From its dark base (0) to its white top (1). */
  tone: number[];
  /** It grows as the cloud strength goes from the first to the second. */
  grow: number[];
}

/** A form's recipe of puffs. */
export interface Recipe {
  licence: string;
  description: string;
  layers: PuffLayer[];
}

/** The recipes, by the module's numbering of the forms. */
export const RECIPES: Readonly<Record<number, Recipe>> = {
  [FORMS.cumulus]: cumulus as Recipe,
  [FORMS.cumulonimbus]: cumulonimbus as Recipe,
  [FORMS.storm]: storm as Recipe,
};

/** A puff laid out: its centre from its cloud's, m east, north and up from the sea; its radius, flattening and stretch along the way it points, rad; its tone. */
export interface Puff {
  east: number;
  north: number;
  up: number;
  radius: number;
  flat: number;
  stretch: number;
  heading: number;
  tone: number;
}

/** A cloud as its puffs are laid out: its form, its seed, its size (the recipe's unit), base and height now, heading and cloud strength. */
export interface CloudShape {
  form: number;
  seed: number;
  unit: number;
  base: number;
  height: number;
  heading: number;
  strength: number;
}

/** A generator of numbers from 0 to 1 from a seed: the same on every page. */
function stream(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let h = s;
    h ^= h >>> 16;
    h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15;
    h = Math.imul(h, 0x846ca68b);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

const lerp = (r: number[], u: number): number =>
  (r[0] ?? 0) + ((r[1] ?? r[0] ?? 0) - (r[0] ?? 0)) * u;
const smooth = (x: number): number => {
  const t = Math.min(Math.max(x, 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * Lays a cloud's puffs out by its form's recipe into out, from its index
 * there on, and returns how many it laid: none of a layer not yet grown.
 */
export function layPuffs(c: CloudShape, out: Puff[], from: number, most: number): number {
  const recipe = RECIPES[c.form];
  if (recipe === undefined) {
    return 0;
  }
  const next = stream(c.seed);
  const sin = Math.sin(c.heading);
  const cos = Math.cos(c.heading);
  let n = 0;
  for (const layer of recipe.layers) {
    const g0 = layer.grow[0] ?? 0;
    const g1 = layer.grow[1] ?? 1;
    const grown = smooth((c.strength - g0) / Math.max(g1 - g0, 1e-6));
    for (let k = 0; k < layer.count; k++) {
      // Every puff draws its numbers whether it shows or not, so each
      // keeps its place as the cloud grows.
      const r = [next(), next(), next(), next(), next(), next()] as const;
      if (grown <= 0 || from + n >= most) {
        continue;
      }
      let along = 0;
      let across = 0;
      let turn = 0;
      const t = layer.count > 1 ? k / (layer.count - 1) : 0.5;
      switch (layer.shape) {
        case 'disc': {
          const d = lerp(layer.along, Math.sqrt(r[0]));
          const a = 2 * Math.PI * r[1];
          along = d * Math.cos(a);
          across = d * Math.sin(a);
          break;
        }
        case 'arc': {
          const a = lerp(layer.across, t) + (r[1] - 0.5) * 0.15;
          along = (layer.along[0] ?? 0) * Math.cos(a);
          across = (layer.along[0] ?? 0) * Math.sin(a);
          turn = a + Math.PI / 2;
          break;
        }
        case 'spiral': {
          const d = lerp(layer.along, t);
          const a = 2 * Math.PI * (layer.across[0] ?? 1) * t + (r[1] - 0.5) * 0.5;
          along = d * Math.cos(a);
          across = d * Math.sin(a);
          break;
        }
        default:
          along = lerp(layer.along, r[0]);
          across = lerp(layer.across, r[1]);
      }
      const p = out[from + n] as Puff;
      along *= c.unit;
      across *= c.unit;
      // Ahead along the way it moves, (sin, cos); across to its right, (cos, −sin).
      p.east = along * sin + across * cos;
      p.north = along * cos - across * sin;
      p.up = c.base + lerp(layer.height, r[2]) * c.height;
      p.radius = lerp(layer.radius, r[3]) * c.unit * grown;
      p.flat = layer.flat;
      p.stretch = layer.stretch;
      p.heading = c.heading + turn;
      p.tone = lerp(layer.tone, r[4]);
      n++;
    }
  }
  return n;
}

/** How far the clouds' haze reaches: halfway at this distance in clear air, m. */
export const HAZE_HALF = 3000;

/** The puffs drawn at most, on the high tier. */
export const PUFF_MOST = 1024;

/** The fair-weather cumulus are drawn within this of the camera, m. */
export const CUMULUS_REACH = 3500;

/** A cloud ready to be laid out: its shape, where it is, how fast it drifts, how dark its base, and how far from the camera. */
interface Placed extends CloudShape {
  east: number;
  north: number;
  velEast: number;
  velNorth: number;
  dark: number;
  away: number;
}

export class Clouds {
  readonly mesh: InstancedMesh;
  /** The puffs' anchor from the floating origin (scene axes), the seconds since they were laid out, and the haze's scale, m. */
  readonly anchor = uniform(new Vector3());
  readonly since = uniform(0);
  readonly hazeScale = uniform(HAZE_HALF / Math.LN2);
  /** A flash lighting its cloud from within: where, scene axes, and how bright; and how far it lights, m. */
  readonly flash = uniform(new Vector4(0, 0, 0, 0));
  readonly flashReach = uniform(900);
  /** How many puffs the quality in use draws at most. */
  capacity = PUFF_MOST;
  /** The puffs laid out last, and how many of them are the systems' clouds'. */
  count = 0;
  heaped = 0;
  /** The clouds laid out last, for the panel and the tests: each its form, its slot or −1, its centre, top and puffs. */
  readonly shown: {
    form: number;
    slot: number;
    east: number;
    north: number;
    top: number;
    puffs: number;
  }[] = [];
  /** Where the puffs were laid out from: the anchor in the world, m. */
  anchorEast = 0;
  anchorNorth = 0;

  readonly #shade: InstancedInterleavedBuffer;
  readonly #puffs: Puff[] = [];
  readonly #placed: Placed[] = [];
  readonly #m = new Matrix4();
  readonly #q = new Quaternion();
  readonly #p = new Vector3();
  readonly #s = new Vector3();
  readonly #up = new Vector3(0, 1, 0);

  constructor() {
    for (let i = 0; i < PUFF_MOST; i++) {
      this.#puffs.push({
        east: 0,
        north: 0,
        up: 0,
        radius: 0,
        flat: 1,
        stretch: 1,
        heading: 0,
        tone: 0,
      });
    }
    this.#shade = new InstancedInterleavedBuffer(new Float32Array(PUFF_MOST * 4), 4, 1);
    this.#shade.setUsage(DynamicDrawUsage);
    const shade = instancedDynamicBufferAttribute(
      this.#shade,
      'vec4',
      4,
      0,
    ) as unknown as Node<'vec4'>;
    // Carried on its drift since it was laid out: shade.zw is its velocity
    // in the scene's x and z, m/s.
    const moved = positionLocal
      .add(this.anchor)
      .add(vec3(shade.z, 0, shade.w).mul(this.since)) as unknown as Node<'vec3'>;
    const m = basicMaterial({ fog: false }, moved);
    m.name = 'clouds';
    // Lambert from the main light, the top lit and the base dark, the dark
    // base darker by its cloud's darkness.
    const n = normalize(normalWorld);
    const lambert = max(dot(n, look.light), 0);
    const base = mix(look.cloudBase, look.cloudBase.mul(0.55), shade.y);
    const tone = mix(base, look.cloudTop, shade.x);
    const lit = tone
      .mul(float(0.72).add(lambert.mul(0.22)).add(n.y.mul(0.08)))
      // A flash within lights the puffs about it, the nearer the brighter.
      .add(
        vec3(0.85, 0.88, 1.1).mul(
          this.flash.w.mul(
            exp(
              positionWorld
                .sub(bendScene(this.flash.xyz))
                .length()
                .div(this.flashReach)
                .pow(2)
                .negate(),
            ),
          ),
        ),
      );
    // Its haze, toward the sky's colour in its direction, then the mist of
    // the band at the world's edge.
    const toward = positionWorld.sub(cameraPosition);
    const hazed = mix(
      lit,
      skyColour(normalize(toward)) as Node<'vec3'>,
      float(1)
        .sub(exp(toward.length().div(this.hazeScale).negate()))
        .mul(0.96),
    );
    const seen = mix(hazed, edgeLook.colour, float(1).sub(exp(depthTo(positionWorld).negate())));
    m.colorNode = vec4(toLinear(seen), 1) as unknown as Node<'vec4'>;
    this.mesh = new InstancedMesh(new IcosahedronGeometry(1, 1), m, PUFF_MOST);
    this.mesh.name = 'clouds';
    this.mesh.count = 0;
    // Its puffs are anywhere within kilometres: a stale bounding sphere
    // must never cull them.
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
  }

  /**
   * Lays the puffs out again: from the module's cloud records (heaped) and
   * cumulus records (fair), nearest the camera first, the heaped before the
   * fair, as many as the capacity holds. They are anchored at (east,
   * north), the camera, and placed in the scene by the anchor uniform.
   */
  lay(heaped: Float64Array, fair: Float64Array, cameraEast: number, cameraNorth: number): void {
    const C = RECORDS.cloud;
    const U = RECORDS.cumulus;
    const placed = this.#placed;
    placed.length = 0;
    const at = (k: number): Placed => {
      let p = this.#pool[k];
      if (p === undefined) {
        p = {
          form: 0,
          seed: 0,
          unit: 0,
          base: 0,
          height: 0,
          heading: 0,
          strength: 0,
          east: 0,
          north: 0,
          velEast: 0,
          velNorth: 0,
          dark: 0,
          away: 0,
        };
        this.#pool[k] = p;
      }
      return p;
    };
    const nh = Math.floor(heaped.length / SIZES.cloud);
    for (let i = 0; i < nh; i++) {
      const o = i * SIZES.cloud;
      const p = at(placed.length);
      p.form = heaped[o + C.form] ?? 0;
      p.seed = heaped[o + C.seed] ?? 0;
      p.unit = heaped[o + C.size] ?? 0;
      p.base = heaped[o + C.base] ?? 0;
      p.height = (heaped[o + C.top] ?? 0) - p.base;
      p.heading = heaped[o + C.heading] ?? 0;
      p.strength = heaped[o + C.cloud] ?? 0;
      p.east = heaped[o + C.east] ?? 0;
      p.north = heaped[o + C.north] ?? 0;
      const speed = heaped[o + C.speed] ?? 0;
      p.velEast = speed * Math.sin(p.heading);
      p.velNorth = speed * Math.cos(p.heading);
      p.dark = heaped[o + C.dark] ?? 0;
      p.away = Math.hypot(p.east - cameraEast, p.north - cameraNorth) - p.unit;
      placed.push(p);
    }
    placed.sort((a, b) => a.away - b.away);
    const heapedCount = placed.length;
    const nf = Math.floor(fair.length / SIZES.cumulus);
    for (let i = 0; i < nf; i++) {
      const o = i * SIZES.cumulus;
      const grow = fair[o + U.grow] ?? 0;
      if (grow <= 0.01) {
        continue;
      }
      const p = at(placed.length);
      p.form = FORMS.cumulus;
      p.seed = fair[o + U.seed] ?? 0;
      p.unit = (fair[o + U.radius] ?? 0) * (0.4 + 0.6 * grow);
      p.base = fair[o + U.base] ?? 0;
      p.height = ((fair[o + U.top] ?? 0) - p.base) * grow;
      p.velEast = fair[o + U.velEast] ?? 0;
      p.velNorth = fair[o + U.velNorth] ?? 0;
      p.heading = Math.atan2(p.velEast, p.velNorth);
      p.strength = grow;
      p.east = fair[o + U.east] ?? 0;
      p.north = fair[o + U.north] ?? 0;
      p.dark = 0.2;
      p.away = Math.hypot(p.east - cameraEast, p.north - cameraNorth);
      placed.push(p);
    }
    const fairSorted = placed.slice(heapedCount).sort((a, b) => a.away - b.away);
    for (let i = 0; i < fairSorted.length; i++) {
      placed[heapedCount + i] = fairSorted[i] as Placed;
    }

    this.anchorEast = cameraEast;
    this.anchorNorth = cameraNorth;
    const most = Math.min(this.capacity, PUFF_MOST);
    const shade = this.#shade.array as Float32Array;
    const shown = this.shown;
    shown.length = 0;
    let n = 0;
    this.heaped = 0;
    for (let c = 0; c < placed.length && n < most; c++) {
      const p = placed[c] as Placed;
      const laid = layPuffs(p, this.#puffs, n, most);
      for (let k = n; k < n + laid; k++) {
        const f = this.#puffs[k] as Puff;
        // Scene axes: x east, y up, z south; the puff's own x along the
        // way it points.
        this.#p.set(p.east + f.east - cameraEast, f.up, -(p.north + f.north - cameraNorth));
        this.#q.setFromAxisAngle(this.#up, Math.PI / 2 - f.heading);
        this.#s.set(f.radius * f.stretch, f.radius * f.flat, f.radius);
        this.mesh.setMatrixAt(k, this.#m.compose(this.#p, this.#q, this.#s));
        shade[4 * k] = f.tone;
        shade[4 * k + 1] = p.dark;
        shade[4 * k + 2] = p.velEast;
        shade[4 * k + 3] = -p.velNorth;
      }
      shown.push({
        form: p.form,
        slot: c < heapedCount ? c : -1,
        east: p.east,
        north: p.north,
        top: p.base + p.height,
        puffs: laid,
      });
      n += laid;
      if (c < heapedCount) {
        this.heaped = n;
      }
    }
    this.count = n;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.#shade.needsUpdate = true;
  }

  /** Places the puffs for a frame: the anchor from the floating origin, and the seconds since they were laid out. */
  frame(originEast: number, originNorth: number, since: number): void {
    this.anchor.value.set(this.anchorEast - originEast, 0, -(this.anchorNorth - originNorth));
    this.since.value = since;
  }

  readonly #pool: Placed[] = [];
}
