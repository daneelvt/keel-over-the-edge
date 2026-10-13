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
// Whether the light casts at all changes every lit material's shader, so it
// changes only with the tier. Within a tier, shadows go off by the boats no
// longer casting: the map is drawn once, empty, and then left alone, which
// saves its pass and changes no shader.

import { type DirectionalLight, type Object3D, RedFormat, UnsignedByteType } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import type { Tier } from './quality';

/** The shadow camera's depth, about the sun's light, in metres. */
const NEAR = 1;
const FAR = 220;

export class Shadows {
  readonly light: DirectionalLight;
  /** Whether the boats cast into the map, its side in texels, its box in metres, and whether other boats are in it. */
  on = false;
  /** Whether the light casts: whether the tier has a map at all. */
  lit = false;
  size = 0;
  box = 0;
  fleet = false;

  constructor(light: DirectionalLight) {
    this.light = light;
    const s = light.shadow;
    s.bias = -0.0004;
    s.normalBias = 0.02;
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
   * The tier's map, and whether the rung has the boats cast into it. The
   * light's own casting is the caller's to change, as lit (it changes
   * shaders, which want compiling first).
   */
  set(tier: Tier, shadows: boolean): void {
    this.lit = tier.shadowMap > 0;
    const on = shadows && this.lit;
    this.on = on;
    this.fleet = this.lit && tier.shadowFleet;
    const s = this.light.shadow;
    // Off, the map is drawn once more, with nothing casting, and then kept.
    s.autoUpdate = on;
    s.needsUpdate = true;
    if (!this.lit) {
      return;
    }
    if (this.size !== tier.shadowMap) {
      this.size = tier.shadowMap;
      s.mapSize.set(tier.shadowMap, tier.shadowMap);
      // A new size needs a new map.
      s.map?.dispose();
      s.map = null;
    }
    if (this.box !== tier.shadowBox) {
      this.box = tier.shadowBox;
      const c = s.camera;
      c.left = -tier.shadowBox / 2;
      c.right = tier.shadowBox / 2;
      c.top = tier.shadowBox / 2;
      c.bottom = -tier.shadowBox / 2;
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
