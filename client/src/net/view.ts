// SPDX-License-Identifier: AGPL-3.0-only

// The other boats a player sees, as shared/protocol/snapshot.txt lays them
// out: a view of up to 64 boats, each quantised, sent as entries that
// change the view of a base snapshot the client still holds. The net
// worker keeps the last few views it decoded, applies each snapshot's
// entries to a copy of its base's, and hands the page the result in metres
// and radians, in a record of typed arrays it reuses. internal/protocol's
// view.go is the server's side, and its tests write the vectors these are
// tested against.

import { FAR_SAMPLED, headerLengthOf, MAX_HEADER_SIZE, type OwnSnapshot } from './snapshot';

/** The most boats a view holds. */
export const VIEW_SLOTS = 64;

/** A boat's quantised fields, in a view's Int32Array, VIEW_STRIDE apart. */
export const Q = {
  kind: 0,
  flags: 1,
  x: 2,
  y: 3,
  heading: 4,
  heel: 5,
  boom: 6,
  rudder: 7,
  sailor: 8,
  sail: 9,
  /** The sailor's look code, which only an enter carries. */
  look: 10,
  /** The rig: the headsails' clew, the after yards, the fore yards less the after, in angle steps; 0 without. */
  jib: 11,
  yards: 12,
  fore: 13,
  /** The boat's own look code, its paint, cloth and sail number, which only an enter carries. */
  boatLook: 14,
  /** The downwind sail: its clew in angle steps while it is hoisted at all, and its hoist, 0 … 255; 0 without. */
  kite: 15,
  hoist: 16,
} as const;
export const VIEW_STRIDE = 17;

/**
 * A boat's flags: in the far band; the sailor's mode is bits 1–2; falling
 * over the lip; a machine sailor's, sailed by an AI agent; in an enter,
 * the same boat in its sailor's new look; and the reef, rounded to a
 * level, in bits 6–7.
 */
export const FAR_BAND = 1;
export const FALLING = 8;
export const MACHINE = 16;
/** In an enter: the boat the slot already holds, its sailor's look, its own look or its kind changed. */
export const RELOOK = 32;
/** The reef's place in the flags: 0 full sail, 1 or 2; 3 is refused. */
export const REEF_SHIFT = 6;
const MAX_REEF = 2;

/** The hoist's steps: 255 is set. */
export const HOIST_STEPS = 255;
/** The steps of the fields: the heading's, heel's, boom's and rudder's, and the position's. */
export const ANGLE_STEP = (2 * Math.PI) / 65536;
export const POSITION_STEP = 0.01;
const POSITION_LIMIT = 2 ** 23 - 1;

/** What an entry did to a view slot, in a snapshot's changes. */
export const CHANGE = { none: 0, entered: 1, updated: 2, left: 3 } as const;

const OP_UPDATE = 0;
const OP_ENTER = 1;
const OP_LEAVE = 2;
/** An update whose change mask has a second byte, for the rig's fields. */
const OP_UPDATE_RIG = 3;

/** An enter's kind is its kind × RIG_KINDS plus which rig fields follow: 1 the jib, 2 the yards, 4 the fore yards, 8 the downwind sail's clew, 16 its hoist. */
const RIG_KINDS = 32;
/** The rig's two-byte fields, in their order after an enter's and in an update's second mask byte; the hoist, one byte, after them. */
const RIG_FIELDS = [Q.jib, Q.yards, Q.fore, Q.kite] as const;
/** The hoist's bit among the rig's. */
const RIG_HOIST = 1 << RIG_FIELDS.length;

/** The boats a player sees after a snapshot, as the wire carries them. */
export class View {
  tick = 0;
  /** 1 where the slot holds a boat. */
  readonly used = new Uint8Array(VIEW_SLOTS);
  readonly q = new Int32Array(VIEW_SLOTS * VIEW_STRIDE);

  copyFrom(o: View): void {
    this.tick = o.tick;
    this.used.set(o.used);
    this.q.set(o.q);
  }

  clear(): void {
    this.used.fill(0);
    this.q.fill(0);
  }

  get length(): number {
    let n = 0;
    for (let i = 0; i < VIEW_SLOTS; i++) {
      n += this.used[i] ?? 0;
    }
    return n;
  }
}

/** A reader of a snapshot's entries, keeping its place. */
class Reader {
  at: number;
  constructor(
    readonly v: DataView,
    at: number,
  ) {
    this.at = at;
  }

  left(): number {
    return this.v.byteLength - this.at;
  }

  byte(): number {
    if (this.at >= this.v.byteLength) {
      throw new EntryError('an entry cut short');
    }
    return this.v.getUint8(this.at++);
  }

  /** A uvarint written in as few bytes as it needs; too long a one is refused. */
  uvarint(): number {
    let v = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      const b = this.byte();
      if (i === 9 && b > 1) {
        throw new EntryError('a varint too long');
      }
      v += (b & 0x7f) * scale;
      if ((b & 0x80) === 0) {
        if (i > 0 && b === 0) {
          throw new EntryError('a varint written longer than it need be');
        }
        return v;
      }
      scale *= 128;
    }
    throw new EntryError('a varint too long');
  }

  /** A zigzag varint. Values beyond 2⁵³ are not exact, but always out of any position's range. */
  varint(): number {
    const u = this.uvarint();
    const half = Math.floor(u / 2);
    return u % 2 === 0 ? half : -half - 1;
  }
}

class EntryError extends Error {}

/** An enter's length after its kind and look, the rig's fields aside. */
const ENTER_FIELDS = 17;

/** Whether a boat's flags are refused: a reef of 3. */
function badFlags(flags: number): boolean {
  return flags >> REEF_SHIFT > MAX_REEF;
}

function int24(v: DataView, at: number): number {
  return ((v.getUint8(at) | (v.getUint8(at + 1) << 8) | (v.getUint8(at + 2) << 16)) << 8) >> 8;
}

/**
 * Applies a snapshot's n entries, starting at byte at of v, to view, which
 * holds the view of the snapshot's base (empty for none), and notes in
 * changes what each did to each slot. Returns an error's text, or null; an
 * error leaves the view part changed.
 */
export function applyEntries(
  v: DataView,
  at: number,
  n: number,
  view: View,
  changes: Uint8Array,
): string | null {
  changes.fill(CHANGE.none);
  const r = new Reader(v, at);
  const q = view.q;
  try {
    for (let k = 0; k < n; k++) {
      const head = r.byte();
      const slot = head & 63;
      const op = head >> 6;
      const o = slot * VIEW_STRIDE;
      switch (op) {
        case OP_LEAVE:
          if (view.used[slot] === 0) {
            return `a leave of empty view slot ${slot}`;
          }
          view.used[slot] = 0;
          q.fill(0, o, o + VIEW_STRIDE);
          changes[slot] = CHANGE.left;
          break;
        case OP_ENTER: {
          const kindRig = r.uvarint();
          const kind = Math.floor(kindRig / RIG_KINDS);
          const rig = kindRig % RIG_KINDS;
          if (kind > 65535) {
            return `a boat of kind ${kind}`;
          }
          const look = r.uvarint();
          if (look >= 2 ** 20) {
            return `a sailor's look ${look}`;
          }
          const boatLook = r.uvarint();
          if (boatLook >= 2 ** 22) {
            return `a boat's look ${boatLook}`;
          }
          if (r.left() < ENTER_FIELDS) {
            return 'an entry cut short';
          }
          const b = r.at;
          const flags = v.getUint8(b);
          if (badFlags(flags)) {
            return 'a boat with flags it should not have';
          }
          q[o + Q.kind] = kind;
          q[o + Q.look] = look;
          q[o + Q.boatLook] = boatLook;
          q[o + Q.flags] = flags;
          q[o + Q.x] = int24(v, b + 1);
          q[o + Q.y] = int24(v, b + 4);
          q[o + Q.heading] = v.getUint16(b + 7, true);
          q[o + Q.heel] = v.getInt16(b + 9, true);
          q[o + Q.boom] = v.getInt16(b + 11, true);
          q[o + Q.rudder] = v.getInt16(b + 13, true);
          q[o + Q.sailor] = v.getInt8(b + 15);
          q[o + Q.sail] = v.getUint8(b + 16);
          r.at += ENTER_FIELDS;
          for (let i = 0; i < RIG_FIELDS.length; i++) {
            let value = 0;
            if ((rig & (1 << i)) !== 0) {
              value = ((r.byte() | (r.byte() << 8)) << 16) >> 16;
              if (value === 0) {
                return "an enter's rig field of 0 sent";
              }
            }
            q[o + (RIG_FIELDS[i] as number)] = value;
          }
          let hoist = 0;
          if ((rig & RIG_HOIST) !== 0) {
            hoist = r.byte();
            if (hoist === 0) {
              return "an enter's rig field of 0 sent";
            }
          }
          q[o + Q.hoist] = hoist;
          view.used[slot] = 1;
          changes[slot] = CHANGE.entered;
          break;
        }
        case OP_UPDATE:
        case OP_UPDATE_RIG: {
          let m = r.byte();
          if (op === OP_UPDATE_RIG) {
            const rigMask = r.byte();
            if (rigMask === 0 || rigMask >= 2 * RIG_HOIST) {
              return `a rig's update of mask ${rigMask}`;
            }
            m |= rigMask << 8;
          }
          if (m === 0) {
            return 'an update of nothing';
          }
          if (view.used[slot] === 0) {
            return `an update of empty view slot ${slot}`;
          }
          if ((m & 1) !== 0) {
            const x = (q[o + Q.x] ?? 0) + r.varint();
            const y = (q[o + Q.y] ?? 0) + r.varint();
            if (
              x < -POSITION_LIMIT - 1 ||
              x > POSITION_LIMIT ||
              y < -POSITION_LIMIT - 1 ||
              y > POSITION_LIMIT
            ) {
              return `view slot ${slot} moved beyond 24 bits`;
            }
            q[o + Q.x] = x;
            q[o + Q.y] = y;
          }
          if ((m & 2) !== 0) {
            q[o + Q.heading] = r.byte() | (r.byte() << 8);
          }
          if ((m & 4) !== 0) {
            q[o + Q.heel] = ((r.byte() | (r.byte() << 8)) << 16) >> 16;
          }
          if ((m & 8) !== 0) {
            q[o + Q.boom] = ((r.byte() | (r.byte() << 8)) << 16) >> 16;
          }
          if ((m & 16) !== 0) {
            q[o + Q.rudder] = ((r.byte() | (r.byte() << 8)) << 16) >> 16;
          }
          if ((m & 32) !== 0) {
            q[o + Q.sailor] = (r.byte() << 24) >> 24;
          }
          if ((m & 64) !== 0) {
            q[o + Q.sail] = r.byte();
          }
          if ((m & 128) !== 0) {
            const flags = r.byte();
            if (badFlags(flags)) {
              return 'a boat with flags it should not have';
            }
            q[o + Q.flags] = flags;
          }
          for (let i = 0; i < RIG_FIELDS.length; i++) {
            if ((m & (256 << i)) !== 0) {
              q[o + (RIG_FIELDS[i] as number)] = ((r.byte() | (r.byte() << 8)) << 16) >> 16;
            }
          }
          if ((m & (256 * RIG_HOIST)) !== 0) {
            q[o + Q.hoist] = r.byte();
          }
          if (changes[slot] !== CHANGE.entered) {
            changes[slot] = CHANGE.updated;
          }
          break;
        }
      }
    }
  } catch (e) {
    if (e instanceof EntryError) {
      return e.message;
    }
    throw e;
  }
  if (r.left() > 0) {
    return `${r.left()} bytes after a snapshot's last entry`;
  }
  return null;
}

/**
 * Marks in out the slots a snapshot samples, from the view after it, its
 * flags and what its entries did: the boats in the near band, those with an
 * entry, and, when its flags say so, those in the far band.
 */
export function sampled(view: View, flags: number, changes: Uint8Array, out: Uint8Array): void {
  const far = (flags & FAR_SAMPLED) !== 0;
  for (let i = 0; i < VIEW_SLOTS; i++) {
    const c = changes[i];
    out[i] =
      view.used[i] === 1 &&
      (far ||
        c === CHANGE.entered ||
        c === CHANGE.updated ||
        ((view.q[i * VIEW_STRIDE + Q.flags] ?? 0) & FAR_BAND) === 0)
        ? 1
        : 0;
  }
}

/** How many decoded views the worker keeps, to find a snapshot's base among. */
export const VIEWS_KEPT = 4;

/**
 * The views a connection's snapshots made, the newest VIEWS_KEPT, made
 * once and reused.
 */
export class ViewRing {
  readonly #views = Array.from({ length: VIEWS_KEPT + 1 }, () => new View());
  #have = 0;
  #next = 0;
  readonly changes = new Uint8Array(VIEW_SLOTS);
  readonly sampled = new Uint8Array(VIEW_SLOTS);

  /** Forgets every view: a new connection starts from a full snapshot. */
  reset(): void {
    this.#have = 0;
  }

  /**
   * Decodes a snapshot whose header is sn, its bytes in v: its entries
   * applied to a copy of its base's view. Returns the view, which stays
   * valid until VIEWS_KEPT more are decoded; 'missing' if its base is not
   * among those kept (it must be dropped and resync asked for); or an
   * error's text.
   */
  decode(v: DataView, sn: OwnSnapshot): View | 'missing' | string {
    const out = this.#views[this.#next] as View;
    if (sn.base === 0) {
      out.clear();
    } else {
      const base = this.#find(sn.tick - sn.base);
      if (base === null) {
        return 'missing';
      }
      out.copyFrom(base);
    }
    const err = applyEntries(v, sn.header, sn.entries, out, this.changes);
    if (err !== null) {
      return err;
    }
    out.tick = sn.tick;
    sampled(out, sn.flags, this.changes, this.sampled);
    this.#next = (this.#next + 1) % this.#views.length;
    this.#have = Math.min(this.#have + 1, VIEWS_KEPT);
    return out;
  }

  #find(tick: number): View | null {
    // The kept views are the #have before #next.
    for (let k = 1; k <= this.#have; k++) {
      const i = (this.#next - k + this.#views.length) % this.#views.length;
      const view = this.#views[i] as View;
      if (view.tick === tick) {
        return view;
      }
    }
    return null;
  }
}

// What the worker hands the page for each snapshot: one ArrayBuffer, the
// snapshot's header as it came, with its autopilot's block if it has one
// (the own boat, read with readSnapshot), then, from MAX_HEADER_SIZE, a
// Float64Array: a few values of the snapshot's own, then each view slot's
// record.

/** The snapshot's values at the start of the fleet's Float64Array. */
export const FLEET_META = { tick: 0, received: 1, flags: 2, boats: 3, bytes: 4 } as const;
const META_FIELDS = 5;
/** A view slot's record, SLOT_FIELDS apart after the snapshot's values. */
export const SLOT = {
  /** 1 while the slot holds a boat. */
  present: 0,
  /** CHANGE's: what the snapshot's entries did to the slot. */
  change: 1,
  /** 1 when the snapshot samples the boat. */
  sampled: 2,
  kind: 3,
  /** 1 in the far band. */
  far: 4,
  /** The sailor's mode: sailing, in the water, on the board, climbing. */
  mode: 5,
  /** Metres east and north. */
  x: 6,
  y: 7,
  /** Radians, in [−π, π). */
  heading: 8,
  heel: 9,
  boom: 10,
  rudder: 11,
  /** Metres to starboard. */
  sailor: 12,
  /** The sail byte. */
  sail: 13,
  /** 1 while the boat falls over the lip. */
  falling: 14,
  /** 1 for a machine sailor's boat: it carries the machine mark. */
  machine: 15,
  /** The sailor's look code. */
  look: 16,
  /** 1 when the snapshot's enter is of the boat the slot held, its sailor's look, its own look or its kind changed. */
  relook: 17,
  /** Radians, positive to starboard: the headsails' clew's angle off the centreline; 0 with no headsails. */
  jib: 18,
  /** The reef the sail is at, rounded to a level: 0 full sail, 1 or 2. */
  reef: 19,
  /** Radians: the after yards' angle off the centreline, and the fore yards'; 0 with no square sails. */
  yards: 20,
  foreYards: 21,
  /** The boat's own look code: its paint, cloth and sail number. */
  boatLook: 22,
  /** Radians, positive to starboard: the downwind sail's clew's angle off the centreline, and how far it is hoisted, 0 … 1; 0 without one. */
  kite: 23,
  hoist: 24,
} as const;
export const SLOT_FIELDS = 25;
/** A record's length in bytes. */
export const FLEET_RECORD_BYTES = MAX_HEADER_SIZE + 8 * (META_FIELDS + VIEW_SLOTS * SLOT_FIELDS);

/** The fleet's Float64Array of a record. */
export function fleetOf(record: ArrayBuffer): Float64Array {
  return new Float64Array(record, MAX_HEADER_SIZE, META_FIELDS + VIEW_SLOTS * SLOT_FIELDS);
}

/** Where slot i's record starts in a fleet's Float64Array. */
export function slotAt(i: number): number {
  return META_FIELDS + i * SLOT_FIELDS;
}

/** A heading's step count as radians in [−π, π). */
export function headingOf(steps: number): number {
  return (steps >= 32768 ? steps - 65536 : steps) * ANGLE_STEP;
}

/**
 * Writes a record: message the snapshot as it came, view the boats after
 * it, with what its entries did and which it samples, received the time it
 * came, µs.
 */
export function writeRecord(
  record: ArrayBuffer,
  message: Uint8Array,
  view: View,
  changes: Uint8Array,
  sampledSlots: Uint8Array,
  flags: number,
  received: number,
): void {
  const header = Math.min(headerLengthOf(message), message.byteLength);
  new Uint8Array(record, 0, header).set(message.subarray(0, header));
  const f = fleetOf(record);
  f[FLEET_META.tick] = view.tick;
  f[FLEET_META.bytes] = message.byteLength;
  f[FLEET_META.received] = received;
  f[FLEET_META.flags] = flags;
  let boats = 0;
  const q = view.q;
  for (let i = 0; i < VIEW_SLOTS; i++) {
    const o = slotAt(i);
    const b = i * VIEW_STRIDE;
    const present = view.used[i] ?? 0;
    boats += present;
    f[o + SLOT.present] = present;
    f[o + SLOT.change] = changes[i] ?? 0;
    f[o + SLOT.sampled] = sampledSlots[i] ?? 0;
    const flagBits = q[b + Q.flags] ?? 0;
    f[o + SLOT.kind] = q[b + Q.kind] ?? 0;
    f[o + SLOT.far] = flagBits & FAR_BAND;
    f[o + SLOT.mode] = (flagBits >> 1) & 3;
    f[o + SLOT.x] = (q[b + Q.x] ?? 0) * POSITION_STEP;
    f[o + SLOT.y] = (q[b + Q.y] ?? 0) * POSITION_STEP;
    f[o + SLOT.heading] = headingOf(q[b + Q.heading] ?? 0);
    f[o + SLOT.heel] = (q[b + Q.heel] ?? 0) * ANGLE_STEP;
    f[o + SLOT.boom] = (q[b + Q.boom] ?? 0) * ANGLE_STEP;
    f[o + SLOT.rudder] = (q[b + Q.rudder] ?? 0) * ANGLE_STEP;
    f[o + SLOT.sailor] = (q[b + Q.sailor] ?? 0) * POSITION_STEP;
    f[o + SLOT.sail] = q[b + Q.sail] ?? 0;
    f[o + SLOT.falling] = (flagBits & FALLING) !== 0 ? 1 : 0;
    f[o + SLOT.machine] = (flagBits & MACHINE) !== 0 ? 1 : 0;
    f[o + SLOT.look] = q[b + Q.look] ?? 0;
    f[o + SLOT.relook] = (flagBits & RELOOK) !== 0 ? 1 : 0;
    f[o + SLOT.jib] = (q[b + Q.jib] ?? 0) * ANGLE_STEP;
    f[o + SLOT.reef] = flagBits >> REEF_SHIFT;
    const yards = q[b + Q.yards] ?? 0;
    f[o + SLOT.yards] = yards * ANGLE_STEP;
    f[o + SLOT.foreYards] = (yards + (q[b + Q.fore] ?? 0)) * ANGLE_STEP;
    f[o + SLOT.boatLook] = q[b + Q.boatLook] ?? 0;
    f[o + SLOT.kite] = (q[b + Q.kite] ?? 0) * ANGLE_STEP;
    f[o + SLOT.hoist] = (q[b + Q.hoist] ?? 0) / HOIST_STEPS;
  }
  f[FLEET_META.boats] = boats;
}
