// SPDX-License-Identifier: AGPL-3.0-only

// The game connection's framing and the snapshot's header, which holds the
// player's own boat, as shared/protocol/snapshot.txt lays them out. Every
// message begins with its kind; a snapshot's header is a packed block of
// little-endian numbers, read here through a DataView into a record made
// once, so reading one allocates nothing. The boat's state is read in the
// physics module's own order, so it can be copied straight into the
// module: the boat's own fields from the header, what its autopilot
// remembers from the autopilot's block that follows it while there is any,
// and how long it has been aground from the ground block after that while
// it is aground, or nothing; and, while it is falling over the lip, the
// tick it went over from the over block after those; while it stays where
// it is as its owner's free camera roams, a flag says so. The other boats'
// entries after them are view.ts's.

/** A message's first byte: a Protocol Buffers envelope. */
export const KIND_MESSAGE = 1;
/** A message's first byte: the snapshot. */
export const KIND_SNAPSHOT = 2;
/** A snapshot's header's length, its kind byte included: where its entries begin, unless a block follows. */
export const HEADER_SIZE = 176;
/** The autopilot's block's length. */
export const PILOT_SIZE = 32;
/** The ground block's length. */
export const GROUND_SIZE = 8;
/** The over block's length. */
export const OVER_SIZE = 8;
/** The header's length with every block. */
export const MAX_HEADER_SIZE = HEADER_SIZE + PILOT_SIZE + GROUND_SIZE + OVER_SIZE;
/** The layout this client reads: the own boat's state as float64, its autopilot's, ground and over blocks, then the view's entries; flag bit 4 while the boat stays. */
export const SNAPSHOT_LAYOUT = 9;
/** The most entries a snapshot may hold. */
export const MAX_ENTRIES = 128;
/** A header's flag: the far band's boats are sampled by this snapshot. */
export const FAR_SAMPLED = 1;
/** A header's flag: the autopilot's block follows it. */
export const PILOT_HELD = 2;
/** A header's flag: the ground block follows it and the autopilot's block, if that is there. */
export const GROUND_HELD = 4;
/** A header's flag: the over block follows it and the blocks before it, if they are there. */
export const OVER_HELD = 8;
/** A header's flag: the boat stays where it is, not stepped, while its owner's free camera roams. */
export const STAYING = 16;
/** A snapshot's margin when no input arrived since the one before. */
export const NO_MARGIN = -32768;
/** The boat's state's fields, as the physics module lays them out: the boat's own, then its autopilot's, then how long it has been aground. */
export const STATE_FIELDS = 23;
/** Those of them the header holds; the autopilot's block holds those up to PILOT_FIELDS, and the ground block the last. */
export const BOAT_FIELDS = 19;
export const PILOT_FIELDS = 22;
/** The field the ground block holds: how long the boat has been aground and all but still. */
export const GROUND_TIMER = 22;

/** A snapshot's header: the player's own boat as the server last stepped it. */
export interface OwnSnapshot {
  tick: number;
  /** How many ticks before this one the snapshot its entries change is; 0 for none. */
  base: number;
  /** FAR_SAMPLED, PILOT_HELD, GROUND_HELD, OVER_HELD and STAYING, or 0. */
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
  /** The tick the boat went over the lip while it is falling, or 0 while it is afloat. */
  over: number;
  /** The boat stays where it is while its owner's free camera roams. */
  stays: boolean;
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
    over: 0,
    stays: false,
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
  return (
    HEADER_SIZE +
    ((flags & PILOT_HELD) !== 0 ? PILOT_SIZE : 0) +
    ((flags & GROUND_HELD) !== 0 ? GROUND_SIZE : 0) +
    ((flags & OVER_HELD) !== 0 ? OVER_SIZE : 0)
  );
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
  if ((flags & ~(FAR_SAMPLED | PILOT_HELD | GROUND_HELD | OVER_HELD | STAYING)) !== 0) {
    return 'a snapshot with flags it should not have';
  }
  const entries = v.getUint8(ENTRIES);
  if (entries > MAX_ENTRIES) {
    return 'a snapshot of too many entries';
  }
  const held = (flags & PILOT_HELD) !== 0;
  const header = headerLength(flags);
  if (v.byteLength < header) {
    return `a snapshot of ${v.byteLength} bytes, shorter than its header and blocks`;
  }
  if (held) {
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
  const tick = getInt64(v, TICK);
  let over = 0;
  if ((flags & OVER_HELD) !== 0) {
    over = getInt64(v, header - OVER_SIZE);
    if (!(over > 0 && over <= tick)) {
      return 'a snapshot with its fall out of range';
    }
  }
  out.tick = tick;
  out.over = over;
  out.stays = (flags & STAYING) !== 0;
  out.base = v.getUint16(BASE, true);
  out.flags = flags;
  out.entries = entries;
  out.seq = v.getUint32(SEQ, true);
  out.margin = v.getInt16(MARGIN, true);
  out.helm = helm;
  out.sheet = sheet;
  out.header = header;
  const s = out.state;
  for (let i = 0; i < BOAT_FIELDS; i++) {
    s[i] = v.getFloat64(STATE + 8 * i, true);
  }
  if (held) {
    out.mode = v.getUint8(PILOT_MODE);
    out.way = v.getUint8(PILOT_WAY);
    out.order = v.getUint8(PILOT_ORDER);
    out.target = v.getUint16(PILOT_TARGET, true);
    for (let i = BOAT_FIELDS; i < PILOT_FIELDS; i++) {
      s[i] = v.getFloat64(PILOT_STATE + 8 * (i - BOAT_FIELDS), true);
    }
  } else {
    out.mode = 0;
    out.way = 0;
    out.order = 0;
    out.target = 0;
    s.fill(0, BOAT_FIELDS, PILOT_FIELDS);
  }
  const groundAt = header - GROUND_SIZE - ((flags & OVER_HELD) !== 0 ? OVER_SIZE : 0);
  s[GROUND_TIMER] = (flags & GROUND_HELD) !== 0 ? v.getFloat64(groundAt, true) : 0;
  return null;
}

/** Whether a snapshot of s carries the autopilot's block: whether its pilot word or what its autopilot remembers is not zero (-0 counts). */
export function pilotHeld(s: OwnSnapshot): boolean {
  if (s.mode !== 0 || s.way !== 0 || s.order !== 0 || s.target !== 0) {
    return true;
  }
  for (let i = BOAT_FIELDS; i < PILOT_FIELDS; i++) {
    if (notZero(s.state[i] ?? 0)) {
      return true;
    }
  }
  return false;
}

/** Whether a snapshot of s carries the ground block: whether its time aground is not zero (-0 counts). */
export function groundHeld(s: OwnSnapshot): boolean {
  return notZero(s.state[GROUND_TIMER] ?? 0);
}

function notZero(x: number): boolean {
  return x !== 0 || Object.is(x, -0);
}

/**
 * Writes a snapshot's header, its kind byte first, into v, which holds its
 * length, and returns that length: HEADER_SIZE and each block's
 * (tests, traces).
 */
export function writeSnapshot(s: OwnSnapshot, v: DataView): number {
  const held = pilotHeld(s);
  const aground = groundHeld(s);
  const falling = s.over !== 0;
  const flags =
    (s.flags & ~(PILOT_HELD | GROUND_HELD | OVER_HELD | STAYING)) |
    (held ? PILOT_HELD : 0) |
    (aground ? GROUND_HELD : 0) |
    (falling ? OVER_HELD : 0) |
    (s.stays ? STAYING : 0);
  v.setUint8(0, KIND_SNAPSHOT);
  v.setUint8(1, SNAPSHOT_LAYOUT);
  setInt64(v, TICK, s.tick);
  v.setUint16(BASE, s.base, true);
  v.setUint8(FLAGS, flags);
  v.setUint32(SEQ, s.seq, true);
  v.setInt16(MARGIN, s.margin, true);
  v.setUint16(HELM, s.helm, true);
  v.setUint16(SHEET, s.sheet, true);
  for (let i = 0; i < BOAT_FIELDS; i++) {
    v.setFloat64(STATE + 8 * i, s.state[i] ?? 0, true);
  }
  v.setUint8(ENTRIES, s.entries);
  let at = HEADER_SIZE;
  if (held) {
    for (let i = HEADER_SIZE; i < HEADER_SIZE + PILOT_SIZE; i++) {
      v.setUint8(i, 0);
    }
    v.setUint8(PILOT_MODE, s.mode);
    v.setUint8(PILOT_WAY, s.way);
    v.setUint8(PILOT_ORDER, s.order);
    v.setUint16(PILOT_TARGET, s.target, true);
    for (let i = BOAT_FIELDS; i < PILOT_FIELDS; i++) {
      v.setFloat64(PILOT_STATE + 8 * (i - BOAT_FIELDS), s.state[i] ?? 0, true);
    }
    at += PILOT_SIZE;
  }
  if (aground) {
    v.setFloat64(at, s.state[GROUND_TIMER] ?? 0, true);
    at += GROUND_SIZE;
  }
  if (falling) {
    setInt64(v, at, s.over);
    at += OVER_SIZE;
  }
  return at;
}
