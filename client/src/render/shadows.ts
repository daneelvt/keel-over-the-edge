// SPDX-License-Identifier: AGPL-3.0-only

// Shadows: one shadow map of the sun's, round the player's boat. The boat
// and its sailor cast shadows on themselves and each other: the sail's on
// the deck is what the eye misses without them. On the high tier, the other
// boats within its box cast and receive too. The sea receives none: it is
// the largest surface on screen and does its own lighting, so a shadow
// lookup there would cost the most and show the least. Every caster is
// drawn into the map by its own vertex node, so the dome's bend and the
// sail's shape are in its shadow.
//
// three.js draws a shadow map into a render target with a colour texture
// beside its depth texture, RGBA at 8 bits by default, which nothing reads.
// It is made red alone here, so a texel of the map costs 5 bytes, not 8.
//
// Whether the light casts at all changes every lit material's shader and
// the shadow pass's own, so it is fixed for a ladder: on wherever the ladder
// has shadows on any tier. Down the ladder, shadows go off by the boats no
// longer casting: the map is drawn once, empty, and then left alone, which
// saves its pass and changes no shader.
//
// The map is read as three.js's PCF filter reads it, five samples on a
// Vogel disk turned by interleaved gradient noise, but with the map's size
// and the filter's radius read from one uniform each for every material.
// three.js's own filter makes them afresh for every shader it builds, so
// every object's render group then holds uniforms of its own, can share its
// buffer with no other, and is written for each object every frame.

import {
  type DirectionalLight,
  type LightShadow,
  type Object3D,
  RedFormat,
  UnsignedByteType,
} from 'three';
import {
  add,
  Fn,
  interleavedGradientNoise,
  reference,
  renderGroup,
  screenCoordinate,
  texture,
  vec2,
  vogelDiskSample,
} from 'three/tsl';
import type { Node, WebGPURenderer } from 'three/webgpu';
import type { Tier } from './quality';

/** What a shadow filter is given (ShadowNode's setupShadowFilter). */
interface FilterInputs {
  depthTexture: { isArrayTexture?: boolean };
  shadowCoord: Node<'vec3'>;
  depthLayer: Node<'int'>;
}

/** three.js's PCF filter, its size and radius one uniform each for every shader that reads the map. */
export function sharedPCF(shadow: LightShadow): unknown {
  // biome-ignore lint/suspicious/noExplicitAny: a reference's setGroup, untyped
  const grouped = (n: any): any => n.setGroup(renderGroup);
  const mapSize = grouped(reference('mapSize', 'vec2', shadow)) as Node<'vec2'>;
  const radius = grouped(reference('radius', 'float', shadow)) as Node<'float'>;
  return Fn((inputs: Record<string, unknown>) => {
    const { depthTexture, shadowCoord, depthLayer } = inputs as unknown as FilterInputs;
    const compare = (uv: Node<'vec2'>, z: Node<'float'>): Node<'float'> => {
      // biome-ignore lint/suspicious/noExplicitAny: three.js's depth texture node
      let depth: any = texture(depthTexture as any, uv);
      if (depthTexture.isArrayTexture === true) {
        depth = depth.depth(depthLayer);
      }
      return depth.compare(z);
    };
    const texelSize = vec2(1).div(mapSize);
    const radiusScaled = radius.mul(texelSize.x);
    const phi = interleavedGradientNoise(screenCoordinate.xy).mul(6.28318530718);
    const at = (i: number): Node<'float'> =>
      compare(
        shadowCoord.xy.add(
          vogelDiskSample(i as unknown as Node, 5 as unknown as Node, phi).mul(radiusScaled),
        ) as unknown as Node<'vec2'>,
        shadowCoord.z as unknown as Node<'float'>,
      );
    return add(at(0), at(1), at(2), at(3), at(4)).mul(1 / 5);
  });
}

/** The shadow camera's depth, about the sun's light, in metres. */
const NEAR = 1;
const FAR = 220;

export class Shadows {
  readonly light: DirectionalLight;
  /** Whether the boats cast into the map, its side in texels, its box in metres, and whether other boats are in it. */
  on = false;
  /** Whether the light casts: whether the ladder has a map anywhere. */
  lit = false;
  size = 0;
  box = 0;
  fleet = false;
  /** How much larger the boat is than the one the tiers' boxes are for: the box grows with it. */
  scale = 1;

  constructor(light: DirectionalLight) {
    this.light = light;
    const s = light.shadow;
    s.bias = -0.0004;
    s.normalBias = 0.02;
    (s as unknown as { filterNode: unknown }).filterNode = sharedPCF(s);
    s.camera.near = NEAR;
    s.camera.far = FAR;
    // three.js makes the map's render target and assigns it here before
    // anything is drawn into it: its colour target is made one byte a texel
    // then, before a pipeline is made for it.
    let map: typeof s.map = null;
    Object.defineProperty(s, 'map', {
      configurable: true,
      get: () => map,
      set: (m: typeof s.map) => {
        map = m;
        if (m !== null) {
          m.texture.format = RedFormat;
          m.texture.type = UnsignedByteType;
        }
      },
    });
  }

  /** A new renderer: shadows are drawn whenever a light casts them. */
  attached(renderer: WebGPURenderer): void {
    renderer.shadowMap.enabled = true;
  }

  /**
   * The tier's map, and whether the rung has the boats cast into it. lit is
   * whether the light casts at all: for the whole of a ladder that has
   * shadows anywhere, so that no step down or up it changes a lit shader or
   * the shadow pass's own; below the tiers with a map the boats simply cast
   * nothing into it. The light's own casting is the caller's to change, as
   * lit (it changes shaders, which want compiling first).
   */
  set(tier: Tier, shadows: boolean, lit: boolean): void {
    this.lit = lit;
    const on = lit && shadows && tier.shadowMap > 0;
    this.on = on;
    this.fleet = on && tier.shadowFleet;
    const s = this.light.shadow;
    // Off, the map is drawn once more, with nothing casting, and then kept.
    s.autoUpdate = on;
    s.needsUpdate = true;
    if (!on) {
      return;
    }
    if (this.size !== tier.shadowMap) {
      this.size = tier.shadowMap;
      s.mapSize.set(tier.shadowMap, tier.shadowMap);
      // A new size needs a new map.
      s.map?.dispose();
      s.map = null;
    }
    const box = tier.shadowBox * this.scale;
    if (this.box !== box) {
      this.box = box;
      const c = s.camera;
      c.left = -box / 2;
      c.right = box / 2;
      c.top = box / 2;
      c.bottom = -box / 2;
      c.updateProjectionMatrix();
    }
  }

  /** Makes every mesh under root cast the sun's shadow or not, and receive it or not. */
  static cast(root: Object3D, cast: boolean, receive: boolean): void {
    root.traverse((o) => {
      o.castShadow = cast;
      o.receiveShadow = receive;
    });
  }
}
