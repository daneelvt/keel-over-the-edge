// SPDX-License-Identifier: AGPL-3.0-only

// Many looks' textures as one: each look's atlas (or mask) a layer of an
// array texture, so the fleet draws every look's sailors in one draw with
// one material, each vertex reading its look's layer. The layers are the
// textures as the KTX2 loader transcoded them (compressed blocks, every
// mip level), copied side by side; every look's must be the same size and
// format, as the build makes them.
//
// An array texture cannot grow: a look added beyond its layers makes a new
// one, twice as deep, with the old layers copied in, and the old one is
// freed. It is never less than two deep: WebGPU's compatibility mode binds
// a texture of one layer as a plain 2D texture, not an array.

import {
  type ColorSpace,
  CompressedArrayTexture,
  type CompressedPixelFormat,
  type CompressedTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  type Texture,
  type TextureDataType,
} from 'three';

/** The bytes of one mip level of one layer. */
type Level = { data: Uint8Array; width: number; height: number };

const MIN_LAYERS = 2;

export class LayeredTexture {
  /** The array texture now: replaced when it grows. */
  texture: CompressedArrayTexture | null = null;
  /** What samples it (texture nodes), given the new texture when it grows. */
  readonly users: { value: Texture }[] = [];
  /** Each layer's mip levels, kept to copy into a deeper texture. */
  readonly #layers: Level[][] = [];
  #format: CompressedPixelFormat | null = null;
  #type: TextureDataType | null = null;
  #colorSpace: ColorSpace = NoColorSpace;
  #width = 0;
  #height = 0;
  /** Whether the texture now has been sent to the GPU whole. */
  #sent = false;

  constructor(readonly name: string) {}

  /** How many layers are filled. */
  get count(): number {
    return this.#layers.length;
  }

  /**
   * Adds a texture as the next layer and returns its index; the texture
   * itself is not drawn and may be freed. Returns -1 for one that does not
   * match the layers already here (its size or format).
   */
  add(t: Texture): number {
    const c = t as CompressedTexture;
    const mipmaps = (c.mipmaps ?? []) as unknown as Level[];
    const first = mipmaps[0];
    if (first === undefined) {
      return -1;
    }
    if (this.#format === null) {
      this.#format = c.format as CompressedPixelFormat;
      this.#type = c.type;
      this.#colorSpace = c.colorSpace as ColorSpace;
      this.#width = first.width;
      this.#height = first.height;
    } else if (
      c.format !== this.#format ||
      first.width !== this.#width ||
      first.height !== this.#height ||
      (this.#layers[0]?.length ?? 0) !== mipmaps.length
    ) {
      return -1;
    }
    this.#layers.push(
      mipmaps.map((m) => ({
        data: new Uint8Array(m.data.slice().buffer),
        width: m.width,
        height: m.height,
      })),
    );
    const layer = this.#layers.length - 1;
    const depth = this.texture?.image.depth ?? 0;
    if (layer < depth && this.texture !== null) {
      // Room for it: its bytes in place, and only its layer sent, once the
      // texture has been sent whole. Before, three.js would send the layers
      // named and leave the rest of a new texture empty (black): several
      // looks may load between two frames.
      this.#copy(this.texture, layer);
      if (this.#sent) {
        this.texture.addLayerUpdate(layer);
      }
      this.texture.needsUpdate = true;
    } else {
      this.#grow(Math.max(MIN_LAYERS, depth * 2, layer + 1));
    }
    return layer;
  }

  /** A new array texture this deep, holding every layer so far. */
  #grow(depth: number): void {
    const old = this.texture;
    const first = this.#layers[0] as Level[];
    const mipmaps = first.map((m) => ({
      data: new Uint8Array(m.data.byteLength * depth),
      width: m.width,
      height: m.height,
    }));
    const t = new CompressedArrayTexture(
      mipmaps as unknown as ImageData[],
      this.#width,
      this.#height,
      depth,
      this.#format as CompressedPixelFormat,
      this.#type ?? undefined,
    );
    t.name = this.name;
    t.colorSpace = this.#colorSpace;
    t.minFilter = mipmaps.length > 1 ? LinearMipmapLinearFilter : LinearFilter;
    t.magFilter = LinearFilter;
    t.generateMipmaps = false;
    for (let l = 0; l < this.#layers.length; l++) {
      this.#copy(t, l);
    }
    t.needsUpdate = true;
    this.#sent = false;
    t.onUpdate = () => {
      if (this.texture === t) {
        this.#sent = true;
      }
    };
    this.texture = t;
    for (const u of this.users) {
      u.value = t;
    }
    old?.dispose();
  }

  /** Copies a layer's bytes into a texture's mip levels. */
  #copy(t: CompressedArrayTexture, layer: number): void {
    const levels = this.#layers[layer] as Level[];
    const mipmaps = t.mipmaps as unknown as Level[];
    for (let i = 0; i < levels.length; i++) {
      const src = levels[i] as Level;
      (mipmaps[i] as Level).data.set(src.data, layer * src.data.byteLength);
    }
  }

  dispose(): void {
    this.texture?.dispose();
    this.texture = null;
  }
}
