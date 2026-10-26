// SPDX-License-Identifier: AGPL-3.0-only

// The other boats, drawn a little in the past: each is drawn at a render
// tick behind the newest data the page has, between the two samples about
// it, so that a late or lost snapshot still leaves a sample to blend toward
// (Valve, Source Multiplayer Networking; Fiedler, Snapshot Interpolation;
// Gambetta, Entity Interpolation). Boats in the near band, sampled 15
// times a second, are drawn two snapshots behind; those in the far band,
// sampled 5 times, two of theirs. The game connection is TCP, which holds
// everything behind a lost segment for a probe timeout, about two round
// trips (RFC 8985), so the delays grow, up to double, with the measured
// spread of the snapshots' lateness, and shrink back when it settles. A
// boat whose data runs out is carried on its last velocity and turn for a
// moment, then held; when data comes the difference is eased away. Boats
// fade in as they enter the view and out as they leave it, dithered. A
// boat flagged as falling over the lip is drawn falling from the render
// tick of the first sample that flags it (the edge's fallPose), until it
// leaves the view.
//
// Times are world ticks, as floats: 30 a second. Nothing here allocates
// once made.

import { type FallShape, fallPose } from '../edge/over';
import { TICKS_PER_SECOND } from '../net/clock';
import { CHANGE, FLEET_META, SLOT, slotAt, VIEW_SLOTS } from '../net/view';
import { lerpAngle } from '../predict/blend';

/** The near band's delay, ticks: two snapshots at 15 a second, 133 ms. */
export const NEAR_DELAY = 4;
/** The far band's: two of its snapshots at 5 a second, 400 ms. */
export const FAR_DELAY = 12;
/** Past its newest sample a boat is carried on for at most this, ticks: 250 ms. */
export const EXTRAPOLATE = 7.5;
/** The difference a late sample makes is eased away over this, ticks: 100 ms. */
export const EASE = 3;
/** Boats fade in and out over this, ticks: 0.5 s. */
export const FADE = 15;
/** A boat changing band moves between the bands' delays over this, ticks: 1 s. */
export const BAND_CHANGE = 30;
/** The render tick runs at most this much faster or slower than real time. */
export const SLEW = 0.1;
/**
 * The lateness of the snapshots of the last this many ticks sets the
 * delays: 30 s. At 2% loss a stall comes every 3 s or so, but now and
 * then not for 10 s, after which a shorter window would have shrunk the
 * delay just before the next.
 */
export const LATENESS_WINDOW = 900;
/**
 * The most a band's delay grows with the lateness's spread, as a multiple
 * of its base. At 200 ms and 2% loss, TCP holds a snapshot behind a lost
 * segment for about 400 ms (RFC 8985's probe timeout): double the near
 * band's delay and the extrapolation cover it.
 */
export const DELAY_CAP = 2;
/**
 * The lateness's spread is its SPREAD-quantile less its least: the 99th
 * percentile, since a stall holds only the few snapshots behind a lost
 * segment, some 6 of the 450 a 30 s window holds.
 */
export const SPREAD = 0.99;
/** A render tick further than this from where it should be is set at once, ticks. */
const JUMP = 30;

const TICK_US = 1e6 / TICKS_PER_SECOND;

/** A sample's fields, in a boat's ring. */
const F = {
  tick: 0,
  x: 1,
  y: 2,
  heading: 3,
  heel: 4,
  boom: 5,
  rudder: 6,
  sailor: 7,
  mode: 8,
  sail: 9,
  far: 10,
  falling: 11,
} as const;
const FIELDS = 12;
/** Samples kept a boat. */
export const SAMPLES = 8;

/** How a boat is being drawn. */
export const MOTION = { interpolated: 0, extrapolated: 1, held: 2 } as const;

/** A boat's speed is its drawn position's change, smoothed over this long, in seconds. */
export const SPEED_EASE = 0.5;
/** No boat sails faster than this, m/s: a correction drawn at once is not a speed. */
const SPEED_MOST = 12;

/**
 * A boat's speed after a frame in which its drawn position moved `moved`
 * metres in dt seconds, from its speed before: eased toward the frame's
 * own, over SPEED_EASE.
 */
export function smoothedSpeed(before: number, moved: number, dt: number): number {
  if (!(dt > 0)) {
    return before;
  }
  const now = Math.min(moved / dt, SPEED_MOST);
  return before + (now - before) * (1 - Math.exp(-dt / SPEED_EASE));
}

/** A boat as drawn this frame. */
export interface DrawnBoat {
  /** The view slot, or −1 for a boat fading out of it. */
  slot: number;
  kind: number;
  east: number;
  north: number;
  heading: number;
  heel: number;
  /**
   * How the boat floats on the waves drawn under it: its rise, metres, and
   * its pitch, radians, bow up. The server does not send them; float.ts
   * sets them from the sea here.
   */
  heave: number;
  pitch: number;
  /**
   * Its speed, m/s: how fast its drawn position moves, smoothed. The server
   * does not send it; the foam at its hull and its wake are drawn by it.
   */
  speed: number;
  boom: number;
  rudder: number;
  sailor: number;
  mode: number;
  sail: number;
  /** 0 … 1: how far it has faded in. */
  opacity: number;
  /** 0 near … 1 far: where its delay is between the bands'. */
  far: number;
  motion: number;
  /** The render tick it was drawn at, and its newest sample's. */
  tick: number;
  newest: number;
  /** Seconds since it went over the lip, as drawn; below 0 afloat. */
  fall: number;
  /** 1 for a machine sailor's boat, which carries the machine mark; 0 for a human's. */
  machine: number;
}

/** A drawn boat at the origin, faded out. */
export function newDrawnBoat(): DrawnBoat {
  return {
    slot: -1,
    kind: 0,
    east: 0,
    north: 0,
    heading: 0,
    heel: 0,
    heave: 0,
    pitch: 0,
    speed: 0,
    boom: 0,
    rudder: 0,
    sailor: 0,
    mode: 0,
    sail: 0,
    opacity: 0,
    far: 0,
    motion: 0,
    tick: 0,
    newest: 0,
    fall: -1,
    machine: 0,
  };
}

/** One view slot's boat: its samples, oldest first in the ring, and how it is drawn. */
class Boat {
  present = false;
  kind = 0;
  /** 1 while a machine sailor sails it. */
  machine = 0;
  readonly ring = new Float64Array(SAMPLES * FIELDS);
  /** Samples held, and where the next goes. */
  count = 0;
  next = 0;
  /** 0 … 1 faded in. */
  opacity = 0;
  /** 0 near … 1 far. */
  far = 0;
  farTarget = 0;
  /** The difference being eased away: position, heading, and ticks left. */
  dx = 0;
  dy = 0;
  dh = 0;
  ease = 0;
  motion: number = MOTION.interpolated;
  /** The tick of the first sample that has it falling over the lip, or NaN. */
  fallTick = Number.NaN;
  /** The pose drawn last frame. */
  readonly drawn = newDrawnBoat();

  reset(kind: number): void {
    this.present = true;
    this.kind = kind;
    this.machine = 0;
    this.count = 0;
    this.next = 0;
    this.opacity = 0;
    this.ease = 0;
    this.motion = MOTION.interpolated;
    this.fallTick = Number.NaN;
    this.drawn.opacity = 0;
  }

  /** The i-th newest sample's field f; i = 0 is the newest. */
  at(i: number, f: number): number {
    const k = (this.next - 1 - i + SAMPLES) % SAMPLES;
    return this.ring[k * FIELDS + f] ?? 0;
  }

  add(f: Float64Array, o: number, tick: number): void {
    // A sample of a tick already held replaces it: a resync's snapshot.
    if (this.count > 0 && this.at(0, F.tick) >= tick) {
      this.next = (this.next - 1 + SAMPLES) % SAMPLES;
      this.count--;
    }
    const r = this.ring;
    const k = this.next * FIELDS;
    r[k + F.tick] = tick;
    r[k + F.x] = f[o + SLOT.x] ?? 0;
    r[k + F.y] = f[o + SLOT.y] ?? 0;
    r[k + F.heading] = f[o + SLOT.heading] ?? 0;
    r[k + F.heel] = f[o + SLOT.heel] ?? 0;
    r[k + F.boom] = f[o + SLOT.boom] ?? 0;
    r[k + F.rudder] = f[o + SLOT.rudder] ?? 0;
    r[k + F.sailor] = f[o + SLOT.sailor] ?? 0;
    r[k + F.mode] = f[o + SLOT.mode] ?? 0;
    r[k + F.sail] = f[o + SLOT.sail] ?? 0;
    r[k + F.far] = f[o + SLOT.far] ?? 0;
    const falling = f[o + SLOT.falling] ?? 0;
    r[k + F.falling] = falling;
    if (falling === 0) {
      this.fallTick = Number.NaN;
    } else if (Number.isNaN(this.fallTick)) {
      this.fallTick = tick;
    }
    this.next = (this.next + 1) % SAMPLES;
    this.count = Math.min(this.count + 1, SAMPLES);
    this.farTarget = f[o + SLOT.far] ?? 0;
    if (this.count === 1) {
      this.far = this.farTarget;
    }
  }

  /** Sets out to the boat at render tick rt from its samples; returns how it is drawn. */
  pose(rt: number, out: DrawnBoat): number {
    out.kind = this.kind;
    out.machine = this.machine;
    out.tick = rt;
    out.fall = rt >= this.fallTick ? (rt - this.fallTick) / TICKS_PER_SECOND : -1;
    const newest = this.at(0, F.tick);
    out.newest = newest;
    if (this.count === 1 || rt <= this.at(this.count - 1, F.tick)) {
      // Before the oldest sample, or only one: that sample.
      const i = this.count === 1 || rt > newest ? 0 : this.count - 1;
      this.#copy(i, out);
      return this.count === 1 && rt > newest ? MOTION.held : MOTION.interpolated;
    }
    if (rt <= newest) {
      // Between two samples: their blend, angles the shorter way round.
      let i = 0;
      while (i + 1 < this.count && this.at(i + 1, F.tick) > rt) {
        i++;
      }
      const t0 = this.at(i + 1, F.tick);
      const t1 = this.at(i, F.tick);
      const t = t1 > t0 ? (rt - t0) / (t1 - t0) : 1;
      out.east = this.#mix(i, F.x, t);
      out.north = this.#mix(i, F.y, t);
      out.heading = lerpAngle(this.at(i + 1, F.heading), this.at(i, F.heading), t);
      out.heel = lerpAngle(this.at(i + 1, F.heel), this.at(i, F.heel), t);
      out.boom = this.#mix(i, F.boom, t);
      out.rudder = this.#mix(i, F.rudder, t);
      out.sailor = this.#mix(i, F.sailor, t);
      const discrete = t < 0.5 ? i + 1 : i;
      out.mode = this.at(discrete, F.mode);
      out.sail = this.at(discrete, F.sail);
      return MOTION.interpolated;
    }
    // Past the newest: carried on by the last two samples' velocity and
    // turn, for at most EXTRAPOLATE ticks, then held there.
    const ahead = Math.min(rt - newest, EXTRAPOLATE);
    const dt = newest - this.at(1, F.tick);
    this.#copy(0, out);
    if (dt > 0) {
      out.east += ((this.at(0, F.x) - this.at(1, F.x)) / dt) * ahead;
      out.north += ((this.at(0, F.y) - this.at(1, F.y)) / dt) * ahead;
      const turn =
        lerpAngle(this.at(1, F.heading), this.at(0, F.heading), 1) - this.at(1, F.heading);
      out.heading = lerpAngle(out.heading, out.heading + (turn / dt) * ahead, 1);
    }
    return rt - newest > EXTRAPOLATE ? MOTION.held : MOTION.extrapolated;
  }

  /** Field f a fraction t of the way from sample i + 1 to sample i. */
  #mix(i: number, f: number, t: number): number {
    const a = this.at(i + 1, f);
    return a + (this.at(i, f) - a) * t;
  }

  #copy(i: number, out: DrawnBoat): void {
    out.east = this.at(i, F.x);
    out.north = this.at(i, F.y);
    out.heading = this.at(i, F.heading);
    out.heel = this.at(i, F.heel);
    out.boom = this.at(i, F.boom);
    out.rudder = this.at(i, F.rudder);
    out.sailor = this.at(i, F.sailor);
    out.mode = this.at(i, F.mode);
    out.sail = this.at(i, F.sail);
  }
}

/** A band's render tick and delay. */
class Band {
  readonly base: number;
  /** The delay in force, ticks: base, up to double. */
  delay: number;
  /** The tick drawn at; NaN until data has come. */
  tick = Number.NaN;

  constructor(base: number) {
    this.base = base;
    this.delay = base;
  }

  /** Moves the render tick dt ticks on, toward data − delay, never back. */
  advance(data: number, spread: number, dt: number): void {
    this.delay = this.base + Math.min(Math.max(spread, 0), (DELAY_CAP - 1) * this.base);
    const target = data - this.delay;
    if (Number.isNaN(this.tick) || target - this.tick > JUMP || this.tick - target > 3 * JUMP) {
      this.tick = target;
      return;
    }
    // Faster or slower than real time by at most SLEW, never past the
    // target from behind, never backward.
    const ahead = target - (this.tick + dt);
    const step =
      ahead > 0 ? Math.min(dt * (1 + SLEW), dt + ahead) : Math.max(dt * (1 - SLEW), dt + ahead);
    this.tick += Math.max(step, 0);
  }
}

/** What the developer panel shows of the fleet. */
export interface FleetStats {
  near: number;
  far: number;
  extrapolated: number;
  held: number;
  fading: number;
  /** The delays in force, ms. */
  nearDelay: number;
  farDelay: number;
  /** The spread of the snapshots' lateness, ms. */
  spread: number;
  /** Entries a second, of the last second. */
  entries: number;
}

export class Fleet {
  readonly #boats = Array.from({ length: VIEW_SLOTS }, () => new Boat());
  /** Boats fading out of the view, drawn where they were last. */
  readonly #ghosts = Array.from({ length: VIEW_SLOTS }, newDrawnBoat);
  #ghostCount = 0;
  readonly near = new Band(NEAR_DELAY);
  readonly far = new Band(FAR_DELAY);
  /** The snapshots' lateness, µs, and the world ticks they came at: the last LATENESS_WINDOW's. */
  readonly #late = new Float64Array(1024);
  readonly #lateAt = new Float64Array(1024);
  readonly #sorted = new Float64Array(1024);
  #lateN = 0;
  #lateNext = 0;
  /** The least and the spread of the lateness, µs. */
  #least = 0;
  #spread = 0;
  #entries = 0;
  #entriesAt = 0;
  #entriesRate = 0;
  /** World time the latest snapshot came at, µs. */
  arrived = 0;

  /** The boats drawn this frame: drawn[0 … count). */
  readonly drawn: DrawnBoat[] = Array.from({ length: 2 * VIEW_SLOTS }, newDrawnBoat);
  count = 0;
  readonly stats: FleetStats = {
    near: 0,
    far: 0,
    extrapolated: 0,
    held: 0,
    fading: 0,
    nearDelay: 0,
    farDelay: 0,
    spread: 0,
    entries: 0,
  };

  /**
   * Takes a snapshot's record's fleet, its Float64Array, which came at
   * world time arrived, µs.
   */
  add(f: Float64Array, arrived: number): void {
    const tick = f[FLEET_META.tick] ?? 0;
    this.arrived = arrived;
    this.#lateness(arrived - tick * TICK_US, arrived / TICK_US);
    for (let i = 0; i < VIEW_SLOTS; i++) {
      const o = slotAt(i);
      const b = this.#boats[i] as Boat;
      const change = f[o + SLOT.change];
      if (change !== CHANGE.none) {
        this.#entries++;
      }
      if (change === CHANGE.left || (change === CHANGE.entered && b.present)) {
        this.#fadeOut(b);
      }
      if (change === CHANGE.entered) {
        b.reset(f[o + SLOT.kind] ?? 0);
      }
      // Every record carries whose boat the slot holds, sampled or not.
      if (f[o + SLOT.present] === 1 && b.present) {
        b.machine = f[o + SLOT.machine] === 1 ? 1 : 0;
      }
      if (f[o + SLOT.present] === 1 && f[o + SLOT.sampled] === 1 && b.present) {
        b.add(f, o, tick);
      }
    }
  }

  /** Forgets every boat, fading them out: a new connection. */
  clear(): void {
    for (const b of this.#boats) {
      if (b.present) {
        this.#fadeOut(b);
      }
    }
  }

  /**
   * The frame: world is world time now, µs; dt the real time since the
   * last frame, s. Sets drawn and count.
   */
  update(world: number, dt: number): void {
    const dtTicks = dt * TICKS_PER_SECOND;
    if (this.#lateN > 0) {
      const data = (world - this.#least) / TICK_US;
      const spread = this.#spread / TICK_US;
      this.near.advance(data, spread, dtTicks);
      this.far.advance(data, spread, dtTicks);
    }
    const s = this.stats;
    s.near = s.far = s.extrapolated = s.held = 0;
    let n = 0;
    for (let i = 0; i < VIEW_SLOTS; i++) {
      const b = this.#boats[i] as Boat;
      if (!b.present || b.count === 0 || Number.isNaN(this.near.tick)) {
        continue;
      }
      // Toward the band's delay, over BAND_CHANGE.
      const step = dtTicks / BAND_CHANGE;
      b.far += Math.max(-step, Math.min(step, b.farTarget - b.far));
      const rt = this.near.tick + (this.far.tick - this.near.tick) * b.far;
      const out = this.drawn[n++] as DrawnBoat;
      const was = b.motion;
      b.motion = b.pose(rt, out);
      if (was !== MOTION.interpolated && b.motion === MOTION.interpolated) {
        // Data came after the boat was carried on, or held: the jump is
        // eased away rather than drawn at once.
        b.dx = b.drawn.east - out.east;
        b.dy = b.drawn.north - out.north;
        b.dh = lerpAngle(out.heading, b.drawn.heading, 1) - out.heading;
        b.ease = EASE;
      }
      if (b.ease > 0) {
        const k = b.ease / EASE;
        out.east += b.dx * k;
        out.north += b.dy * k;
        out.heading = lerpAngle(out.heading, out.heading + b.dh * k, 1);
        b.ease = Math.max(0, b.ease - dtTicks);
      }
      // New to the view it has no speed yet: nothing was drawn to measure it from.
      out.speed =
        b.drawn.opacity > 0
          ? smoothedSpeed(
              b.drawn.speed,
              Math.hypot(out.east - b.drawn.east, out.north - b.drawn.north),
              dt,
            )
          : 0;
      b.opacity = Math.min(1, b.opacity + dtTicks / FADE);
      out.slot = i;
      out.opacity = b.opacity;
      out.far = b.far;
      out.motion = b.motion;
      copyDrawn(out, b.drawn);
      if (b.farTarget > 0.5) {
        s.far++;
      } else {
        s.near++;
      }
      if (b.motion === MOTION.extrapolated) {
        s.extrapolated++;
      } else if (b.motion === MOTION.held) {
        s.held++;
      }
    }
    // The boats fading out, where they were.
    let g = 0;
    for (let i = 0; i < this.#ghostCount; i++) {
      const ghost = this.#ghosts[i] as DrawnBoat;
      ghost.opacity -= dtTicks / FADE;
      if (ghost.opacity <= 0) {
        continue;
      }
      copyDrawn(ghost, this.#ghosts[g] as DrawnBoat);
      copyDrawn(ghost, this.drawn[n++] as DrawnBoat);
      g++;
    }
    this.#ghostCount = g;
    this.count = n;
    s.fading = g;
    s.nearDelay = (this.near.delay * 1000) / TICKS_PER_SECOND;
    s.farDelay = (this.far.delay * 1000) / TICKS_PER_SECOND;
    s.spread = this.#spread / 1000;
    const now = world / TICK_US;
    if (now - this.#entriesAt >= TICKS_PER_SECOND) {
      this.#entriesRate = (this.#entries * TICKS_PER_SECOND) / Math.max(now - this.#entriesAt, 1);
      this.#entries = 0;
      this.#entriesAt = now;
    }
    s.entries = this.#entriesRate;
  }

  /** Draws the boats falling over the lip as they fall, after the sea has floated them. */
  fall(shape: FallShape | null): void {
    if (shape === null) {
      return;
    }
    for (let i = 0; i < this.count; i++) {
      const b = this.drawn[i] as DrawnBoat;
      if (b.fall >= 0) {
        fallPose(b, b.fall, shape);
      }
    }
  }

  #fadeOut(b: Boat): void {
    if (!b.present) {
      return;
    }
    b.present = false;
    if (b.count === 0 || b.drawn.opacity <= 0 || this.#ghostCount === this.#ghosts.length) {
      return;
    }
    const ghost = this.#ghosts[this.#ghostCount++] as DrawnBoat;
    copyDrawn(b.drawn, ghost);
    ghost.slot = -1;
  }

  /** Notes a snapshot's lateness, µs, at a world tick; keeps the least and the spread up to date. */
  #lateness(late: number, at: number): void {
    const cap = this.#late.length;
    this.#late[this.#lateNext] = late;
    this.#lateAt[this.#lateNext] = at;
    this.#lateNext = (this.#lateNext + 1) % cap;
    this.#lateN = Math.min(this.#lateN + 1, cap);
    let n = 0;
    for (let i = 0; i < this.#lateN; i++) {
      if (at - (this.#lateAt[i] ?? 0) <= LATENESS_WINDOW) {
        this.#sorted[n++] = this.#late[i] ?? 0;
      }
    }
    const v = this.#sorted.subarray(0, n).sort();
    this.#least = v[0] ?? late;
    this.#spread = (v[Math.min(n - 1, Math.ceil(SPREAD * n) - 1)] ?? late) - this.#least;
  }
}

function copyDrawn(a: DrawnBoat, b: DrawnBoat): void {
  b.slot = a.slot;
  b.kind = a.kind;
  b.east = a.east;
  b.north = a.north;
  b.heading = a.heading;
  b.heel = a.heel;
  b.heave = a.heave;
  b.pitch = a.pitch;
  b.speed = a.speed;
  b.boom = a.boom;
  b.rudder = a.rudder;
  b.sailor = a.sailor;
  b.mode = a.mode;
  b.sail = a.sail;
  b.opacity = a.opacity;
  b.far = a.far;
  b.motion = a.motion;
  b.tick = a.tick;
  b.newest = a.newest;
  b.fall = a.fall;
  b.machine = a.machine;
}
