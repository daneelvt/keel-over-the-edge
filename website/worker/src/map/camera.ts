// SPDX-License-Identifier: AGPL-3.0-only

// The chart's camera, as the game's chart screen places it to show the
// whole disk: three.js's perspective camera of 35° looking at a point a
// tenth of the lip south of the centre from 3.4 lips off, raised 0.95 rad
// above the paper, north up the screen. Here it is its matrices alone:
// where a point of the paper falls on a screen of a given size, and the
// paper's plane to the screen as a homography, which carries a circle on
// the paper to the ellipse the camera sees. A port of placeChartCamera
// (client/src/chart/arrow.ts) and ChartView's fit and camera
// (client/src/chart/view.ts): a change to either is made here too.

/** The camera's vertical field of view, degrees, and its elevation above the paper, rad. */
export const FOV = 35;
export const TILT = 0.95;

/** The whole disk in view: where the camera looks, as a share of the lip north, and how far off, in lips. */
const FIT_NORTH = -0.1;
const FIT_DISTANCE = 3.4;

/** A point on the screen, px from its top left. */
export type Px = [number, number];

/** A 3 × 3 matrix, row by row. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export interface View {
  width: number;
  height: number;
  /** Where (east, north) m on the paper, h m above it, falls on the screen. */
  project(east: number, north: number, h?: number): Px;
  /** The paper's plane, (east, north, 1), to the screen's, (x w, y w, w). */
  plane: Mat3;
}

type V3 = [number, number, number];

function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function unit(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
}

/**
 * The chart's camera on a screen width × height px, looking at (east,
 * north) from distance m, turned by bearing rad: three.js's world has x
 * east, y up and z south.
 */
export function chartCamera(
  width: number,
  height: number,
  east: number,
  north: number,
  distance: number,
  bearing = 0,
): View {
  const up = Math.sin(TILT) * distance;
  const back = Math.cos(TILT) * distance;
  const s = Math.sin(bearing);
  const c = Math.cos(bearing);
  const eye: V3 = [east - s * back, up, -(north - c * back)];
  const target: V3 = [east, 0, -north];
  // three.js's lookAt for a camera: it looks down its −z, y up.
  const z = unit(sub(eye, target));
  const x = unit(cross([0, 1, 0], z));
  const y = cross(z, x);
  const t = Math.tan((FOV * Math.PI) / 360);
  const aspect = width / height;
  // Each of the camera's axes as a linear function of (east, h, north) and 1.
  const axis = (a: V3): [number, number, number, number] => [a[0], a[1], -a[2], -dot(a, eye)];
  const ax = axis(x);
  const ay = axis(y);
  const az = axis(z);
  const at = (f: [number, number, number, number], e: number, h: number, n: number) =>
    f[0] * e + f[1] * h + f[2] * n + f[3];
  const project = (e: number, n: number, h = 0): Px => {
    const w = -at(az, e, h, n);
    const xn = at(ax, e, h, n) / (w * t * aspect);
    const yn = at(ay, e, h, n) / (w * t);
    return [((xn + 1) / 2) * width, ((1 - yn) / 2) * height];
  };
  // On the paper, h = 0: x w = (W/2)(w + xc/(t a)), y w = (H/2)(w − yc/t), w = −zc.
  const hw = width / 2;
  const hh = height / 2;
  const plane: Mat3 = [
    hw * (-az[0] + ax[0] / (t * aspect)),
    hw * (-az[2] + ax[2] / (t * aspect)),
    hw * (-az[3] + ax[3] / (t * aspect)),
    hh * (-az[0] - ay[0] / t),
    hh * (-az[2] - ay[2] / t),
    hh * (-az[3] - ay[3] / t),
    -az[0],
    -az[2],
    -az[3],
  ];
  return { width, height, project, plane };
}

/** The chart's camera with the whole disk in view, as its fit puts it, on a screen width × height px. */
export function wholeDisk(lip: number, width: number, height: number): View {
  return chartCamera(width, height, 0, FIT_NORTH * lip, FIT_DISTANCE * lip);
}

/** The distance the whole disk is seen from, m: what the chart letters at that scale goes by it. */
export function wholeDiskDistance(lip: number): number {
  return FIT_DISTANCE * lip;
}

/** A 3 × 3 matrix's inverse. */
export function invert(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det,
    -(b * i - c * h) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    -(a * f - c * d) / det,
    C / det,
    -(a * h - b * g) / det,
    (a * e - b * d) / det,
  ];
}

/** An ellipse on the screen: its centre, its radii and the turn of its first, degrees. */
export interface Ellipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  turn: number;
}

/**
 * The ellipse a circle on the paper, about (east, north) of radius r m,
 * makes on the screen: the circle's conic carried through the inverse of
 * the plane's homography, C' = H⁻ᵀ C H⁻¹.
 */
export function circleOnScreen(inverse: Mat3, east: number, north: number, r: number): Ellipse {
  const c: Mat3 = [1, 0, -east, 0, 1, -north, -east, -north, east * east + north * north - r * r];
  const h = inverse;
  // C H⁻¹, then H⁻ᵀ (C H⁻¹).
  const ch: number[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      let s = 0;
      for (let k = 0; k < 3; k++) {
        s += (c[row * 3 + k] ?? 0) * (h[k * 3 + col] ?? 0);
      }
      ch.push(s);
    }
  }
  const q: number[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      let s = 0;
      for (let k = 0; k < 3; k++) {
        s += (h[k * 3 + row] ?? 0) * (ch[k * 3 + col] ?? 0);
      }
      q.push(s);
    }
  }
  const [a = 0, b = 0, d = 0, , cc = 0, e = 0, , , f = 0] = q;
  // The centre, where the conic's gradient is nought.
  const det = a * cc - b * b;
  const cx = (b * e - cc * d) / det;
  const cy = (b * d - a * e) / det;
  const f0 = f + d * cx + e * cy;
  // The axes: the eigenvectors of [[a, b], [b, c]].
  const mean = (a + cc) / 2;
  const half = Math.sqrt(((a - cc) / 2) ** 2 + b * b);
  const l1 = mean - half;
  const l2 = mean + half;
  const turn = Math.atan2(l1 - a, b === 0 ? 1e-12 : b);
  const rx = Math.sqrt(Math.max(-f0 / l1, 0));
  const ry = Math.sqrt(Math.max(-f0 / l2, 0));
  return { cx, cy, rx, ry, turn: (turn * 180) / Math.PI };
}
