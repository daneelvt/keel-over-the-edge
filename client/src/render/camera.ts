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
// It keeps out of the land, as a game's camera keeps out of its walls, by a
// spring arm (Unreal's Spring Arm, Cinemachine's Deoccluder): its line from
// the point it looks at out to where its view puts it is marched in metre
// steps, and it stands at the farthest point on that line clear of every
// solid by CLEARANCE all the way from the look point: never inside an
// island's columns, an arch's roof, a house or a tower, nor so near that
// its near plane cuts in, and never with the land between it and the boat.
// It comes in at once, the frame the land comes into its line, and goes
// back out by a critically damped spring over ARM_TIME, never past its
// view. Where the clear reach is shorter than SHORTEST it rises, at the
// same azimuth, to the first elevation that gives that much, or the
// longest it finds, and comes down again the same way when it may. The
// player's view is never changed by the land: the arm only shortens and
// lifts it for as long as it must. Away from land it is not there at all.
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
// Its views are framed for the catalog's first boat: for a larger one its
// distance scales with the boat (sizeOf), and the height it looks at with
// its masthead (lookSizeOf), so the boat fills the frame as the first does.
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

import type { SolidLookup } from '../land/solids';
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
/** The arm: the camera keeps this far from anything solid, m, all along its line to the boat: the near plane's corners and a bump's shake. */
export const CLEARANCE = 0.5;
/** Where the clear reach is shorter than this, m, the camera rises. */
export const SHORTEST = 4;
/** The arm goes back out over this long, s: a critically damped spring, settled within 1% of the way. */
export const ARM_TIME = 0.6;
const ARM_OMEGA = 6.64 / ARM_TIME;
/** The march's longest step along the line, m, and how often the first blocked step is halved back toward the last clear one. */
const ARM_STEP = 1;
const ARM_REFINE = 5;
/** Within this of the view's distance, m, and of its elevation, radians, the arm lets go. */
const ARM_DONE = 0.001;
const RISE_DONE = 1e-4;
/** The rise tries this many elevations, evenly, from the view's up to the highest. */
const RISE_STEPS = 6;

/** A boat's size, as the camera frames it: its length over all, and its sails' heights, metres. */
export interface FramedBoat {
  lengthOverall: number;
  physics: {
    rig: { boomHeight: number; luff: number };
    headsails?: { headsailArea: number; headsailTackHeight: number; headsailLuff: number };
    square?: {
      squareForeArea: number;
      squareAfterArea: number;
      squareFootHeight: number;
      squareLuff: number;
    };
  };
}

/** The farthest the chase camera stands from any boat at rest, metres. */
export const MAX_CHASE = 140;

/** The height of a boat's highest sail's head above the water: its main's, its headsails', or its square sails'. */
export function mastOf(b: FramedBoat): number {
  const { rig, headsails, square } = b.physics;
  let top = rig.boomHeight + rig.luff;
  if (headsails !== undefined && headsails.headsailArea > 0) {
    top = Math.max(top, headsails.headsailTackHeight + headsails.headsailLuff);
  }
  if (square !== undefined && square.squareForeArea + square.squareAfterArea > 0) {
    top = Math.max(top, square.squareFootHeight + square.squareLuff);
  }
  return top;
}

/**
 * How much farther the camera stands from a boat than from the one its
 * views are framed for: by the boat's length or its masthead's height,
 * whichever is the more, the chase view never past MAX_CHASE.
 */
export function sizeOf(boat: FramedBoat, framed: FramedBoat): number {
  if (boat === framed) {
    return 1;
  }
  const size = Math.max(boat.lengthOverall / framed.lengthOverall, mastOf(boat) / mastOf(framed));
  return Math.min(size, MAX_CHASE / CHASE.distance);
}

/** How much higher the camera looks above a boat than above the one its views are framed for: by its masthead. */
export function lookSizeOf(boat: FramedBoat, framed: FramedBoat): number {
  return boat === framed ? 1 : mastOf(boat) / mastOf(framed);
}

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

/** (x, y, z) turned by angle radians about the unit axis (a, b, c), right-handed (Rodrigues's formula), into out. */
function turn(
  out: Float64Array,
  x: number,
  y: number,
  z: number,
  a: number,
  b: number,
  c: number,
  angle: number,
): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dot = (a * x + b * y + c * z) * (1 - cos);
  out[0] = x * cos + (b * z - c * y) * sin + a * dot;
  out[1] = y * cos + (c * x - a * z) * sin + b * dot;
  out[2] = z * cos + (a * y - b * x) * sin + c * dot;
}

/** The rate after springStep's step. */
let springRate = 0;

/**
 * The exact step over dt of a critically damped spring, x″ = −ω²(x − to)
 * − 2ωx′, from x moving at rate: never past to from rest.
 */
function springStep(x: number, rate: number, to: number, w: number, dt: number): number {
  const e = x - to;
  const k = Math.exp(-w * dt);
  const c = (rate + w * e) * dt;
  springRate = (rate - w * c) * k;
  return to + (e + c) * k;
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
  /** How much larger the boat is than the one the views are framed for (sizeOf): its distances scale by it. */
  size = 1;
  /** How much taller its masthead is (lookSizeOf): the height looked at scales by it. */
  lookSize = 1;
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
  /** What the camera keeps out of; null for nothing (the open sea). */
  solids: SolidLookup | null = null;
  /** The world point the scene's origin is at, m east (x) and north (y); null for the world's centre. */
  origin: { readonly x: number; readonly y: number } | null = null;
  /** The arm: how far along its line from the look point the camera stands, m, and how fast that grows; ∞ while the line is clear to the view. */
  #reach = Number.POSITIVE_INFINITY;
  #reachRate = 0;
  /** The elevation the arm has lifted the camera to, radians, and how fast it comes down; −∞ when not lifted. */
  #rise = Number.NEGATIVE_INFINITY;
  #riseRate = 0;
  /** The seconds the arm has to move by at the next placing. */
  #armDt = 0;
  /** The camera's point as a view puts it, before the shake and after, in the scene: the arm's scratch. */
  #px = 0;
  #py = 0;
  #pz = 0;
  #sx = 0;
  #sy = 0;
  #sz = 0;
  readonly #turned = new Float64Array(3);

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
    this.#letGo();
    this.#touched = Number.NEGATIVE_INFINITY;
    this.#opening = null;
    this.#descent = null;
  }

  /** The arm lets go: at the next placing it takes whatever land is in its line at once. */
  #letGo(): void {
    this.#reach = Number.POSITIVE_INFINITY;
    this.#reachRate = 0;
    this.#rise = Number.NEGATIVE_INFINITY;
    this.#riseRate = 0;
    this.#armDt = 0;
  }

  /** How far along its line the arm holds the camera, m: ∞ while the line is clear to the view (the tests, the panel). */
  get armReach(): number {
    return this.#reach;
  }

  /** The elevation the arm has lifted the camera to, radians; −∞ when not lifted. */
  get armRise(): number {
    return this.#rise;
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
    this.#letGo();
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
    this.#armDt += dt;
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

  /** The height above the boat the camera looks at, metres. */
  get lookHeight(): number {
    return LOOK_HEIGHT * this.lookSize;
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
   * The arm keeps it out of the solids.
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
    const distance = v.distance * this.#scale * this.size;
    // The stern's direction in the scene's x–z plane is the heading plus a
    // quarter turn (x east, z south, both turning clockwise from above).
    const a = this.yaw + Math.PI / 2 + v.azimuth;
    const tx = x;
    const ty = y + this.lift + this.lookHeight;
    const tz = z;
    target.set(tx, ty, tz);
    up?.set(0, 1, 0);
    if (this.held !== null) {
      position.set(this.held.x, this.held.y, this.held.z);
      return;
    }
    if ((this.pitch !== 0 || this.roll !== 0) && up !== undefined) {
      const h = this.#heading;
      const u = this.#turned;
      turn(u, 0, 1, 0, Math.sin(h), 0, -Math.cos(h), this.roll);
      turn(u, u[0] ?? 0, u[1] ?? 0, u[2] ?? 0, Math.cos(h), 0, Math.sin(h), this.pitch);
      up.set(u[0] ?? 0, u[1] ?? 1, u[2] ?? 0);
    }
    // A bump's shake moves the camera across the line to the boat and up.
    const s = this.shakeAt(this.#now);
    const solids = this.solids;
    const dt = this.#armDt;
    this.#armDt = 0;
    const elevation =
      solids === null ? v.elevation : this.#lift(solids, a, distance, tx, ty, tz, y, s, dt);
    this.#aim(elevation, a, distance, tx, ty, tz, y, s);
    let px = this.#px;
    let py = this.#py;
    let pz = this.#pz;
    if (solids === null) {
      position.set(this.#sx, this.#sy, this.#sz);
    } else {
      // Along the line from the look point, as far as the arm reaches.
      const share = this.#arm(solids, tx, ty, tz, dt);
      if (share < 1) {
        px = tx + (px - tx) * share;
        py = ty + (py - ty) * share;
        pz = tz + (pz - tz) * share;
        position.set(
          tx + (this.#sx - tx) * share,
          ty + (this.#sy - ty) * share,
          tz + (this.#sz - tz) * share,
        );
      } else {
        position.set(this.#sx, this.#sy, this.#sz);
      }
    }
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

  /**
   * Where the view puts the camera at this elevation, for the look point at
   * (tx, ty, tz) over a boat at scene height y: before the shake s into
   * #px, #py, #pz, and after it into #sx, #sy, #sz.
   */
  #aim(
    elevation: number,
    a: number,
    distance: number,
    tx: number,
    ty: number,
    tz: number,
    y: number,
    s: number,
  ): void {
    const ce = Math.cos(elevation);
    let ox = Math.cos(a) * ce * distance;
    let oy = Math.sin(elevation) * distance;
    let oz = Math.sin(a) * ce * distance;
    if (this.pitch !== 0 || this.roll !== 0) {
      // Turned about the boat as the boat turns: by the roll about its
      // fore-and-aft line, then by the pitch about its athwartships line.
      // The scene's x runs east and z south: the bow points (sin h, 0,
      // −cos h) and starboard (cos h, 0, sin h).
      const h = this.#heading;
      const o = this.#turned;
      turn(o, ox, oy, oz, Math.sin(h), 0, -Math.cos(h), this.roll);
      turn(o, o[0] ?? 0, o[1] ?? 0, o[2] ?? 0, Math.cos(h), 0, Math.sin(h), this.pitch);
      ox = o[0] ?? 0;
      oy = o[1] ?? 0;
      oz = o[2] ?? 0;
    }
    const py = Math.max(ty + oy, y + this.sea + MIN_HEIGHT);
    const px = tx + ox;
    const pz = tz + oz;
    this.#px = px;
    this.#py = py;
    this.#pz = pz;
    this.#sx = px - Math.sin(a) * s;
    this.#sy = py + 0.6 * s;
    this.#sz = pz + Math.cos(a) * s;
  }

  /**
   * The elevation the camera stands at, radians: the view's, or higher
   * where the clear reach at the view's is shorter than SHORTEST: the
   * first of the elevations up to the highest whose reach is that long, or
   * the one that reaches farthest. It rises at once and comes down by the
   * arm's spring over dt seconds.
   */
  #lift(
    solids: SolidLookup,
    a: number,
    distance: number,
    tx: number,
    ty: number,
    tz: number,
    y: number,
    s: number,
    dt: number,
  ): number {
    const e0 = this.view.elevation;
    let want = e0;
    const near = this.#nearReach(solids, e0, a, distance, tx, ty, tz, y, s);
    if (near < Number.POSITIVE_INFINITY) {
      let best = near;
      let found = false;
      for (let k = 1; k <= RISE_STEPS; k++) {
        const e = e0 + ((MAX_ELEVATION - e0) * k) / RISE_STEPS;
        const r = this.#nearReach(solids, e, a, distance, tx, ty, tz, y, s);
        if (r === Number.POSITIVE_INFINITY) {
          want = e;
          found = true;
          break;
        }
        if (r > best) {
          best = r;
          want = e;
        }
      }
      if (!found && best === near) {
        want = e0;
      }
    }
    let rise = this.#rise;
    if (want > e0 && want >= rise) {
      rise = want;
      this.#riseRate = 0;
    } else if (rise > e0) {
      rise = springStep(rise, this.#riseRate, Math.max(want, e0), ARM_OMEGA, dt);
      this.#riseRate = springRate;
      if (want <= e0 && rise - e0 < RISE_DONE) {
        rise = Number.NEGATIVE_INFINITY;
        this.#riseRate = 0;
      }
    } else {
      rise = Number.NEGATIVE_INFINITY;
      this.#riseRate = 0;
    }
    this.#rise = rise;
    return Math.max(rise, e0);
  }

  /** The clear reach of the line at this elevation if it is shorter than SHORTEST (or the line), m; ∞ if not. */
  #nearReach(
    solids: SolidLookup,
    elevation: number,
    a: number,
    distance: number,
    tx: number,
    ty: number,
    tz: number,
    y: number,
    s: number,
  ): number {
    this.#aim(elevation, a, distance, tx, ty, tz, y, s);
    const dx = this.#sx - tx;
    const dy = this.#sy - ty;
    const dz = this.#sz - tz;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const need = Math.min(SHORTEST, length);
    if (!(need > 0)) {
      return Number.POSITIVE_INFINITY;
    }
    const r = this.#clearReach(solids, tx, ty, tz, dx / length, dy / length, dz / length, need);
    return r >= need ? Number.POSITIVE_INFINITY : r;
  }

  /**
   * The arm along the line from the look point (tx, ty, tz) to the camera's
   * point after the shake: it comes in at once to the line's clear reach,
   * and goes back out by its spring over dt seconds. Returns the share of
   * the line the camera stands at: exactly 1 when the arm lets it be.
   */
  #arm(solids: SolidLookup, tx: number, ty: number, tz: number, dt: number): number {
    const dx = this.#sx - tx;
    const dy = this.#sy - ty;
    const dz = this.#sz - tz;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(length > 0)) {
      return 1;
    }
    const clear = this.#clearReach(
      solids,
      tx,
      ty,
      tz,
      dx / length,
      dy / length,
      dz / length,
      length,
    );
    let reach = this.#reach;
    if (clear < reach) {
      reach = clear;
      this.#reachRate = 0;
    } else if (reach < Number.POSITIVE_INFINITY) {
      reach = Math.min(springStep(reach, this.#reachRate, clear, ARM_OMEGA, dt), clear);
      this.#reachRate = springRate;
    }
    if (clear >= length && reach >= length - ARM_DONE) {
      reach = Number.POSITIVE_INFINITY;
      this.#reachRate = 0;
    }
    this.#reach = reach;
    return reach >= length ? 1 : reach / length;
  }

  /**
   * How far along the line from the scene point (lx, ly, lz), the unit
   * (ux, uy, uz), up to length m, every point is clear of the solids by
   * CLEARANCE, m: marched in steps of ARM_STEP at most, the first blocked
   * one halved back toward the last clear. Where the look point itself is
   * nearer a solid than that, as near as it is.
   */
  #clearReach(
    solids: SolidLookup,
    lx: number,
    ly: number,
    lz: number,
    ux: number,
    uy: number,
    uz: number,
    length: number,
  ): number {
    const ceiling = solids.ceiling;
    if (Math.min(ly, ly + uy * length) >= ceiling + CLEARANCE) {
      return length;
    }
    const oe = this.origin?.x ?? 0;
    const on = this.origin?.y ?? 0;
    let r = CLEARANCE;
    while (!solids.clear(lx + oe, on - lz, ly, r)) {
      r /= 2;
      if (r < CLEARANCE / 16) {
        // The look point is in a solid: there is no line to keep clear.
        return length;
      }
    }
    const steps = Math.ceil(length / ARM_STEP);
    let ok = 0;
    for (let i = 1; i <= steps; i++) {
      const t = i === steps ? length : (i * length) / steps;
      const h = ly + uy * t;
      if (h >= ceiling + r && uy >= 0) {
        // Above everything, and rising: clear to the end.
        return length;
      }
      if (!solids.clear(lx + ux * t + oe, on - (lz + uz * t), h, r)) {
        let lo = ok;
        let hi = t;
        for (let k = 0; k < ARM_REFINE; k++) {
          const m = (lo + hi) / 2;
          if (solids.clear(lx + ux * m + oe, on - (lz + uz * m), ly + uy * m, r)) {
            lo = m;
          } else {
            hi = m;
          }
        }
        return lo;
      }
      ok = t;
    }
    return length;
  }
}
