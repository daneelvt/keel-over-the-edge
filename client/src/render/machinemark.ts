// SPDX-License-Identifier: AGPL-3.0-only

// The machine mark: the cogwheel a machine sailor's boat carries on its
// sail, so that every player sees which boats an AI agent sails. Eight
// flat-topped teeth stand on a solid ring about a round hole, a quarter of
// the foot across, at half the luff's height on the middle of the chord
// there. It is printed into the cloth, so it shows on both faces, the
// back's mirrored, which a cog's symmetry hides. It is dark on a light
// cloth and gold on a dark one, and nothing the player sets takes it off.

import type { BufferGeometry } from 'three';

/** The cog's teeth. */
export const COG_TEETH = 8;
/** Its width across the teeth's tips, as a fraction of the sail's foot. */
export const COG_ACROSS = 0.25;
/** The ring's outer edge, where the teeth stand, and the hole's edge, as fractions of the tips' radius. */
export const COG_ROOT = 0.74;
export const COG_HOLE = 0.36;
/** A tooth's half-width, at its root and at its tip, as fractions of the teeth's spacing. */
const TOOTH_ROOT = 0.27;
const TOOTH_TIP = 0.17;
/** Points along the ring between two teeth. */
const GAP_POINTS = 3;

/** The mark's inks: for a light cloth, and for a dark one. */
export const MARK_DARK = '#2b2118';
export const MARK_GOLD = '#d4a72c';

/** The relative luminance of an sRGB colour written #rrggbb, 0 black … 1 white (WCAG 2). */
export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** The mark's ink on a cloth of this colour: dark on a light cloth, gold on a dark one. */
export function markInk(cloth: string): string {
  return luminance(cloth) > 0.18 ? MARK_DARK : MARK_GOLD;
}

/**
 * The cog's outline about its centre, tips' radius 1: the teeth and the
 * ring between them, anticlockwise from the tooth at angle 0, as x, y
 * pairs. A tooth stands at every eighth of a turn, one of them straight
 * up, so the cog is the same mirrored.
 */
export function cogOutline(): Float64Array {
  const pitch = (2 * Math.PI) / COG_TEETH;
  const out: number[] = [];
  const at = (r: number, a: number) => out.push(r * Math.cos(a), r * Math.sin(a));
  for (let k = 0; k < COG_TEETH; k++) {
    const a = k * pitch;
    at(COG_ROOT, a - TOOTH_ROOT * pitch);
    at(1, a - TOOTH_TIP * pitch);
    at(1, a + TOOTH_TIP * pitch);
    at(COG_ROOT, a + TOOTH_ROOT * pitch);
    const gap = (1 - 2 * TOOTH_ROOT) * pitch;
    for (let i = 1; i <= GAP_POINTS; i++) {
      at(COG_ROOT, a + TOOTH_ROOT * pitch + (gap * i) / (GAP_POINTS + 1));
    }
  }
  return new Float64Array(out);
}

/** Whether a point, in tips' radii from the cog's centre, is inked: inside the outline, outside the hole. */
export function onCog(outline: Float64Array, x: number, y: number): boolean {
  if (x * x + y * y < COG_HOLE * COG_HOLE) {
    return false;
  }
  let inside = false;
  const n = outline.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = outline[2 * i] ?? 0;
    const yi = outline[2 * i + 1] ?? 0;
    const xj = outline[2 * j] ?? 0;
    const yj = outline[2 * j + 1] ?? 0;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Where the mark sits on the cloth, as fractions of the foot (u) and of the luff (v), and its size. */
export interface MarkPlace {
  /** The centre: across the foot from the luff, and up the luff from the foot. */
  u: number;
  v: number;
  /** The tips' radius, as a fraction of the foot and of the luff. */
  ru: number;
  rv: number;
}

/**
 * The sail's chord at half the luff's height, as a fraction of the foot,
 * from its model: the leech's vertices (the chord's far end, uv1.x of 1)
 * hold the distance along the foot over its length in uv.x, at the
 * fraction of the luff in uv1.y. A sail without them is taken for a
 * straight-leeched triangle: half the foot.
 */
export function chordAtHalf(sail: BufferGeometry | undefined): number {
  const uv = sail?.getAttribute('uv');
  const uv1 = sail?.getAttribute('uv1');
  if (uv === undefined || uv1 === undefined) {
    return 0.5;
  }
  let below = { v: Number.NEGATIVE_INFINITY, u: 0.5 };
  let above = { v: Number.POSITIVE_INFINITY, u: 0.5 };
  for (let i = 0; i < uv1.count; i++) {
    if (uv1.getX(i) < 0.999) {
      continue;
    }
    const v = uv1.getY(i);
    if (v <= 0.5 && v > below.v) {
      below = { v, u: uv.getX(i) };
    }
    if (v >= 0.5 && v < above.v) {
      above = { v, u: uv.getX(i) };
    }
  }
  if (!Number.isFinite(below.v) || !Number.isFinite(above.v)) {
    return 0.5;
  }
  const t = above.v > below.v ? (0.5 - below.v) / (above.v - below.v) : 0;
  return below.u + (above.u - below.u) * t;
}

/** The mark's place on a sail of this foot and luff, metres, whose chord at half height is this fraction of the foot. */
export function markPlace(foot: number, luff: number, chord: number): MarkPlace {
  const r = (COG_ACROSS * foot) / 2;
  return { u: chord / 2, v: 0.5, ru: r / foot, rv: r / luff };
}

/**
 * Inks the mark into a cloth drawn at width × height, its width the foot
 * and its height the luff, the head at the top.
 */
export function paintMark(
  g: CanvasRenderingContext2D,
  place: MarkPlace,
  width: number,
  height: number,
  ink: string,
): void {
  const outline = cogOutline();
  g.save();
  g.translate(place.u * width, (1 - place.v) * height);
  g.scale(place.ru * width, place.rv * height);
  g.beginPath();
  for (let i = 0; i < outline.length; i += 2) {
    const x = outline[i] ?? 0;
    // Up the canvas is down its y.
    const y = -(outline[i + 1] ?? 0);
    if (i === 0) {
      g.moveTo(x, y);
    } else {
      g.lineTo(x, y);
    }
  }
  g.closePath();
  g.moveTo(COG_HOLE, 0);
  g.arc(0, 0, COG_HOLE, 0, 2 * Math.PI, true);
  g.fillStyle = ink;
  g.fill('evenodd');
  g.restore();
}
