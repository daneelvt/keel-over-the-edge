// SPDX-License-Identifier: AGPL-3.0-only

// The other boats a player sees, as shared/protocol/snapshot.txt lays them
// out: a view of up to 64 boats, each quantised, sent as entries that
// change the view of a base snapshot the client still holds. The net
// worker keeps the last few views it decoded, applies each snapshot's
// entries to a copy of its base's, and hands the page the result in metres
// and radians, in a record of typed arrays it reuses. internal/protocol's
// view.go is the server's side, and its tests write the vectors these are
// tested against.

import { FAR_SAMPLED, HEADER_SIZE, type OwnSnapshot } from './snapshot';

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
} as const;
export const VIEW_STRIDE = 10;

/** A boat's flags: in the far band; the sailor's mode is bits 1–2. */
export const FAR_BAND = 1;
const FLAGS_USED = 7;

/** The steps of the fields. */
export const HEADING_STEP = (2 * Math.PI) / 65536;
export const ANGLE_STEP = Math.PI / 128;
export const POSITION_STEP = 0.01;
const POSITION_LIMIT = 2 ** 23 - 1;

/** What an entry did to a view slot, in a snapshot's changes. */
export const CHANGE = { none: 0, entered: 1, updated: 2, left: 3 } as const;

const OP_UPDATE = 0;
const OP_ENTER = 1;
const OP_LEAVE = 2;

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
          const kind = r.uvarint();
          if (kind > 65535) {
            return `a boat of kind ${kind}`;
          }
          if (r.left() < 14) {
            return 'an entry cut short';
          }
          const b = r.at;
          const flags = v.getUint8(b);
          if ((flags & ~FLAGS_USED) !== 0) {
            return 'a boat with flags it should not have';
          }
          q[o + Q.kind] = kind;
          q[o + Q.flags] = flags;
          q[o + Q.x] = int24(v, b + 1);
          q[o + Q.y] = int24(v, b + 4);
          q[o + Q.heading] = v.getUint16(b + 7, true);
          q[o + Q.heel] = v.getInt8(b + 9);
          q[o + Q.boom] = v.getInt8(b + 10);
          q[o + Q.rudder] = v.getInt8(b + 11);
          q[o + Q.sailor] = v.getInt8(b + 12);
          q[o + Q.sail] = v.getUint8(b + 13);
          r.at += 14;
          view.used[slot] = 1;
          changes[slot] = CHANGE.entered;
          break;
        }
        case OP_UPDATE: {
          const m = r.byte();
          if (m === 0) {
            return 'an update of nothing';
          }
          if (view.used[slot] === 0) {
            return `an update of empty view slot ${slot}`;
          }
          if ((m & 1) !== 0) {
            const x = (q[o + Q.x] ?? 0) + r.varint();
            const y = (q[o + Q.y] ?? 0) + r.varint();
            if (x < -POSITION_LIMIT - 1 || x > POSITION_LIMIT || y < -POSITION_LIMIT - 1 || y > POSITION_LIMIT) {
              return `view slot ${slot} moved beyond 24 bits`;
            }
            q[o + Q.x] = x;
            q[o + Q.y] = y;
          }
          if ((m & 2) !== 0) {
            q[o + Q.heading] = r.byte() | (r.byte() << 8);
          }
          if ((m & 4) !== 0) {
            q[o + Q.heel] = (r.byte() << 24) >> 24;
          }
          if ((m & 8) !== 0) {
            q[o + Q.boom] = (r.byte() << 24) >> 24;
          }
          if ((m & 16) !== 0) {
            q[o + Q.rudder] = (r.byte() << 24) >> 24;
          }
          if ((m & 32) !== 0) {
            q[o + Q.sailor] = (r.byte() << 24) >> 24;
          }
          if ((m & 64) !== 0) {
            q[o + Q.sail] = r.byte();
          }
          if ((m & 128) !== 0) {
            const flags = r.byte();
            if ((flags & ~FLAGS_USED) !== 0) {
              return 'a boat with flags it should not have';
            }
            q[o + Q.flags] = flags;
          }
          if (changes[slot] !== CHANGE.entered) {
            changes[slot] = CHANGE.updated;
          }
          break;
        }
        default:
          return `an entry of op ${op}`;
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
    const err = applyEntries(v, HEADER_SIZE, sn.entries, out, this.changes);
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
// snapshot's header as it came (the own boat, read with readSnapshot),
// then, from HEADER_SIZE, a Float64Array: a few values of the snapshot's
// own, then each view slot's record.

/** The snapshot's values at the start of the fleet's Float64Array. */
export const FLEET_META = { tick: 0, received: 1, flags: 2, boats: 3 } as const;
const META_FIELDS = 4;
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
} as const;
export const SLOT_FIELDS = 14;
/** A record's length in bytes. */
export const FLEET_RECORD_BYTES = HEADER_SIZE + 8 * (META_FIELDS + VIEW_SLOTS * SLOT_FIELDS);

/** The fleet's Float64Array of a record. */
export function fleetOf(record: ArrayBuffer): Float64Array {
  return new Float64Array(record, HEADER_SIZE, META_FIELDS + VIEW_SLOTS * SLOT_FIELDS);
}

/** Where slot i's record starts in a fleet's Float64Array. */
export function slotAt(i: number): number {
  return META_FIELDS + i * SLOT_FIELDS;
}

/** A heading's step count as radians in [−π, π). */
export function headingOf(steps: number): number {
  return (steps >= 32768 ? steps - 65536 : steps) * HEADING_STEP;
}

/**
 * Writes a record: header the snapshot's header bytes, view the boats
 * after it, with what its entries did and which it samples, received the
 * time it came, µs.
 */
export function writeRecord(
  record: ArrayBuffer,
  header: Uint8Array,
  view: View,
  changes: Uint8Array,
  sampledSlots: Uint8Array,
  flags: number,
  received: number,
): void {
  new Uint8Array(record, 0, HEADER_SIZE).set(header.subarray(0, HEADER_SIZE));
  const f = fleetOf(record);
  f[FLEET_META.tick] = view.tick;
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
  }
  f[FLEET_META.boats] = boats;
}
