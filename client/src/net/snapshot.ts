// SPDX-License-Identifier: AGPL-3.0-only

// The game connection's framing and the own-boat snapshot, as
// shared/protocol/snapshot.txt lays them out. Every message begins with its
// kind; a snapshot is a packed block of little-endian numbers, read here
// through a DataView into a record made once, so reading one allocates
// nothing. The boat's state is read in the physics module's own order, so
// it can be copied straight into the module.

/** A message's first byte: a Protocol Buffers envelope. */
export const KIND_MESSAGE = 1;
/** A message's first byte: the own-boat snapshot. */
export const KIND_SNAPSHOT = 2;
/** A snapshot's length, its kind byte included. */
export const SNAPSHOT_SIZE = 156;
/** The layout this client reads: the boat's state as float64. */
export const SNAPSHOT_LAYOUT = 1;
/** A snapshot's margin when no input arrived since the one before. */
export const NO_MARGIN = -32768;
/** The boat's state's fields, as the physics module lays them out. */
export const STATE_FIELDS = 15;

/** The player's own boat as the server last stepped it. */
export interface OwnSnapshot {
  tick: number;
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

/**
 * Reads a snapshot, its kind byte first, into out. Returns an error's text
 * for a message that is not a snapshot this client can read, or null.
 */
export function readSnapshot(v: DataView, out: OwnSnapshot): string | null {
  if (v.byteLength === 0 || v.getUint8(0) !== KIND_SNAPSHOT) {
    return 'not a snapshot';
  }
  if (v.byteLength < 2 || v.getUint8(1) !== SNAPSHOT_LAYOUT) {
    return 'a snapshot of another layout';
  }
  if (v.byteLength !== SNAPSHOT_SIZE) {
    return `a snapshot of ${v.byteLength} bytes`;
  }
  const helm = v.getUint16(16, true);
  const sheet = v.getUint16(18, true);
  if (helm > 1024 || sheet > 1024) {
    return 'a snapshot with controls out of range';
  }
  out.tick = getInt64(v, 2);
  out.seq = v.getUint32(10, true);
  out.margin = v.getInt16(14, true);
  out.helm = helm;
  out.sheet = sheet;
  out.windSpeed = v.getFloat64(20, true);
  out.windFrom = v.getFloat64(28, true);
  const s = out.state;
  for (let i = 0; i < STATE_FIELDS; i++) {
    s[i] = v.getFloat64(36 + 8 * i, true);
  }
  return null;
}

/** Writes a snapshot, its kind byte first, into v, which holds SNAPSHOT_SIZE bytes (tests, traces). */
export function writeSnapshot(s: OwnSnapshot, v: DataView): void {
  v.setUint8(0, KIND_SNAPSHOT);
  v.setUint8(1, SNAPSHOT_LAYOUT);
  setInt64(v, 2, s.tick);
  v.setUint32(10, s.seq, true);
  v.setInt16(14, s.margin, true);
  v.setUint16(16, s.helm, true);
  v.setUint16(18, s.sheet, true);
  v.setFloat64(20, s.windSpeed, true);
  v.setFloat64(28, s.windFrom, true);
  for (let i = 0; i < STATE_FIELDS; i++) {
    v.setFloat64(36 + 8 * i, s.state[i] ?? 0, true);
  }
}
