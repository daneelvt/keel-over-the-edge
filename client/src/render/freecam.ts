// SPDX-License-Identifier: AGPL-3.0-only

// The free camera: the owner's, and anyone's in the sandbox. Detached from
// the boat, it flies anywhere over the disk and up to 500 m beyond its lip,
// from 2 m to 500 m above the sea and never into the land held under it,
// while the boat stays where it was. The keyboard flies it level (W A S D
// or the arrows, Q and E down and up, Shift three times faster) and the
// mouse dragged turns it to look; on a phone one finger looks, two fingers
// fly it over the water, and a pinch climbs and descends. Its speed rises
// with its height, from 10 m/s near the water to 150 m/s at the top, and
// the wheel scales it. A flick of two fingers glides on and dies away,
// unless motion is reduced. The scene follows the point beneath it, so the
// sea, the land and the sky's dome are drawn about it, not about the boat.

import { type ScenePoint, worldToScene } from './coords';

/** How far it roams: metres past the lip, and its lowest and highest above the sea. */
export const ROAM_BEYOND = 500;
export const ROAM_LOW = 2;
export const ROAM_HIGH = 500;
/** Its speed at its lowest and at its highest, m/s; Shift's factor. */
export const FLY_LOW = 10;
export const FLY_HIGH = 150;
export const FLY_FAST = 3;
/** Radians a CSS pixel of drag turns it. */
const LOOK_SCALE = 0.004;
/** How far it may look down and up, radians. */
const LOOK_DOWN = -1.5;
const LOOK_UP = 1.2;
/** A glide's time constant, s. */
const GLIDE_TIME = 0.5;
/** Metres a CSS pixel of two fingers' drag flies it, at 1 m/s of speed. */
const PAN_SCALE = 0.02;
/** How far the server may be told it moved, at most, before it is told again: m, and s. */
export const ROAM_EVERY_METRES = 20;
export const ROAM_EVERY_SECONDS = 0.2;

/** Its speed at height h above the sea, m/s: from FLY_LOW to FLY_HIGH, growing in proportion. */
export function flySpeed(h: number): number {
  const t = Math.min(Math.max((h - ROAM_LOW) / (ROAM_HIGH - ROAM_LOW), 0), 1);
  return FLY_LOW * (FLY_HIGH / FLY_LOW) ** t;
}

/** The keys that fly it, held or not. */
export interface FlyKeys {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  fast: boolean;
}

export class FreeCamera {
  /** Whether it flies: the scene follows it and not the boat. */
  on = false;
  /** Where it is: metres east and north of the centre, and up from the sea. */
  east = 0;
  north = 0;
  height = 50;
  /** Where it looks: a bearing clockwise from north, and up from level, radians. */
  yaw = 0;
  pitch = -0.3;
  /** The wheel's factor on its speed. */
  factor = 1;
  reducedMotion = false;
  /** The lip of the disk, m from the centre. */
  lip = 8334;
  readonly keys: FlyKeys = {
    forward: false,
    back: false,
    left: false,
    right: false,
    up: false,
    down: false,
    fast: false,
  };
  /** The ground's height under a point, m, or null where none is known: it keeps 2 m above it. */
  ground: ((east: number, north: number) => number | null) | null = null;
  /** A glide, m/s east and north, and climbing. */
  readonly #glide = { east: 0, north: 0, up: 0 };

  /** Starts it flying from a camera at this world point looking this way. */
  enter(east: number, north: number, height: number, yaw: number, pitch: number): void {
    this.on = true;
    this.east = east;
    this.north = north;
    this.height = height;
    this.yaw = yaw;
    this.pitch = Math.min(Math.max(pitch, LOOK_DOWN), LOOK_UP);
    this.stop();
    this.#clamp();
  }

  /** Stops it flying: the scene follows the boat again. */
  leave(): void {
    this.on = false;
    this.stop();
    for (const k of Object.keys(this.keys) as (keyof FlyKeys)[]) {
      this.keys[k] = false;
    }
  }

  /** Ends any glide. */
  stop(): void {
    this.#glide.east = 0;
    this.#glide.north = 0;
    this.#glide.up = 0;
  }

  /** Turns it to look by a drag of dx, dy CSS pixels. */
  look(dx: number, dy: number): void {
    this.yaw = (this.yaw + dx * LOOK_SCALE) % (2 * Math.PI);
    this.pitch = Math.min(Math.max(this.pitch - dy * LOOK_SCALE, LOOK_DOWN), LOOK_UP);
  }

  /**
   * Flies it by two fingers' drag of dx, dy CSS pixels over dt seconds:
   * the water is pushed as a map is, at its speed; dt keeps the glide.
   */
  pan(dx: number, dy: number, dt: number): void {
    const k = PAN_SCALE * flySpeed(this.height) * this.factor;
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    // Dragging up flies forward; dragging right flies left.
    const fwd = dy * k;
    const side = -dx * k;
    const de = s * fwd + c * side;
    const dn = c * fwd - s * side;
    this.east += de;
    this.north += dn;
    if (dt > 0 && !this.reducedMotion) {
      this.#glide.east = de / dt;
      this.#glide.north = dn / dt;
    }
    this.#clamp();
  }

  /** Climbs (factor below 1, fingers apart) or descends (above 1) by a pinch. */
  pinch(factor: number): void {
    if (factor > 0 && Number.isFinite(factor)) {
      this.height /= factor;
      this.#clamp();
    }
  }

  /** Scales its speed by the wheel. */
  wheel(deltaY: number): void {
    this.factor = Math.min(Math.max(this.factor * Math.exp(-deltaY * 0.002), 0.1), 10);
  }

  /** Flies it for dt seconds of the keys held and any glide. */
  update(dt: number): void {
    if (!this.on || !(dt > 0)) {
      return;
    }
    dt = Math.min(dt, 0.25);
    const k = this.keys;
    const speed = flySpeed(this.height) * this.factor * (k.fast ? FLY_FAST : 1);
    const fwd = (k.forward ? 1 : 0) - (k.back ? 1 : 0);
    const side = (k.right ? 1 : 0) - (k.left ? 1 : 0);
    const up = (k.up ? 1 : 0) - (k.down ? 1 : 0);
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    const g = this.#glide;
    this.east += (s * fwd + c * side) * speed * dt + g.east * dt;
    this.north += (c * fwd - s * side) * speed * dt + g.north * dt;
    this.height += up * speed * dt + g.up * dt;
    const decay = Math.exp(-dt / GLIDE_TIME);
    g.east *= decay;
    g.north *= decay;
    g.up *= decay;
    this.#clamp();
  }

  #clamp(): void {
    const most = this.lip + ROAM_BEYOND;
    const r = Math.hypot(this.east, this.north);
    if (r > most) {
      this.east *= most / r;
      this.north *= most / r;
    }
    const under = this.ground?.(this.east, this.north) ?? null;
    const low = Math.max(ROAM_LOW, (under ?? 0) + ROAM_LOW);
    this.height = Math.min(Math.max(this.height, low), ROAM_HIGH);
  }

  /**
   * Writes its position, relative to the floating origin at world (ox, oy),
   * and the point it looks at, into the scene's position and target.
   */
  place(
    ox: number,
    oy: number,
    position: ScenePoint & { set(x: number, y: number, z: number): unknown },
    target: { set(x: number, y: number, z: number): unknown },
  ): void {
    const p = worldToScene(this.east - ox, this.north - oy, this.height, this.#at);
    position.set(p.x, p.y, p.z);
    const cp = Math.cos(this.pitch);
    // East is the scene's x, north its −z.
    target.set(
      p.x + Math.sin(this.yaw) * cp,
      p.y + Math.sin(this.pitch),
      p.z - Math.cos(this.yaw) * cp,
    );
  }

  readonly #at: ScenePoint = { x: 0, y: 0, z: 0 };
}

/**
 * What the server is told of the free camera, and when: as it leaves the
 * boat, then at most every ROAM_EVERY_SECONDS once it has moved
 * ROAM_EVERY_METRES, and as it comes back.
 */
export class RoamTeller {
  #told = false;
  #east = Number.NaN;
  #north = Number.NaN;
  #height = Number.NaN;
  #at = Number.NEGATIVE_INFINITY;

  /** Says, at now (s), what to tell the server of cam, if anything: on, or off. */
  tell(
    cam: FreeCamera,
    now: number,
    send: (on: boolean, east: number, north: number, height: number) => void,
  ): void {
    if (!cam.on) {
      if (this.#told) {
        this.#told = false;
        this.#east = Number.NaN;
        send(false, 0, 0, 0);
      }
      return;
    }
    const moved = Math.hypot(
      cam.east - this.#east,
      cam.north - this.#north,
      cam.height - this.#height,
    );
    if (this.#told && (moved < ROAM_EVERY_METRES || now - this.#at < ROAM_EVERY_SECONDS)) {
      return;
    }
    this.#told = true;
    this.#east = cam.east;
    this.#north = cam.north;
    this.#height = cam.height;
    this.#at = now;
    send(true, cam.east, cam.north, cam.height);
  }
}
