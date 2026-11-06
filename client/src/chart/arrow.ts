// SPDX-License-Identifier: AGPL-3.0-only

// The boat's arrow on the chart: a cone with a ball at its tail, its size
// in metres the world's, as an island's is, so it shrinks with the world as
// the chart zooms out; but never so small on the screen it is lost with the
// whole disk in view, nor so large it covers the islands near it zoomed
// in. Its length on the screen is what the camera makes of its nose and
// tail, wherever the boat is and whichever way it heads.

import type { PerspectiveCamera } from 'three';
import { type Vector2, Vector3 } from 'three';

/** The arrow's cone at its own scale, m: its nose ahead of the boat, its tail behind, and its height above the paper. */
export const ARROW_NOSE = 190;
export const ARROW_TAIL = 70;
export const ARROW_HEIGHT = 120;

/** The fewest and the most CSS pixels the arrow is long on the screen. */
export const ARROW_LEAST = 12;
export const ARROW_MOST = 32;

/** Where the boat is on the chart and which way it heads, rad from north. */
export interface ArrowAt {
  east: number;
  north: number;
  heading: number;
}

/**
 * The scale to draw the arrow at, from its length on the screen at its own
 * size, px: its own size while that is within the bounds, else the size
 * that brings it to the nearer bound.
 */
export function arrowScale(pixels: number): number {
  if (!(pixels > 0) || !Number.isFinite(pixels)) {
    return 1;
  }
  return Math.min(Math.max(1, ARROW_LEAST / pixels), ARROW_MOST / pixels);
}

const nose = new Vector3();
const tail = new Vector3();

/** The arrow's length on a screen of width × height CSS pixels at a scale, nose to tail; NaN where either is behind the camera. */
export function arrowLength(
  camera: PerspectiveCamera,
  width: number,
  height: number,
  b: ArrowAt,
  scale: number,
): number {
  const ahead = Math.sin(b.heading);
  const up = Math.cos(b.heading);
  const y = ARROW_HEIGHT * scale;
  nose
    .set(b.east + ahead * ARROW_NOSE * scale, y, -(b.north + up * ARROW_NOSE * scale))
    .project(camera);
  tail
    .set(b.east - ahead * ARROW_TAIL * scale, y, -(b.north - up * ARROW_TAIL * scale))
    .project(camera);
  if (nose.z >= 1 || tail.z >= 1) {
    return Number.NaN;
  }
  return Math.hypot(((nose.x - tail.x) * width) / 2, ((nose.y - tail.y) * height) / 2);
}

/** The arrow's scale as the camera sees it: its own size, or brought to the nearer bound. */
export function arrowSize(
  camera: PerspectiveCamera,
  width: number,
  height: number,
  b: ArrowAt,
): number {
  let scale = arrowScale(arrowLength(camera, width, height, b, 1));
  if (scale === 1) {
    return 1;
  }
  // Brought to the bound it passed: the height above the paper grows with
  // the scale too, and close in the camera's perspective with it, so a few
  // steps more.
  const bound = scale < 1 ? ARROW_MOST : ARROW_LEAST;
  for (let i = 0; i < 4; i++) {
    const length = arrowLength(camera, width, height, b, scale);
    if (!(length > 0) || Math.abs(length - bound) < 0.02) {
      break;
    }
    scale *= bound / length;
  }
  return scale;
}

/** Places the chart's camera: looking at target from distance m, at its elevation, turned by bearing rad. */
export function placeChartCamera(
  camera: PerspectiveCamera,
  target: Vector2,
  distance: number,
  bearing: number,
  tilt: number,
): void {
  const up = Math.sin(tilt) * distance;
  const back = Math.cos(tilt) * distance;
  const s = Math.sin(bearing);
  const c = Math.cos(bearing);
  camera.position.set(target.x - s * back, up, -(target.y - c * back));
  camera.lookAt(target.x, 0, -target.y);
  camera.updateMatrixWorld();
}
