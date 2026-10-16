// SPDX-License-Identifier: AGPL-3.0-only

// A chunk of the world's land as the server serves it: gzip of a header
// (the magic, the format, the chunk's number, the generator's version, the
// world's id, and what it holds), then the elevations column by column,
// each as its difference from the one before, the surfaces, and the
// shelter: a bitmap of the cells with a table, and their tables. The
// header is checked before anything is read, so a chunk of another world,
// another number or another format is never taken for the one asked for.
// The browser unpacks it with DecompressionStream, which every browser the
// game runs on has, in workers too.

import { GROUND } from '../../predict/layout.gen';

/** "KWCH", every chunk's first four bytes. */
const MAGIC = [0x4b, 0x57, 0x43, 0x48] as const;
/** The chunk's format this client reads. */
export const CHUNK_FORMAT = 1;
/** The header's length. */
const HEADER = 4 + 2 + 2 + 4 + 16 + 1;
/** What a chunk holds, in the header's last byte. */
const HOLDS_GROUND = 1;
const HOLDS_SHELTER = 2;
/** A shelter table's bytes for one cell: a factor's and a turn's for each direction. */
const CELL_TABLE = GROUND.shelterDirections * 2;
/** The most a chunk may unpack to: its ground and every cell's table, and a little. */
const MOST = HEADER + 3 * GROUND.chunkHexes + GROUND.shelterCells * (CELL_TABLE + 1) + 1024;

/** A chunk's grids: each null if it holds none, which is deep water and open wind. */
export interface ChunkGrids {
  number: number;
  /** Each hexagon's elevation in decimetres above the sea, column by column. */
  elevation: Int16Array | null;
  /** Each hexagon's surface, an index into the catalog's surfaces. */
  surface: Uint8Array | null;
  /** For each cell, column by column, and each direction, the shelter's factor byte and turn byte. */
  shelter: Uint8Array | null;
}

/** A world's id, as the Welcome writes it, as its 16 bytes. */
export function worldBytes(id: string): Uint8Array {
  const hex = id.replaceAll('-', '');
  const out = new Uint8Array(16);
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    throw new Error(`not a world's id: ${id}`);
  }
  for (let i = 0; i < 16; i++) {
    out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

/** Unpacks gzip, refusing anything that unpacks to more than a chunk can. */
export async function gunzip(payload: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([payload as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    length += value.length;
    if (length > MOST) {
      await reader.cancel();
      throw new Error('a chunk that unpacks to too much');
    }
    parts.push(value);
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Reads an unpacked chunk, checking its header: that it is chunk number of
 * the world whose id's bytes are world, in this client's format. Returns
 * its grids, or a refusal's words.
 */
export function readChunk(raw: Uint8Array, number: number, world: Uint8Array): ChunkGrids | string {
  if (raw.length < HEADER || MAGIC.some((b, i) => raw[i] !== b)) {
    return 'not a chunk';
  }
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const format = v.getUint16(4, true);
  if (format !== CHUNK_FORMAT) {
    return `a chunk of format ${format}, not ${CHUNK_FORMAT}`;
  }
  const n = v.getUint16(6, true);
  if (n !== number) {
    return `chunk ${n}, not ${number}`;
  }
  for (let i = 0; i < 16; i++) {
    if (raw[12 + i] !== world[i]) {
      return 'another world’s chunk';
    }
  }
  const holds = raw[28] ?? 0;
  let at = HEADER;
  const grids: ChunkGrids = { number, elevation: null, surface: null, shelter: null };
  if ((holds & HOLDS_GROUND) !== 0) {
    if (raw.length < at + 3 * GROUND.chunkHexes) {
      return 'a chunk cut short';
    }
    const e = new Int16Array(GROUND.chunkHexes);
    let prev = 0;
    for (let i = 0; i < e.length; i++) {
      prev = ((prev + v.getInt16(at + 2 * i, true)) << 16) >> 16;
      e[i] = prev;
    }
    at += 2 * GROUND.chunkHexes;
    grids.elevation = e;
    grids.surface = raw.slice(at, at + GROUND.chunkHexes);
    at += GROUND.chunkHexes;
  }
  if ((holds & HOLDS_SHELTER) !== 0) {
    const bitmap = (GROUND.shelterCells + 7) >> 3;
    if (raw.length < at + bitmap) {
      return 'a chunk’s shelter cut short';
    }
    const table = new Uint8Array(GROUND.shelterCells * CELL_TABLE);
    for (let i = 0; i < table.length; i += 2) {
      table[i] = GROUND.shelterFactorOne;
    }
    const bits = raw.subarray(at, at + bitmap);
    at += bitmap;
    for (let i = 0; i < GROUND.shelterCells; i++) {
      if (((bits[i >> 3] ?? 0) & (1 << (i & 7))) === 0) {
        continue;
      }
      if (raw.length < at + CELL_TABLE) {
        return 'a chunk’s shelter cut short';
      }
      table.set(raw.subarray(at, at + CELL_TABLE), i * CELL_TABLE);
      at += CELL_TABLE;
    }
    grids.shelter = table;
  }
  if (at !== raw.length) {
    return `a chunk with ${raw.length - at} bytes too many`;
  }
  return grids;
}

/** Unpacks and reads a chunk's payload, as readChunk does; a payload that is not gzip is refused. */
export async function unpackChunk(
  payload: Uint8Array,
  number: number,
  world: Uint8Array,
): Promise<ChunkGrids | string> {
  let raw: Uint8Array;
  try {
    raw = await gunzip(payload);
  } catch (err) {
    return `not a chunk: ${err instanceof Error ? err.message : String(err)}`;
  }
  return readChunk(raw, number, world);
}
