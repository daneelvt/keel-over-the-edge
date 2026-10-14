// SPDX-License-Identifier: AGPL-3.0-only

// The chase camera. It sits behind and above the boat at an azimuth and
// elevation measured from the boat's stern, at a distance, and looks at a
// point above the boat. Its yaw follows the boat's heading through a
// critically damped spring, so a tack swings it round smoothly and never
// past. One finger (or the mouse) on the open sea swings it round and up or
// down; a pinch (or the wheel) sets its distance. Five seconds after the
// last touch it eases back to its resting view. It rises and falls with the
// boat on the waves, smoothly, so the boat stays in the frame in a gale, but
// ignores the boat's heel and pitch: a camera that pitched with a dinghy in
// a seaway would be hard to watch. It never goes below 1.6 m above the sea
// under the boat, and with reduced motion its springs are stiffer.
//
// It can look up. A drag that would take it lower than its lowest goes on
// into a tilt: the camera stays where it is and lifts its gaze from the
// boat toward the sky, up to the zenith; the opposite drag brings the gaze
// back down the same way, and only then raises the camera. While it looks
// above the horizon it does not ease back by itself.

/** A view of the boat: azimuth from astern (radians, toward the port quarter positive), elevation above the horizon, distance in metres. */
export interface CameraView {
  azimuth: number;
  elevation: number;
  distance: number;
}

/** The camera looks at this point above the boat, in metres. */
export const LOOK_HEIGHT = 1.8;
/** The lowest the camera goes, in metres above the sea under the boat. */
export const MIN_HEIGHT = 1.6;
/** The camera follows the boat's heave over this long, in seconds. */
export const HEAVE_TIME = 0.5;
/** The distances a pinch or the wheel can set, in metres. */
export const MIN_DISTANCE = 5;
export const MAX_DISTANCE = 80;
const MIN_ELEVATION = 0.03;
const MAX_ELEVATION = 1.45;
/** The gaze lifts at most to this far above the horizontal: all but the zenith itself, where "up" would be lost. */
export const MAX_GAZE = Math.PI / 2 - 0.002;
/** The tilt runs from 0, looking at the boat, to this: enough for the zenith from the lowest view. */
export const MAX_TILT = Math.PI / 2 + 0.2;
/**
 * The yaw spring's natural frequency, per second: settled within a degree
 * two seconds after the heading turns through 180°. Reduced motion: stiffer.
 */
export const YAW_OMEGA = 4;
/**
 * A bump shakes the camera: metres of shake per m/s of closing speed, at
 * most SHAKE_MOST, wobbling at SHAKE_RATE and gone after SHAKE_TIME; under
 * reduced motion, SHAKE_REDUCED of it.
 */
export const SHAKE_PER_SPEED = 0.05;
export const SHAKE_MOST = 0.25;
export const SHAKE_RATE = 11; // Hz
export const SHAKE_TIME = 0.4; // s
export const SHAKE_REDUCED = 1 / 3;
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
  /** How far the gaze is lifted from the boat toward the sky, radians: 0 to MAX_TILT. */
  tilt = 0;
  /** The boat's heave as the camera has followed it, and the sea's height under the boat, metres. */
  lift = 0;
  sea = 0;
  /** A bump's shake: its size, metres, when it began and the frame's time, ms. */
  shakeSize = 0;
  #shakeAt = Number.NEGATIVE_INFINITY;
  #now = 0;
  #touched = Number.NEGATIVE_INFINITY;

  /**
   * Puts the camera at a view, behind a boat heading this way and heaved
   * this far on a sea this high under it, at once; it becomes the resting
   * view.
   */
  place(v: CameraView, heading: number, heave = 0, sea = 0): void {
    Object.assign(this.view, v);
    Object.assign(this.rest, v);
    this.yaw = heading;
    this.yawRate = 0;
    this.tilt = 0;
    this.lift = heave;
    this.sea = sea;
    this.#touched = Number.NEGATIVE_INFINITY;
  }

  /**
   * Swings the camera by a drag of dx, dy CSS pixels at time now (ms). Up
   * and down run along one path: from the highest view down to the lowest,
   * then on into the tilt toward the zenith.
   */
  drag(dx: number, dy: number, now: number): void {
    this.view.azimuth = angleDiff(this.view.azimuth - dx * DRAG_SCALE, 0);
    // Below the lowest view, the path's position is the tilt, counted down.
    const along = this.view.elevation - this.tilt + dy * DRAG_SCALE;
    const lowest = MIN_ELEVATION - MAX_TILT;
    const at = clamp(along, lowest, MAX_ELEVATION);
    this.view.elevation = Math.max(at, MIN_ELEVATION);
    this.tilt = Math.max(MIN_ELEVATION - at, 0);
    this.#touched = now;
  }

  /** Whether the camera looks above the horizon. */
  get looksUp(): boolean {
    return this.tilt > this.view.elevation;
  }

  /** Scales the distance (a pinch or the wheel) at time now (ms). */
  zoom(factor: number, now: number): void {
    if (factor > 0 && Number.isFinite(factor)) {
      this.view.distance = clamp(this.view.distance * factor, MIN_DISTANCE, MAX_DISTANCE);
    }
    this.#touched = now;
  }

  /**
   * Follows a boat heading this way, heaved this far, on a sea this high
   * under it, for dt seconds; now in milliseconds.
   */
  update(dt: number, heading: number, now: number, heave = 0, sea = 0): void {
    this.sea = sea;
    this.#now = now;
    if (dt <= 0) {
      return;
    }
    const follow = this.reducedMotion ? HEAVE_TIME / 3 : HEAVE_TIME;
    this.lift += (heave - this.lift) * (1 - Math.exp(-dt / follow));
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

    if (!this.holding && !this.looksUp && now - this.#touched > EASE_BACK_AFTER) {
      // Looking at the boat again, the tilt goes with the rest.
      this.tilt = 0;
      const f = 1 - Math.exp(-dt / EASE_BACK_TIME);
      this.view.azimuth += angleDiff(this.rest.azimuth, this.view.azimuth) * f;
      this.view.elevation += (this.rest.elevation - this.view.elevation) * f;
    }
  }

  /** Shakes the camera for a bump the hulls closed at closing m/s, at now (ms). */
  shake(closing: number, now: number): void {
    const size = Math.min(SHAKE_MOST, SHAKE_PER_SPEED * Math.max(0, closing));
    this.shakeSize = this.reducedMotion ? size * SHAKE_REDUCED : size;
    this.#shakeAt = now;
  }

  /** The shake's displacement at now (ms): a wobble dying away over SHAKE_TIME. */
  shakeAt(now: number): number {
    const t = (now - this.#shakeAt) / 1000;
    if (!(t >= 0 && t < SHAKE_TIME)) {
      return 0;
    }
    const left = 1 - t / SHAKE_TIME;
    return this.shakeSize * left * left * Math.sin(2 * Math.PI * SHAKE_RATE * t);
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
    const ty = y + this.lift + LOOK_HEIGHT;
    const tz = z;
    target.set(tx, ty, tz);
    const py = Math.max(ty + Math.sin(v.elevation) * v.distance, y + this.sea + MIN_HEIGHT);
    const px = tx + Math.cos(a) * ce * v.distance;
    const pz = tz + Math.sin(a) * ce * v.distance;
    // A bump's shake moves the camera across the line to the boat and up.
    const s = this.shakeAt(this.#now);
    position.set(px - Math.sin(a) * s, py + 0.6 * s, pz + Math.cos(a) * s);
    if (this.tilt <= 0) {
      return;
    }
    // The gaze, lifted by the tilt from the line to the boat, about the
    // level axis square to it.
    const hx = tx - px;
    const hz = tz - pz;
    const level = Math.hypot(hx, hz);
    const gaze = Math.min(Math.atan2(ty - py, level) + this.tilt, MAX_GAZE);
    const k = Math.cos(gaze) / Math.max(level, 1e-9);
    target.set(px + hx * k, py + Math.sin(gaze), pz + hz * k);
  }
}
