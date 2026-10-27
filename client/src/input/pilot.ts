// SPDX-License-Identifier: AGPL-3.0-only

// The autopilot's control as the player holds it, in the whole numbers the
// wire carries: its mode, what it holds in 65536ths of a turn, the order
// count and the way of the latest order. The physics module steers by them
// on the phone and on the server alike, so the boat on the autopilot is
// predicted like any other. Switched on, it holds the angle the boat is at
// to the mean wind, on the tack it is on; the compass mode holds the
// heading. A tack or a gybe mirrors what it holds onto the other tack and
// counts an order, which the step takes once. A turn that stalls leaves the
// boat held on its old tack, its target still on the other: ordered again,
// it tries for that target.

/** The autopilot's modes and ways, as the physics module's control has them. */
export const PILOT_OFF = 0;
export const PILOT_WIND = 1;
export const PILOT_HEADING = 2;
export const WAY_HOLD = 0;
export const WAY_TACK = 1;
export const WAY_GYBE = 2;
/** A tack or a gybe that stalled: the step holds the angle the boat turned from until the next order. Never an order's way. */
export const WAY_TACK_STALLED = 3;
export const WAY_GYBE_STALLED = 4;
/** Steps in a whole turn of a target. */
export const TURN_STEPS = 65536;
/** How many values the order count takes. */
const ORDERS = 4;

const DEG = Math.PI / 180;

/** a wrapped to [−π, π). */
export function wrapAngle(a: number): number {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI;
}

/** An angle, radians, as a target's whole steps of a turn, 0 … 65535. */
export function stepsOf(a: number): number {
  const k = Math.round((a / (2 * Math.PI)) * TURN_STEPS) % TURN_STEPS;
  return k < 0 ? k + TURN_STEPS : k;
}

/** A target's steps as an angle, radians, in [−π, π). */
export function angleOf(steps: number): number {
  return wrapAngle((steps / TURN_STEPS) * 2 * Math.PI);
}

/** What a step of the autopilot reads: the player's control, as the wire carries it. */
export interface PilotControl {
  readonly mode: number;
  readonly target: number;
  readonly order: number;
  readonly way: number;
}

/** A pilot control that is off. */
export const PILOT_IDLE: PilotControl = { mode: PILOT_OFF, target: 0, order: 0, way: WAY_HOLD };

export class PilotInput implements PilotControl {
  mode = PILOT_OFF;
  target = 0;
  order = 0;
  way = WAY_HOLD;
  /**
   * The least angle off the wind the dial and the keys set in wind mode,
   * radians: the boat's close-hauled course less a margin.
   */
  least = 35 * DEG;

  get on(): boolean {
    return this.mode !== PILOT_OFF;
  }

  /** Off: everything back to zero, so nothing is sent for it. */
  off(): void {
    this.mode = PILOT_OFF;
    this.target = 0;
    this.order = 0;
    this.way = WAY_HOLD;
  }

  /**
   * Switches it on in mode, holding what the boat does now: in wind mode its
   * angle to the mean wind (from meanFrom, radians) on its tack, kept within
   * what the dial sets; in heading mode its heading.
   */
  engage(mode: number, heading: number, meanFrom: number): void {
    if (this.mode === PILOT_OFF) {
      this.order = 0;
      this.way = WAY_HOLD;
    }
    this.mode = mode === PILOT_HEADING ? PILOT_HEADING : PILOT_WIND;
    this.target =
      this.mode === PILOT_WIND
        ? stepsOf(this.#limit(wrapAngle(meanFrom - heading)))
        : stepsOf(wrapAngle(heading));
  }

  /** Copies another control: the server's in force, on a new connection. */
  set(c: PilotControl): void {
    this.mode = c.mode;
    this.target = c.target;
    this.order = c.order;
    this.way = c.way;
  }

  /**
   * Turns what it holds by degrees of heading: positive to starboard. In
   * wind mode the angle stays on its side, from the least the dial sets to
   * dead downwind.
   */
  adjust(degrees: number): void {
    if (this.mode === PILOT_HEADING) {
      this.target = stepsOf(angleOf(this.target) + degrees * DEG);
    } else if (this.mode === PILOT_WIND) {
      // The angle off the wind falls as the bow turns to starboard.
      const a = angleOf(this.target);
      this.target = stepsOf(this.#limit(a - degrees * DEG, a));
    }
  }

  /**
   * Orders a tack. After a turn stalled, left is the angle off the wind
   * the step holds instead (State.PilotLeft), and the tack is for the
   * other side from it; null while none has.
   */
  tack(meanFrom: number, left: number | null = null): void {
    this.#turn(WAY_TACK, meanFrom, left);
  }

  /** Orders a gybe; left as for a tack. */
  gybe(meanFrom: number, left: number | null = null): void {
    this.#turn(WAY_GYBE, meanFrom, left);
  }

  /**
   * Follows the autopilot onto the boat's new tack when it holds its angle
   * there: after the boat gybed by itself, or when a heading across dead
   * downwind is held mirrored. steering is the heading the step steered
   * for (Out's pilotHeading), turning whether a turn it was ordered is
   * still under way or stalled, when the step holds something other than
   * the target. Returns whether the target changed.
   */
  follow(steering: number, meanFrom: number, turning: boolean): boolean {
    if (this.mode === PILOT_OFF || turning) {
      return false;
    }
    if (this.mode === PILOT_WIND) {
      const held = wrapAngle(meanFrom - steering);
      const want = angleOf(this.target);
      if (
        Math.sign(held) === Math.sign(want) ||
        Math.abs(Math.abs(held) - Math.abs(want)) > 0.5 * DEG
      ) {
        return false;
      }
      this.target = stepsOf(-want);
      return true;
    }
    const want = angleOf(this.target);
    // Mirrored about the wind: the heading it holds on the other tack.
    const mirrored = wrapAngle(2 * meanFrom - want);
    if (
      Math.abs(wrapAngle(steering - want)) < 1 * DEG ||
      Math.abs(wrapAngle(steering - mirrored)) > 1 * DEG
    ) {
      return false;
    }
    this.target = stepsOf(steering);
    return true;
  }

  /** What it holds, in degrees: the angle off the wind, positive over starboard; or the heading, 0 … 359. */
  get degrees(): number {
    const d = Math.round((this.target / TURN_STEPS) * 360) % 360;
    if (this.mode === PILOT_HEADING) {
      return d;
    }
    return d > 180 ? d - 360 : d;
  }

  #turn(way: number, meanFrom: number, left: number | null): void {
    if (this.mode === PILOT_OFF) {
      return;
    }
    this.way = way;
    this.order = (this.order + 1) % ORDERS;
    if (left !== null) {
      // Held where a turn stalled: a target already on the other side from
      // there is kept, and tried for again.
      const a =
        this.mode === PILOT_WIND
          ? angleOf(this.target)
          : wrapAngle(meanFrom - angleOf(this.target));
      if (Math.sign(a) !== Math.sign(left)) {
        return;
      }
    }
    this.target =
      this.mode === PILOT_WIND
        ? stepsOf(-angleOf(this.target))
        : stepsOf(2 * meanFrom - angleOf(this.target));
  }

  /**
   * An angle off the wind within the dial's range, on the side was is on:
   * moved past dead downwind it stays there, toward the wind it stops at
   * the least.
   */
  #limit(a: number, was = a): number {
    const side = was < 0 ? -1 : 1;
    const m = Math.sign(a) === side || a === 0 ? Math.abs(a) : 0;
    return side * Math.min(Math.max(m, this.least), Math.PI);
  }
}

/** What the keys and the dial ask of the game's autopilot. */
export interface PilotActions {
  readonly pilot: PilotInput;
  /** Switches it on in wind mode at the boat's angle to the wind, or off. */
  togglePilot(): void;
  /** Switches it on in a mode, holding what the boat does now. */
  engagePilot(mode: number): void;
  /** Takes the helm back: the autopilot off, the helm where it left it. */
  takeHelm(): void;
  pilotTack(): void;
  pilotGybe(): void;
  /** Turns what it holds by degrees of heading, positive to starboard. */
  pilotAdjust(degrees: number): void;
  /** Switches between holding an angle to the wind and a heading, at what the boat does now. */
  pilotMode(): void;
}
