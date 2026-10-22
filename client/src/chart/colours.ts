// SPDX-License-Identifier: AGPL-3.0-only

// How far apart two colours look, to a reader of normal vision and to one
// of each common deficiency, and how well a mark stands off its ground:
// what the chart's weather palette is checked by. Colours are compared by
// CIEDE2000 (Sharma, Wu and Dalal 2005, their implementation notes and
// test pairs) in CIELAB under D65; a deficiency is simulated by Machado,
// Oliveira and Fernandes's matrices of severity 1 (2009), applied in
// linear RGB as Chrome's emulation applies them; a mark's contrast is
// WCAG 2.2's, 3:1 at the least for a graphical object (1.4.11).

export type Rgb = [number, number, number];

/** A colour #rrggbb as sRGB values from 0 to 1. */
export function hexRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function toSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

/** Machado and others' matrices of severity 1, for linear RGB. */
export const DEFICIENCIES = {
  protanopia: [
    0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998,
  ],
  deuteranopia: [
    0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881,
  ],
  tritanopia: [
    1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039,
  ],
} as const;

export type Deficiency = keyof typeof DEFICIENCIES;

/** A colour as a reader of a deficiency sees it, in sRGB. */
export function simulate(c: Rgb, d: Deficiency): Rgb {
  const m = DEFICIENCIES[d];
  const l = c.map(toLinear) as Rgb;
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    const v = (m[3 * r] ?? 0) * l[0] + (m[3 * r + 1] ?? 0) * l[1] + (m[3 * r + 2] ?? 0) * l[2];
    out.push(toSrgb(Math.min(Math.max(v, 0), 1)));
  }
  return out as Rgb;
}

/** A colour over another at an opacity, as a canvas blends them. */
export function over(top: Rgb, ground: Rgb, alpha: number): Rgb {
  return [0, 1, 2].map((i) => (top[i] ?? 0) * alpha + (ground[i] ?? 0) * (1 - alpha)) as Rgb;
}

/** sRGB as CIELAB, D65. */
export function lab(c: Rgb): [number, number, number] {
  const [r, g, b] = c.map(toLinear) as Rgb;
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** The CIEDE2000 colour difference between two CIELAB colours (Sharma, Wu and Dalal 2005). */
export function deltaE2000(a: readonly number[], b: readonly number[]): number {
  const [l1, a1, b1] = a as [number, number, number];
  const [l2, a2, b2] = b as [number, number, number];
  const deg = Math.PI / 180;
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cm = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(cm ** 7 / (cm ** 7 + 25 ** 7)));
  const ap1 = (1 + g) * a1;
  const ap2 = (1 + g) * a2;
  const cp1 = Math.hypot(ap1, b1);
  const cp2 = Math.hypot(ap2, b2);
  const hue = (bb: number, ap: number) => {
    if (bb === 0 && ap === 0) {
      return 0;
    }
    const h = Math.atan2(bb, ap) / deg;
    return h < 0 ? h + 360 : h;
  };
  const hp1 = hue(b1, ap1);
  const hp2 = hue(b2, ap2);
  const dl = l2 - l1;
  const dc = cp2 - cp1;
  let dh = 0;
  if (cp1 * cp2 !== 0) {
    dh = hp2 - hp1;
    if (dh > 180) {
      dh -= 360;
    } else if (dh < -180) {
      dh += 360;
    }
  }
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin((dh / 2) * deg);
  const lm = (l1 + l2) / 2;
  const cpm = (cp1 + cp2) / 2;
  let hm = hp1 + hp2;
  if (cp1 * cp2 !== 0) {
    if (Math.abs(hp1 - hp2) <= 180) {
      hm = (hp1 + hp2) / 2;
    } else if (hp1 + hp2 < 360) {
      hm = (hp1 + hp2 + 360) / 2;
    } else {
      hm = (hp1 + hp2 - 360) / 2;
    }
  }
  const t =
    1 -
    0.17 * Math.cos((hm - 30) * deg) +
    0.24 * Math.cos(2 * hm * deg) +
    0.32 * Math.cos((3 * hm + 6) * deg) -
    0.2 * Math.cos((4 * hm - 63) * deg);
  const dTheta = 30 * Math.exp(-(((hm - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(cpm ** 7 / (cpm ** 7 + 25 ** 7));
  const sl = 1 + (0.015 * (lm - 50) ** 2) / Math.sqrt(20 + (lm - 50) ** 2);
  const sc = 1 + 0.045 * cpm;
  const sh = 1 + 0.015 * cpm * t;
  const rt = -Math.sin(2 * dTheta * deg) * rc;
  return Math.sqrt((dl / sl) ** 2 + (dc / sc) ** 2 + (dH / sh) ** 2 + rt * (dc / sc) * (dH / sh));
}

/** WCAG's relative luminance of an sRGB colour. */
export function luminance(c: Rgb): number {
  const [r, g, b] = c.map(toLinear) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG's contrast ratio between two colours. */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
