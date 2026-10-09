// SPDX-License-Identifier: AGPL-3.0-only

// The game connection's framing and the snapshot's header, which holds the
// player's own boat, as shared/protocol/snapshot.txt lays them out. Every
// message begins with its kind; a snapshot's header is a packed block of
// little-endian numbers, read here through a DataView into a record made
// once, so reading one allocates nothing. The boat's state is read in the
// physics module's own order, so it can be copied straight into the
// module. The other boats' entries after the header are view.ts's.

/** A message's first byte: a Protocol Buffers envelope. */
export const KIND_MESSAGE = 1;
/** A message's first byte: the snapshot. */
export const KIND_SNAPSHOT = 2;
/** A snapshot's header's length, its kind byte included: where its entries begin. */
export const HEADER_SIZE = 160;
/** The layout this client reads: the own boat's state as float64, then the view's entries. */
export const SNAPSHOT_LAYOUT = 2;
/** The most entries a snapshot may hold. */
export const MAX_ENTRIES = 128;
/** A header's flag: the far band's boats are sampled by this snapshot. */
export const FAR_SAMPLED = 1;
/** A snapshot's margin when no input arrived since the one before. */
export const NO_MARGIN = -32768;
/** The boat's state's fields, as the physics module lays them out. */
export const STATE_FIELDS = 15;

/** A snapshot's header: the player's own boat as the server last stepped it. */
export interface OwnSnapshot {
  tick: number;
  /** How many ticks before this one the snapshot its entries change is; 0 for none. */
  base: number;
  /** FAR_SAMPLED, or 0. */
  flags: number;
  /** How many entries follow the header. */
  entries: number;
  /** The control word in force: the tick it was stamped for (low 32 bits), and its indices. */
  seq: number;
  helm: number;
  sheet: number;
  /** The lowest arrival margin since the previous snapshot, in ticks, or NO_MARGIN. */
  margin: number;
  /** The wind 10 m up, m/s, and where it comes from, radians clockwise from north. */
  windSpeed: number;
  windFrom: number;
  /** The boat's state, in the physics module's order. */
  readonly state: Float64Array;
}

export function newSnapshot(): OwnSnapshot {
  return {
    tick: 0,
    base: 0,
    flags: 0,
    entries: 0,
    seq: 0,
    helm: 0,
    sheet: 0,
    margin: NO_MARGIN,
    windSpeed: 0,
    windFrom: 0,
    state: new Float64Array(STATE_FIELDS),
  };
}

const TWO_32 = 2 ** 32;

/** Reads an int64 exactly while it is within ±2⁵³, without a BigInt. */
function getInt64(v: DataView, at: number): number {
  return v.getInt32(at + 4, true) * TWO_32 + v.getUint32(at, true);
}

function setInt64(v: DataView, at: number, n: number): void {
  const hi = Math.floor(n / TWO_32);
  v.setUint32(at, n - hi * TWO_32, true);
  v.setInt32(at + 4, hi, true);
}

const TICK = 2;
const BASE = 10;
const FLAGS = 12;
const SEQ = 13;
const MARGIN = 17;
const HELM = 19;
const SHEET = 21;
const WIND = 23;
const STATE = 39;
const ENTRIES = 159;

/** A snapshot's tick, read without the rest (the worker's acknowledgement). */
export function snapshotTick(v: DataView): number {
  return getInt64(v, TICK);
}

/**
 * Reads a snapshot's header, its kind byte first, into out. Returns an
 * error's text for a message that is not a snapshot this client can read,
 * or null.
 */
export function readSnapshot(v: DataView, out: OwnSnapshot): string | null {
  if (v.byteLength === 0 || v.getUint8(0) !== KIND_SNAPSHOT) {
    return 'not a snapshot';
  }
  if (v.byteLength < 2 || v.getUint8(1) !== SNAPSHOT_LAYOUT) {
    return 'a snapshot of another layout';
  }
  if (v.byteLength < HEADER_SIZE) {
    return `a snapshot of ${v.byteLength} bytes`;
  }
  const helm = v.getUint16(HELM, true);
  const sheet = v.getUint16(SHEET, true);
  if (helm > 1024 || sheet > 1024) {
    return 'a snapshot with controls out of range';
  }
  const flags = v.getUint8(FLAGS);
  if ((flags & ~FAR_SAMPLED) !== 0) {
    return 'a snapshot with flags it should not have';
  }
  const entries = v.getUint8(ENTRIES);
  if (entries > MAX_ENTRIES) {
    return 'a snapshot of too many entries';
  }
  out.tick = getInt64(v, TICK);
  out.base = v.getUint16(BASE, true);
  out.flags = flags;
  out.entries = entries;
  out.seq = v.getUint32(SEQ, true);
  out.margin = v.getInt16(MARGIN, true);
  out.helm = helm;
  out.sheet = sheet;
  out.windSpeed = v.getFloat64(WIND, true);
  out.windFrom = v.getFloat64(WIND + 8, true);
  const s = out.state;
  for (let i = 0; i < STATE_FIELDS; i++) {
    s[i] = v.getFloat64(STATE + 8 * i, true);
  }
  return null;
}

/** Writes a snapshot's header, its kind byte first, into v, which holds HEADER_SIZE bytes (tests, traces). */
export function writeSnapshot(s: OwnSnapshot, v: DataView): void {
  v.setUint8(0, KIND_SNAPSHOT);
  v.setUint8(1, SNAPSHOT_LAYOUT);
  setInt64(v, TICK, s.tick);
  v.setUint16(BASE, s.base, true);
  v.setUint8(FLAGS, s.flags);
  v.setUint32(SEQ, s.seq, true);
  v.setInt16(MARGIN, s.margin, true);
  v.setUint16(HELM, s.helm, true);
  v.setUint16(SHEET, s.sheet, true);
  v.setFloat64(WIND, s.windSpeed, true);
  v.setFloat64(WIND + 8, s.windFrom, true);
  for (let i = 0; i < STATE_FIELDS; i++) {
    v.setFloat64(STATE + 8 * i, s.state[i] ?? 0, true);
  }
  v.setUint8(ENTRIES, s.entries);
}
