// SPDX-License-Identifier: AGPL-3.0-only

// The chase camera. It sits behind and above the boat at an azimuth and
// elevation measured from the boat's stern, at a distance, and looks at a
// point above the boat. Its yaw follows the boat's heading through a
// critically damped spring, so a tack swings it round smoothly and never
// past. One finger (or the mouse) on the open sea swings it round and up or
// down; a pinch (or the wheel) sets its distance. Five seconds after the
// last touch it eases back to its resting view, unless the player has
// turned that off; it keeps a pinch's distance. Back to the boat brings
// it behind the boat at once, at its resting distance too. It rises and falls with the
// boat on the waves, smoothly, so the boat stays in the frame in a gale. In
// a big sea it takes a share of the boat's pitch and roll too, their swing
// about their mean, low-passed: a level camera hides the sea's motion, and
// one that pitched and rolled with a dinghy in a seaway would be hard to
// watch, so a share, which keeps the boat in the frame and the horizon
// readable (look.ts, SEA_MOTION). The player may turn it off ("The sea
// moves the view"), and it is off when the device asks for reduced motion.
// It never goes below 1.6 m above the sea under the boat, and with reduced
// motion its springs are stiffer.
//
// It can look up. A drag that would take it lower than its lowest goes on
// into a tilt: the camera stays where it is and lifts its gaze from the
// boat toward the sky, up to the zenith; the opposite drag brings the gaze
// back down the same way, and only then raises the camera. While it looks
// above the horizon it does not ease back by itself.
//
// Watching another sailor's boat, it never eases back by itself: the
// player looks where they choose, and Back to the boat brings it back.
//
// As the world is shown it comes down into its first view, from twice its
// height and distance, and a touch ends the descent where it is.
//
// A new boat's first view looks past it at the harbour's mouth: the camera
// stands beyond the boat from the mouth, seaward, at its resting height
// and distance, so the boat, the mole, the narrows and the town beyond are
// in the frame. It holds there, whichever way the boat turns, until the
// sailor's first touch: a touch of the helm, the sheet or the autopilot
// eases it behind the boat at once, and a touch of the sea is a look round
// like any other, easing back five seconds after the last.

import { SEA_MOTION } from '../ocean/look';

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
/** Within this of its resting view, radians, the camera asked back behind the boat is there; and of its distance, m. */
const HOME = 0.001;
const HOME_DISTANCE = 0.01;
/** Within this of its resting view, radians, and of its distance, m, the camera rests behind the boat. */
const RESTING = 0.02;
const RESTING_DISTANCE = 0.1;
/** The descent into the first view starts this many times as high and as far. */
export const DESCENT_FROM = 2;
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

/** v turned by angle radians about the unit axis, right-handed (Rodrigues's formula). */
function turn(
  v: [number, number, number],
  axis: [number, number, number],
  angle: number,
): [number, number, number] {
  const [x, y, z] = v;
  const [a, b, c] = axis;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dot = (a * x + b * y + c * z) * (1 - cos);
  return [
    x * cos + (b * z - c * y) * sin + a * dot,
    y * cos + (c * x - a * z) * sin + b * dot,
    z * cos + (a * y - b * x) * sin + c * dot,
  ];
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
  /** Whether it eases back to its resting view untouched, as the player chooses. */
  easesBack = true;
  /** Another's boat watched: it never eases back by itself, and there is no opening view. */
  watching = false;
  /** Where the camera holds, in the scene, looking at the boat wherever it goes: going over the lip. */
  held: { x: number; y: number; z: number } | null = null;
  /** Whether the sea moves the view, as the player chooses: off under reduced motion whatever they choose. */
  seaMoves = true;
  /** The share of the boat's pitch and roll the camera takes now, radians, low-passed. */
  pitch = 0;
  roll = 0;
  /** The boat's pitch and heel as the camera takes them about: their means, radians. */
  #meanPitch = 0;
  #meanHeel = 0;
  /** The heading the boat's attitude is taken along, radians clockwise from north. */
  #heading = 0;
  /** A bump's shake: its size, metres, when it began and the frame's time, ms. */
  shakeSize = 0;
  #shakeAt = Number.NEGATIVE_INFINITY;
  #now = 0;
  #touched = Number.NEGATIVE_INFINITY;
  /** Easing back to the resting view as asked, until a touch or it is there. */
  #homing = false;
  /** The opening view's bearing from the boat, radians clockwise from north, until the first touch; null after. */
  #opening: number | null = null;
  /** The descent into the first view: how far through it, and how long it takes, s; null when none. */
  #descent: { at: number; time: number } | null = null;

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
    this.#level();
    this.#touched = Number.NEGATIVE_INFINITY;
    this.#opening = null;
    this.#descent = null;
  }

  /** Takes none of the boat's pitch and roll: a boat set down anew starts level. */
  #level(): void {
    this.pitch = 0;
    this.roll = 0;
    this.#meanPitch = 0;
    this.#meanHeel = 0;
  }

  /**
   * Brings the camera to a boat heading this way, heaved this far, on a
   * sea this high under it, at once, keeping its view: after the boat is
   * set down somewhere new, so the camera does not swing round to it.
   */
  settle(heading: number, heave = 0, sea = 0): void {
    this.yaw = heading;
    this.yawRate = 0;
    this.lift = heave;
    this.sea = sea;
    this.#level();
  }

  /**
   * Comes down into the view from DESCENT_FROM times its height and
   * distance over seconds, eased; none for 0.
   */
  descend(seconds: number): void {
    this.#descent = seconds > 0 ? { at: 0, time: seconds } : null;
  }

  /** Whether it is coming down into its first view. */
  get descending(): boolean {
    return this.#descent !== null;
  }

  /** How many times its view's distance the camera stands now: more than 1 while it comes down. */
  get #scale(): number {
    const d = this.#descent;
    if (d === null) {
      return 1;
    }
    const u = Math.min(d.at / d.time, 1);
    // Eased out: fast at first, settling into the view.
    return 1 + (DESCENT_FROM - 1) * (1 - u) ** 3;
  }

  /** Ends the descent where it is: the distance it stands at becomes the view's. */
  #stopDescent(): void {
    if (this.#descent !== null) {
      this.view.distance = clamp(this.view.distance * this.#scale, MIN_DISTANCE, MAX_DISTANCE);
      this.#descent = null;
    }
  }

  /**
   * Opens on a new boat at (east, north), m, looking past it at the
   * harbour's mouth at (mouthEast, mouthNorth): from beyond the boat, on
   * the bearing from the mouth to the boat, at the resting elevation and
   * distance. It holds there until the first touch.
   */
  open(east: number, north: number, mouthEast: number, mouthNorth: number): void {
    const bearing = Math.atan2(east - mouthEast, north - mouthNorth);
    this.#opening = Number.isFinite(bearing) ? bearing : null;
    if (this.#opening === null) {
      return;
    }
    this.view.elevation = this.rest.elevation;
    this.view.distance = this.rest.distance;
    this.tilt = 0;
    this.#homing = false;
    this.#face();
  }

  /** Whether the opening view holds, untouched. */
  get opening(): boolean {
    return this.#opening !== null;
  }

  /** The sailor took the helm, the sheet or the autopilot: the opening view eases behind the boat. */
  controlsTouched(): void {
    if (this.#opening !== null) {
      this.#opening = null;
      this.#homing = true;
    }
  }

  /** The azimuth that puts the camera on the opening's bearing from the boat, whatever its yaw. */
  #face(): void {
    if (this.#opening !== null) {
      // Astern is the yaw's bearing turned half round.
      this.view.azimuth = angleDiff(this.#opening - this.yaw - Math.PI, 0);
    }
  }

  /**
   * Swings the camera by a drag of dx, dy CSS pixels at time now (ms). Up
   * and down run along one path: from the highest view down to the lowest,
   * then on into the tilt toward the zenith.
   */
  drag(dx: number, dy: number, now: number): void {
    this.#stopDescent();
    this.view.azimuth = angleDiff(this.view.azimuth - dx * DRAG_SCALE, 0);
    // Below the lowest view, the path's position is the tilt, counted down.
    const along = this.view.elevation - this.tilt + dy * DRAG_SCALE;
    const lowest = MIN_ELEVATION - MAX_TILT;
    const at = clamp(along, lowest, MAX_ELEVATION);
    this.view.elevation = Math.max(at, MIN_ELEVATION);
    this.tilt = Math.max(MIN_ELEVATION - at, 0);
    this.#touched = now;
    this.#homing = false;
    this.#opening = null;
  }

  /**
   * Eases back to the resting view behind the boat, at its resting
   * distance, at once, whether or not it would by itself.
   */
  behind(): void {
    this.#stopDescent();
    this.tilt = 0;
    this.#homing = true;
    this.#opening = null;
  }

  /** Whether it rests behind the boat, at its resting view and distance, looking at it. */
  get resting(): boolean {
    const v = this.view;
    const r = this.rest;
    return (
      this.#opening === null &&
      this.#descent === null &&
      this.tilt === 0 &&
      Math.abs(angleDiff(r.azimuth, v.azimuth)) < RESTING &&
      Math.abs(r.elevation - v.elevation) < RESTING &&
      Math.abs(r.distance - v.distance) < RESTING_DISTANCE
    );
  }

  /** Whether the camera looks above the horizon. */
  get looksUp(): boolean {
    return this.tilt > this.view.elevation;
  }

  /** Scales the distance (a pinch or the wheel) at time now (ms). */
  zoom(factor: number, now: number): void {
    this.#stopDescent();
    this.#homing = false;
    if (factor > 0 && Number.isFinite(factor)) {
      this.view.distance = clamp(this.view.distance * factor, MIN_DISTANCE, MAX_DISTANCE);
    }
    this.#touched = now;
    this.#opening = null;
  }

  /**
   * Follows a boat heading this way, heaved this far, on a sea this high
   * under it, for dt seconds; now in milliseconds.
   */
  update(
    dt: number,
    heading: number,
    now: number,
    heave = 0,
    sea = 0,
    pitch = 0,
    heel = 0,
    hs = 0,
  ): void {
    this.sea = sea;
    this.#now = now;
    this.#heading = heading;
    if (dt <= 0) {
      return;
    }
    const big = hs > SEA_MOTION.quick ? SEA_MOTION.heave : HEAVE_TIME;
    const follow = this.reducedMotion ? HEAVE_TIME / 3 : big;
    this.lift += (heave - this.lift) * (1 - Math.exp(-dt / follow));
    this.#seaMotion(dt, pitch, heel, hs);
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
    if (this.holding) {
      this.#stopDescent();
    }
    const d = this.#descent;
    if (d !== null) {
      d.at += dt;
      if (d.at >= d.time) {
        this.#descent = null;
      }
    }

    if (this.#opening !== null) {
      if (this.holding || this.watching) {
        // A finger on the sea, or another's boat watched: a look round from here.
        this.#opening = null;
        this.#touched = now;
      } else {
        this.#face();
        return;
      }
    }
    const untouched = this.easesBack && !this.watching && now - this.#touched > EASE_BACK_AFTER;
    if (!this.holding && !this.looksUp && (untouched || this.#homing)) {
      // Looking at the boat again, the tilt goes with the rest.
      this.tilt = 0;
      const f = 1 - Math.exp(-dt / EASE_BACK_TIME);
      this.view.azimuth += angleDiff(this.rest.azimuth, this.view.azimuth) * f;
      this.view.elevation += (this.rest.elevation - this.view.elevation) * f;
      // Asked back, it comes to its resting distance too; by itself it
      // keeps a pinch's.
      if (this.#homing) {
        this.view.distance += (this.rest.distance - this.view.distance) * f;
      }
      if (
        Math.abs(angleDiff(this.rest.azimuth, this.view.azimuth)) < HOME &&
        Math.abs(this.rest.elevation - this.view.elevation) < HOME &&
        Math.abs(this.rest.distance - this.view.distance) < HOME_DISTANCE
      ) {
        this.#homing = false;
      }
    }
  }

  /**
   * The share of the boat's pitch and roll the camera takes in a sea of
   * significant height hs: of their swing about their means, so a boat
   * heeled steadily by the wind does not tilt the horizon; a capsize's heel
   * is held to a ship's roll.
   */
  #seaMotion(dt: number, pitch: number, heel: number, hs: number): void {
    const m = SEA_MOTION;
    const on = this.seaMoves && !this.reducedMotion;
    const share = on ? clamp((hs - m.from) / (m.full - m.from), 0, 1) : 0;
    const settle = 1 - Math.exp(-dt / m.mean);
    this.#meanPitch += (pitch - this.#meanPitch) * settle;
    this.#meanHeel += (heel - this.#meanHeel) * settle;
    const swing = (v: number): number => clamp(v, -0.6, 0.6);
    const toPitch = share * m.pitch * swing(pitch - this.#meanPitch);
    const toRoll = share * m.roll * swing(heel - this.#meanHeel);
    const k = 1 - Math.exp(-dt / m.smooth);
    this.pitch += (toPitch - this.pitch) * k;
    this.roll += (toRoll - this.roll) * k;
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
   * into target, for a boat at scene (x, y, z); and, given up, which way is
   * up for it: turned with the share of the boat's pitch and roll it takes.
   */
  place3(
    x: number,
    y: number,
    z: number,
    position: Vec3Like,
    target: Vec3Like,
    up?: Vec3Like,
  ): void {
    const v = this.view;
    const distance = v.distance * this.#scale;
    // The stern's direction in the scene's x–z plane is the heading plus a
    // quarter turn (x east, z south, both turning clockwise from above).
    const a = this.yaw + Math.PI / 2 + v.azimuth;
    const ce = Math.cos(v.elevation);
    const tx = x;
    const ty = y + this.lift + LOOK_HEIGHT;
    const tz = z;
    target.set(tx, ty, tz);
    up?.set(0, 1, 0);
    if (this.held !== null) {
      position.set(this.held.x, this.held.y, this.held.z);
      return;
    }
    let ox = Math.cos(a) * ce * distance;
    let oy = Math.sin(v.elevation) * distance;
    let oz = Math.sin(a) * ce * distance;
    if (this.pitch !== 0 || this.roll !== 0) {
      // Turned about the boat as the boat turns: by the roll about its
      // fore-and-aft line, then by the pitch about its athwartships line.
      // The scene's x runs east and z south: the bow points (sin h, 0,
      // −cos h) and starboard (cos h, 0, sin h).
      const h = this.#heading;
      const fore: [number, number, number] = [Math.sin(h), 0, -Math.cos(h)];
      const side: [number, number, number] = [Math.cos(h), 0, Math.sin(h)];
      const o = turn(turn([ox, oy, oz], fore, this.roll), side, this.pitch);
      ox = o[0];
      oy = o[1];
      oz = o[2];
      if (up !== undefined) {
        const u = turn(turn([0, 1, 0], fore, this.roll), side, this.pitch);
        up.set(u[0], u[1], u[2]);
      }
    }
    const py = Math.max(ty + oy, y + this.sea + MIN_HEIGHT);
    const px = tx + ox;
    const pz = tz + oz;
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
