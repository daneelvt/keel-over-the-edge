// SPDX-License-Identifier: AGPL-3.0-only

// The game connection's framing and the snapshot's header, which holds the
// player's own boat, as shared/protocol/snapshot.txt lays them out. Every
// message begins with its kind; a snapshot's header is a packed block of
// little-endian numbers, read here through a DataView into a record made
// once, so reading one allocates nothing. The boat's state is read in the
// physics module's own order, so it can be copied straight into the
// module: the boat's own fields from the header, and what its autopilot
// remembers from the autopilot's block that follows it while there is any,
// or nothing. The other boats' entries after them are view.ts's.

/** A message's first byte: a Protocol Buffers envelope. */
export const KIND_MESSAGE = 1;
/** A message's first byte: the snapshot. */
export const KIND_SNAPSHOT = 2;
/** A snapshot's header's length, its kind byte included: where its entries begin, unless the autopilot's block follows. */
export const HEADER_SIZE = 176;
/** The autopilot's block's length. */
export const PILOT_SIZE = 32;
/** The header's length with the autopilot's block. */
export const MAX_HEADER_SIZE = HEADER_SIZE + PILOT_SIZE;
/** The layout this client reads: the own boat's state as float64, its autopilot's block, then the view's entries. */
export const SNAPSHOT_LAYOUT = 6;
/** The most entries a snapshot may hold. */
export const MAX_ENTRIES = 128;
/** A header's flag: the far band's boats are sampled by this snapshot. */
export const FAR_SAMPLED = 1;
/** A header's flag: the autopilot's block follows it. */
export const PILOT_HELD = 2;
/** A snapshot's margin when no input arrived since the one before. */
export const NO_MARGIN = -32768;
/** The boat's state's fields, as the physics module lays them out: the boat's own, then its autopilot's. */
export const STATE_FIELDS = 22;
/** Those of them the header holds; the autopilot's block holds the rest. */
export const BOAT_FIELDS = 19;

/** A snapshot's header: the player's own boat as the server last stepped it. */
export interface OwnSnapshot {
  tick: number;
  /** How many ticks before this one the snapshot its entries change is; 0 for none. */
  base: number;
  /** FAR_SAMPLED and PILOT_HELD, or 0. */
  flags: number;
  /** How many entries follow the header, and where they begin. */
  entries: number;
  header: number;
  /** The control word in force: the tick it was stamped for (low 32 bits), and its indices. */
  seq: number;
  helm: number;
  sheet: number;
  /** The pilot word in force: the autopilot's mode, way, order count and target. */
  mode: number;
  way: number;
  order: number;
  target: number;
  /** The lowest arrival margin since the previous snapshot, in ticks, or NO_MARGIN. */
  margin: number;
  /** The boat's state, in the physics module's order. */
  readonly state: Float64Array;
}

export function newSnapshot(): OwnSnapshot {
  return {
    tick: 0,
    base: 0,
    flags: 0,
    entries: 0,
    header: HEADER_SIZE,
    seq: 0,
    helm: 0,
    sheet: 0,
    mode: 0,
    way: 0,
    order: 0,
    target: 0,
    margin: NO_MARGIN,
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
const STATE = 23;
const ENTRIES = STATE + 8 * BOAT_FIELDS;
const PILOT_MODE = HEADER_SIZE;
const PILOT_WAY = HEADER_SIZE + 1;
const PILOT_ORDER = HEADER_SIZE + 2;
const PILOT_TARGET = HEADER_SIZE + 4;
const PILOT_STATE = HEADER_SIZE + 8;

/** The header's length of a snapshot whose flags are these: where its entries begin. */
export function headerLength(flags: number): number {
  return (flags & PILOT_HELD) !== 0 ? MAX_HEADER_SIZE : HEADER_SIZE;
}

/** The header's length of a snapshot's bytes, its kind byte first. */
export function headerLengthOf(message: Uint8Array): number {
  return headerLength(message[FLAGS] ?? 0);
}

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
  if ((flags & ~(FAR_SAMPLED | PILOT_HELD)) !== 0) {
    return 'a snapshot with flags it should not have';
  }
  const entries = v.getUint8(ENTRIES);
  if (entries > MAX_ENTRIES) {
    return 'a snapshot of too many entries';
  }
  const held = (flags & PILOT_HELD) !== 0;
  if (held) {
    if (v.byteLength < MAX_HEADER_SIZE) {
      return `a snapshot of ${v.byteLength} bytes, shorter than its header and autopilot`;
    }
    if (
      v.getUint8(PILOT_MODE) > 2 ||
      v.getUint8(PILOT_WAY) > 2 ||
      v.getUint8(PILOT_ORDER) > 3 ||
      v.getUint8(PILOT_ORDER + 1) !== 0 ||
      v.getUint16(PILOT_TARGET + 2, true) !== 0
    ) {
      return 'a snapshot with an autopilot out of range';
    }
  }
  out.tick = getInt64(v, TICK);
  out.base = v.getUint16(BASE, true);
  out.flags = flags;
  out.entries = entries;
  out.seq = v.getUint32(SEQ, true);
  out.margin = v.getInt16(MARGIN, true);
  out.helm = helm;
  out.sheet = sheet;
  out.header = headerLength(flags);
  const s = out.state;
  for (let i = 0; i < BOAT_FIELDS; i++) {
    s[i] = v.getFloat64(STATE + 8 * i, true);
  }
  if (held) {
    out.mode = v.getUint8(PILOT_MODE);
    out.way = v.getUint8(PILOT_WAY);
    out.order = v.getUint8(PILOT_ORDER);
    out.target = v.getUint16(PILOT_TARGET, true);
    for (let i = BOAT_FIELDS; i < STATE_FIELDS; i++) {
      s[i] = v.getFloat64(PILOT_STATE + 8 * (i - BOAT_FIELDS), true);
    }
  } else {
    out.mode = 0;
    out.way = 0;
    out.order = 0;
    out.target = 0;
    s.fill(0, BOAT_FIELDS);
  }
  return null;
}

/** Whether a snapshot of s carries the autopilot's block: whether its pilot word or what its autopilot remembers is not zero (-0 counts). */
export function pilotHeld(s: OwnSnapshot): boolean {
  if (s.mode !== 0 || s.way !== 0 || s.order !== 0 || s.target !== 0) {
    return true;
  }
  for (let i = BOAT_FIELDS; i < STATE_FIELDS; i++) {
    const x = s.state[i] ?? 0;
    if (x !== 0 || Object.is(x, -0)) {
      return true;
    }
  }
  return false;
}

/**
 * Writes a snapshot's header, its kind byte first, into v, which holds its
 * length, and returns that length: MAX_HEADER_SIZE with the autopilot's
 * block, HEADER_SIZE without (tests, traces).
 */
export function writeSnapshot(s: OwnSnapshot, v: DataView): number {
  const held = pilotHeld(s);
  v.setUint8(0, KIND_SNAPSHOT);
  v.setUint8(1, SNAPSHOT_LAYOUT);
  setInt64(v, TICK, s.tick);
  v.setUint16(BASE, s.base, true);
  v.setUint8(FLAGS, (s.flags & ~PILOT_HELD) | (held ? PILOT_HELD : 0));
  v.setUint32(SEQ, s.seq, true);
  v.setInt16(MARGIN, s.margin, true);
  v.setUint16(HELM, s.helm, true);
  v.setUint16(SHEET, s.sheet, true);
  for (let i = 0; i < BOAT_FIELDS; i++) {
    v.setFloat64(STATE + 8 * i, s.state[i] ?? 0, true);
  }
  v.setUint8(ENTRIES, s.entries);
  if (!held) {
    return HEADER_SIZE;
  }
  for (let i = HEADER_SIZE; i < MAX_HEADER_SIZE; i++) {
    v.setUint8(i, 0);
  }
  v.setUint8(PILOT_MODE, s.mode);
  v.setUint8(PILOT_WAY, s.way);
  v.setUint8(PILOT_ORDER, s.order);
  v.setUint16(PILOT_TARGET, s.target, true);
  for (let i = BOAT_FIELDS; i < STATE_FIELDS; i++) {
    v.setFloat64(PILOT_STATE + 8 * (i - BOAT_FIELDS), s.state[i] ?? 0, true);
  }
  return MAX_HEADER_SIZE;
}
