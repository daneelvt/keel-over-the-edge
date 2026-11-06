// SPDX-License-Identifier: AGPL-3.0-only

// A sailor's portrait in any options, drawn from two pictures the sailors'
// build makes for each look and version (art/sailors/<look>/): the base,
// shaded, with the parts a sailor chooses the colour of in a neutral grey
// (0.5 in linear light), transparent round the figure; and its mask, whose
// red is each pixel's share of the main colour's part, green the skin's (a
// machine's metal, its finish) and blue the hair's. Each share takes the
// base times twice its colour, in linear light, as the sailor's material
// does on the boat: so a grey of 0.5 becomes the colour exactly, the
// shading and painted variation kept. Drawn by script into a canvas, with
// no three.js, so any page may show it within its content security policy.

/** The three colours a portrait takes, as #RRGGBB; a machine has no hair. */
export interface PortraitColours {
  main: string;
  skin: string;
  hair?: string;
}

/** A look and version's pictures, by URL: the base (AVIF, and WebP for browsers without it) and the mask. */
export interface PortraitFiles {
  base: string;
  fallback: string;
  mask: string;
}

/** A portrait's pixels, loaded: RGBA bytes, rows from the top. */
export interface Portrait {
  width: number;
  height: number;
  base: Uint8ClampedArray;
  mask: Uint8ClampedArray;
}

/** sRGB bytes to linear light. */
const DECODE = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  DECODE[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Linear light, in this many steps from 0 to 1, to sRGB bytes. */
const STEPS = 4096;
const ENCODE = new Uint8ClampedArray(STEPS + 1);
for (let i = 0; i <= STEPS; i++) {
  const c = i / STEPS;
  ENCODE[i] = Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));
}

/** Twice a colour less one, in linear light: what a full share of it adds to the base's 1. */
function gain(hex: string | undefined): [number, number, number] {
  if (hex === undefined) {
    return [0, 0, 0];
  }
  const n = Number.parseInt(hex.slice(1), 16);
  return [
    2 * (DECODE[(n >> 16) & 255] as number) - 1,
    2 * (DECODE[(n >> 8) & 255] as number) - 1,
    2 * (DECODE[n & 255] as number) - 1,
  ];
}

/**
 * Recolours a portrait's base by its mask into out (all RGBA bytes of one
 * size): each pixel times 1 plus each region's share of (2 × its colour −
 * 1), in linear light; its alpha kept.
 */
export function recolour(
  base: Uint8ClampedArray,
  mask: Uint8ClampedArray,
  colours: PortraitColours,
  out: Uint8ClampedArray,
): void {
  const [main, skin, hair] = [gain(colours.main), gain(colours.skin), gain(colours.hair)];
  for (let i = 0; i < base.length; i += 4) {
    const r = (mask[i] as number) / 255;
    const g = (mask[i + 1] as number) / 255;
    const b = (mask[i + 2] as number) / 255;
    for (let c = 0; c < 3; c++) {
      const tint = 1 + r * (main[c] as number) + g * (skin[c] as number) + b * (hair[c] as number);
      const lit = (DECODE[base[i + c] as number] as number) * tint;
      out[i + c] = ENCODE[Math.round(Math.min(Math.max(lit, 0), 1) * STEPS)] as number;
    }
    out[i + 3] = base[i + 3] as number;
  }
}

/** Loads an image, or rejects when the browser cannot decode it. */
function image(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  return img.decode().then(() => img);
}

/** An image's pixels, as RGBA bytes. */
function pixels(img: HTMLImageElement): Uint8ClampedArray {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) {
    throw new Error('no 2D canvas');
  }
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

const loaded = new Map<string, Promise<Portrait>>();

/** Loads a look and version's portrait once; the base from its AVIF, else its WebP. */
export function loadPortrait(files: PortraitFiles): Promise<Portrait> {
  let p = loaded.get(files.mask);
  if (p === undefined) {
    p = Promise.all([image(files.base).catch(() => image(files.fallback)), image(files.mask)]).then(
      ([base, mask]) => ({
        width: base.naturalWidth,
        height: base.naturalHeight,
        base: pixels(base),
        mask: pixels(mask),
      }),
    );
    // A failed load may be tried again.
    p.catch(() => loaded.delete(files.mask));
    loaded.set(files.mask, p);
  }
  return p;
}

/** Draws a loaded portrait in the colours into a canvas, at the portrait's own size. */
export function paintPortrait(
  canvas: HTMLCanvasElement,
  portrait: Portrait,
  colours: PortraitColours,
): void {
  canvas.width = portrait.width;
  canvas.height = portrait.height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    return;
  }
  const out = ctx.createImageData(portrait.width, portrait.height);
  recolour(portrait.base, portrait.mask, colours, out.data);
  ctx.putImageData(out, 0, 0);
}
