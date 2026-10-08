// SPDX-License-Identifier: AGPL-3.0-only

// The helm under a thumb. A horizontal drag sets the helm relative to where
// the thumb lands, so a touch never jumps it, and a thumb can steer
// wherever it lands without looking. Dragging left turns the bow to port,
// whatever the boat steers with. A double tap centres the helm. When the
// thumb lifts, the helm stays where it was left, or, with the setting,
// returns to the centre.

/** A drag of this many CSS pixels moves the helm over its full travel, hard to port to hard to starboard. */
export const HELM_TRAVEL = 140;
/** Two taps within this many milliseconds are a double tap. */
export const DOUBLE_TAP_MS = 300;
/** A press shorter than this, in milliseconds, that moves less than TAP_SLOP is a tap. */
const TAP_MS = 250;
const TAP_SLOP = 8;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** One pointer's relative drag along one axis. */
export class Drag {
  /** The pointer that owns the control, or null. */
  pointer: number | null = null;
  #from = 0;
  #value = 0;
  #at = 0;
  #moved = 0;

  begin(pointer: number, position: number, value: number, time: number): void {
    this.pointer = pointer;
    this.#from = position;
    this.#value = value;
    this.#at = time;
    this.#moved = 0;
  }

  /** The value for the pointer at position, scale the value per pixel. */
  value(position: number, scale: number): number {
    this.#moved = Math.max(this.#moved, Math.abs(position - this.#from));
    return this.#value + (position - this.#from) * scale;
  }

  /** Ends the drag; whether it was a tap. */
  end(time: number): boolean {
    this.pointer = null;
    return time - this.#at < TAP_MS && this.#moved < TAP_SLOP;
  }
}

export class HelmInput {
  /** The helm the player asks for, −1 hard to port … 1 hard to starboard. */
  target = 0;
  /** Return the helm to the centre when the thumb lifts. */
  centreOnRelease = false;

  readonly #drag = new Drag();
  #lastTap = Number.NEGATIVE_INFINITY;

  /** Whether a pointer holds the helm. */
  get held(): boolean {
    return this.#drag.pointer !== null;
  }

  /** A pointer lands at x, in CSS pixels, at time t in milliseconds. Returns whether the helm took it. */
  down(pointer: number, x: number, t: number): boolean {
    if (this.#drag.pointer !== null) {
      return false;
    }
    if (t - this.#lastTap < DOUBLE_TAP_MS) {
      this.target = 0;
      this.#lastTap = Number.NEGATIVE_INFINITY;
    }
    this.#drag.begin(pointer, x, this.target, t);
    return true;
  }

  move(pointer: number, x: number): void {
    if (pointer !== this.#drag.pointer) {
      return;
    }
    this.target = clamp(this.#drag.value(x, 2 / HELM_TRAVEL), -1, 1);
  }

  up(pointer: number, t: number): void {
    if (pointer !== this.#drag.pointer) {
      return;
    }
    if (this.#drag.end(t)) {
      this.#lastTap = t;
    }
    if (this.centreOnRelease) {
      this.target = 0;
    }
  }

  centre(): void {
    this.target = 0;
  }
}
