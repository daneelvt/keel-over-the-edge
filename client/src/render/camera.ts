// SPDX-License-Identifier: AGPL-3.0-only

// The chase camera. It sits behind and above the boat at an azimuth and
// elevation measured from the boat's stern, at a distance, and looks at a
// point above the boat. Its yaw follows the boat's heading through a
// critically damped spring, so a tack swings it round smoothly and never
// past. One finger (or the mouse) on the open sea swings it round and up or
// down; a pinch (or the wheel) sets its distance. Five seconds after the
// last touch it eases back to its resting view. It ignores the heel, never
// goes below 1.5 m above the sea, and with reduced motion its spring is
// stiffer.

/** A view of the boat: azimuth from astern (radians, toward the port quarter positive), elevation above the horizon, distance in metres. */
export interface CameraView {
  azimuth: number;
  elevation: number;
  distance: number;
}

/** The camera looks at this point above the boat, in metres. */
export const LOOK_HEIGHT = 1.8;
/** The lowest the camera goes, in metres above the sea. */
export const MIN_HEIGHT = 1.5;
/** The distances a pinch or the wheel can set, in metres. */
export const MIN_DISTANCE = 5;
export const MAX_DISTANCE = 80;
const MIN_ELEVATION = 0.03;
const MAX_ELEVATION = 1.45;
/**
 * The yaw spring's natural frequency, per second: settled within a degree
 * two seconds after the heading turns through 180°. Reduced motion: stiffer.
 */
export const YAW_OMEGA = 4;
export const YAW_OMEGA_REDUCED = 12;
/** Untouched this long, in milliseconds, the camera eases back to its resting view. */
export const EASE_BACK_AFTER = 5000;
/** The easing back's time constant, in seconds. */
const EASE_BACK_TIME = 0.8;
/** Radians a CSS pixel of drag swings the camera. */
const DRAG_SCALE = 0.006;

/** The view the game starts with, behind and above the boat. */
export const CHASE: CameraView = { azimuth: 0, elevation: 0.3, distance: 16 };

/**
 * Fixed views, for comparing with the renderings and for the picture tests:
 * sea and bands are the waves rendering's "Sea states" and "Two bands".
 */
export const CAMERA_PRESETS: Record<string, CameraView> = {
  chase: CHASE,
  sea: { azimuth: 1.1028, elevation: 0.2, distance: 42 },
  bands: { azimuth: 1.2528, elevation: 0.62, distance: 46 },
  aboard: { azimuth: 1.4028, elevation: 0.24, distance: 21 },
  high: { azimuth: 1.2528, elevation: 1.0, distance: 160 },
};

/** The difference a − b of two angles, in (−π, π]. */
export function angleDiff(a: number, b: number): number {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) {
    d -= 2 * Math.PI;
  } else if (d <= -Math.PI) {
    d += 2 * Math.PI;
  }
  return d;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
  set(x: number, y: number, z: number): unknown;
}

export class ChaseCamera {
  /** The heading the camera's yaw has caught up with, radians clockwise from north. */
  yaw = 0;
  yawRate = 0;
  readonly view: CameraView = { ...CHASE };
  readonly rest: CameraView = { ...CHASE };
  reducedMotion = false;
  /** Whether a finger or the mouse holds the camera. */
  holding = false;
  #touched = Number.NEGATIVE_INFINITY;

  /** Puts the camera at a view, behind a boat heading this way, at once; it becomes the resting view. */
  place(v: CameraView, heading: number): void {
    Object.assign(this.view, v);
    Object.assign(this.rest, v);
    this.yaw = heading;
    this.yawRate = 0;
    this.#touched = Number.NEGATIVE_INFINITY;
  }

  /** Swings the camera by a drag of dx, dy CSS pixels at time now (ms). */
  drag(dx: number, dy: number, now: number): void {
    this.view.azimuth = angleDiff(this.view.azimuth - dx * DRAG_SCALE, 0);
    this.view.elevation = clamp(
      this.view.elevation + dy * DRAG_SCALE,
      MIN_ELEVATION,
      MAX_ELEVATION,
    );
    this.#touched = now;
  }

  /** Scales the distance (a pinch or the wheel) at time now (ms). */
  zoom(factor: number, now: number): void {
    if (factor > 0 && Number.isFinite(factor)) {
      this.view.distance = clamp(this.view.distance * factor, MIN_DISTANCE, MAX_DISTANCE);
    }
    this.#touched = now;
  }

  /** Follows a boat heading this way for dt seconds; now in milliseconds. */
  update(dt: number, heading: number, now: number): void {
    if (dt <= 0) {
      return;
    }
    // The exact step of a critically damped spring, x″ = −ω²x − 2ωx′, on the
    // yaw's error from the heading: it never overshoots from rest.
    const w = this.reducedMotion ? YAW_OMEGA_REDUCED : YAW_OMEGA;
    const e = -angleDiff(heading, this.yaw);
    const v = this.yawRate;
    const k = Math.exp(-w * dt);
    const c = (v + w * e) * dt;
    const e1 = (e + c) * k;
    this.yawRate = (v - w * c) * k;
    this.yaw = angleDiff(heading + e1, 0);

    if (!this.holding && now - this.#touched > EASE_BACK_AFTER) {
      const f = 1 - Math.exp(-dt / EASE_BACK_TIME);
      this.view.azimuth += angleDiff(this.rest.azimuth, this.view.azimuth) * f;
      this.view.elevation += (this.rest.elevation - this.view.elevation) * f;
    }
  }

  /**
   * Writes the camera's position into position and the point it looks at
   * into target, for a boat at scene (x, y, z).
   */
  place3(x: number, y: number, z: number, position: Vec3Like, target: Vec3Like): void {
    const v = this.view;
    // The stern's direction in the scene's x–z plane is the heading plus a
    // quarter turn (x east, z south, both turning clockwise from above).
    const a = this.yaw + Math.PI / 2 + v.azimuth;
    const ce = Math.cos(v.elevation);
    const tx = x;
    const ty = y + LOOK_HEIGHT;
    const tz = z;
    target.set(tx, ty, tz);
    const py = Math.max(ty + Math.sin(v.elevation) * v.distance, y + MIN_HEIGHT);
    position.set(tx + Math.cos(a) * ce * v.distance, py, tz + Math.sin(a) * ce * v.distance);
  }
}
