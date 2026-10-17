// SPDX-License-Identifier: AGPL-3.0-only

// The world page's map: the world, metres east and north of the disk's
// centre, onto the canvas, CSS pixels from its top left, north up. A view
// is the world point at the canvas's centre and the metres a pixel; it
// pans by a drag, and zooms about the point under the pointer, which stays
// under it. No map library: the disk is a square of 16.8 km drawn on one
// canvas.

/** Half the side of the square the land's chart covers, m: the disk and a little past its lip. */
export const HALF = 8400;
/** The least and the most metres a pixel. */
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 40;

export interface View {
  /** The world point at the canvas's centre, m. */
  east: number;
  north: number;
  /** Metres a CSS pixel. */
  scale: number;
  /** The canvas's size, CSS pixels. */
  width: number;
  height: number;
}

/** The view that fits the whole square in a canvas of this size. */
export function fitView(width: number, height: number): View {
  const scale = (2 * HALF) / Math.max(1, Math.min(width, height));
  return { east: 0, north: 0, scale: clampScale(scale), width, height };
}

export function clampScale(s: number): number {
  return Math.min(Math.max(s, MIN_SCALE), MAX_SCALE);
}

/** The canvas's point of a world point. */
export function toScreen(v: View, east: number, north: number): [number, number] {
  return [v.width / 2 + (east - v.east) / v.scale, v.height / 2 - (north - v.north) / v.scale];
}

/** The world point of a canvas's point. */
export function toWorld(v: View, x: number, y: number): [number, number] {
  return [v.east + (x - v.width / 2) * v.scale, v.north - (y - v.height / 2) * v.scale];
}

/** The view moved by a drag of dx, dy CSS pixels: the world follows the pointer. */
export function pan(v: View, dx: number, dy: number): View {
  return { ...v, east: v.east - dx * v.scale, north: v.north + dy * v.scale };
}

/** The view zoomed by factor (above 1 in) about the canvas's point (x, y), which stays where it is. */
export function zoomAt(v: View, x: number, y: number, factor: number): View {
  const [e, n] = toWorld(v, x, y);
  const scale = clampScale(v.scale / factor);
  const z = { ...v, scale };
  const [e2, n2] = toWorld(z, x, y);
  return { ...z, east: z.east + e - e2, north: z.north + n - n2 };
}

/** The view centred on a world point at a scale. */
export function centreOn(v: View, east: number, north: number, scale = v.scale): View {
  return { ...v, east, north, scale: clampScale(scale) };
}

/** The canvas's rectangle of a world rectangle: west, south, east, north. */
export function rectOf(
  v: View,
  west: number,
  south: number,
  east: number,
  north: number,
): [number, number, number, number] {
  const [x0, y0] = toScreen(v, west, north);
  const [x1, y1] = toScreen(v, east, south);
  return [x0, y0, x1 - x0, y1 - y0];
}

/** A bearing clockwise from north, degrees, as an angle on the canvas from its x axis, radians. */
export function canvasAngle(bearing: number): number {
  return ((bearing - 90) * Math.PI) / 180;
}
