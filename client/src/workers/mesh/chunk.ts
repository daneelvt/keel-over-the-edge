// SPDX-License-Identifier: AGPL-3.0-only

// A chunk of the world's land as the server serves it: gzip of a header
// (the magic, the format, the chunk's number, the generator's version, the
// world's id, and what it holds), then the elevations column by column,
// each as its difference from the one before, the surfaces, and the
// shelter: a bitmap of the cells with a table, and their tables; and from
// format 2 its towns: the buildings and props whose middles are in it, and
// the discs of harbour water whose centres are; and from format 3 its
// features: the roofs over its hexagons (an arch's span, a cave's roof),
// and the parts of features that stand in it (a fall's lip, a blowhole's
// vent, a fumarole's, a colony); and from format 4 a shelter's table holds
// three bytes a direction, the lee's fetch for the waves the third. The
// header is checked before anything is read, so a chunk of another world,
// another number or a format it does not know is never taken for the one
// asked for; a chunk of format 1 is a chunk with no town, one of format 2 a
// chunk with no feature, one of format 3 a chunk whose lee is open water.
// The browser unpacks it with DecompressionStream, which every browser the
// game runs on has, in workers too.

import { GROUND } from '../../predict/layout.gen';

/** "KWCH", every chunk's first four bytes. */
const MAGIC = [0x4b, 0x57, 0x43, 0x48] as const;
/** The newest chunk format this client reads; it reads every one from 1. */
export const CHUNK_FORMAT = 4;
/** The header's length. */
const HEADER = 4 + 2 + 2 + 4 + 16 + 1;
/** What a chunk holds, in the header's last byte. */
const HOLDS_GROUND = 1;
const HOLDS_SHELTER = 2;
const HOLDS_TOWN = 4;
const HOLDS_FEATURES = 8;
/**
 * A shelter table's bytes for one cell: a factor's, a turn's and the lee's
 * for each direction, as the module holds it; before format 4 a chunk holds
 * the first two of each.
 */
const CELL_TABLE = GROUND.shelterDirections * GROUND.shelterStride;
/** A building's bytes, and a disc of harbour water's. */
const BUILDING = 20;
const DISC = 10;
/** A roof's bytes, and a feature's part's. */
const ROOF = 8;
const PART = 17;
/** The most buildings and discs a chunk holds. */
const MOST_BUILDINGS = 8192;
const MOST_DISCS = 4096;
/** The most roofs and parts a chunk holds. */
const MOST_ROOFS = 8192;
const MOST_PARTS = 4096;
/** The most a chunk may unpack to: its ground, every cell's table and its towns, and a little. */
const MOST =
  HEADER +
  3 * GROUND.chunkHexes +
  GROUND.shelterCells * (CELL_TABLE + 1) +
  4 +
  MOST_BUILDINGS * BUILDING +
  MOST_DISCS * DISC +
  4 +
  MOST_ROOFS * ROOF +
  MOST_PARTS * PART +
  1024;

/** A building or a prop of a town, as its chunk holds it. */
export interface ChunkBuilding {
  /** Its kind and its kit, by their indices in the catalog's lists. */
  kind: number;
  kit: number;
  /** Its middle, m east and north of the world's centre, and the way its front faces, radians clockwise from north. */
  east: number;
  north: number;
  heading: number;
  /** Its plot's height, m, and its top's. */
  level: number;
  top: number;
  storeys: number;
  /** A number of its own, 0 … 63: which windows are lit, whether it smokes. */
  seed: number;
  /** Its colours, by their indices in its kit's palettes. */
  wall: number;
  roof: number;
  shutter: number;
  /** Its flag's colours: 0 none, else the catalog's pair's index and one; Port Royal's past the list. */
  flag: number;
  /** Its frontage and depth, m. */
  frontage: number;
  depth: number;
  /** Its town's number. */
  town: number;
}

/** A disc of harbour water: within it, on water, is in port. */
export interface ChunkDisc {
  east: number;
  north: number;
  radius: number;
}

/** What a chunk holds of the towns. */
export interface ChunkTown {
  buildings: ChunkBuilding[];
  harbour: ChunkDisc[];
}

/** A roof: a hexagon whose land is drawn from its underside up to its top, over rock awash. */
export interface ChunkRoof {
  /** Its hexagon's column and row on the grid. */
  column: number;
  row: number;
  /** Its top and underside, m above the sea. */
  top: number;
  under: number;
}

/** What the page draws of a feature: a fall's lip, a blowhole's vent, a fumarole's, a colony. */
export interface ChunkPart {
  /** Its feature's kind, by its index in the catalog's list. */
  kind: number;
  /** Its middle, m east and north of the world's centre; how high it stands, m; the way it faces, radians clockwise from north. */
  east: number;
  north: number;
  level: number;
  heading: number;
  /** A fall's width, a vent's, how far a colony's birds wheel, m. */
  size: number;
  /** A colony's birds; a fall's catchment, in hundreds of m². */
  count: number;
  seed: number;
}

/** What a chunk holds of the features. */
export interface ChunkFeatures {
  roofs: ChunkRoof[];
  parts: ChunkPart[];
}

/** A chunk's grids: each null if it holds none, which is deep water and open wind. */
export interface ChunkGrids {
  number: number;
  /** Each hexagon's elevation in decimetres above the sea, column by column. */
  elevation: Int16Array | null;
  /** Each hexagon's surface, an index into the catalog's surfaces. */
  surface: Uint8Array | null;
  /** For each cell, column by column, and each direction, the shelter's factor byte, turn byte and lee byte. */
  shelter: Uint8Array | null;
  /** Its towns' buildings and harbour, or null for none. */
  town: ChunkTown | null;
  /** Its features' roofs and parts, or null for none. */
  features: ChunkFeatures | null;
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
  if (format < 1 || format > CHUNK_FORMAT) {
    return `a chunk of format ${format}, not 1 to ${CHUNK_FORMAT}`;
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
  const grids: ChunkGrids = {
    number,
    elevation: null,
    surface: null,
    shelter: null,
    town: null,
    features: null,
  };
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
    for (let i = 0; i < table.length; i += GROUND.shelterStride) {
      table[i] = GROUND.shelterFactorOne;
      table[i + 2] = GROUND.shelterLeeOpen;
    }
    const width = format >= 4 ? GROUND.shelterStride : 2;
    const stored = GROUND.shelterDirections * width;
    const bits = raw.subarray(at, at + bitmap);
    at += bitmap;
    for (let i = 0; i < GROUND.shelterCells; i++) {
      if (((bits[i >> 3] ?? 0) & (1 << (i & 7))) === 0) {
        continue;
      }
      if (raw.length < at + stored) {
        return 'a chunk’s shelter cut short';
      }
      for (let k = 0; k < GROUND.shelterDirections; k++) {
        const to = i * CELL_TABLE + k * GROUND.shelterStride;
        table.set(raw.subarray(at + k * width, at + (k + 1) * width), to);
      }
      at += stored;
    }
    grids.shelter = table;
  }
  if ((holds & HOLDS_TOWN) !== 0 && format >= 2) {
    const town = readTown(v, at);
    if (typeof town === 'string') {
      return town;
    }
    grids.town = town.town;
    at = town.at;
  }
  if ((holds & HOLDS_FEATURES) !== 0 && format >= 3) {
    const f = readFeatures(v, at, number);
    if (typeof f === 'string') {
      return f;
    }
    grids.features = f.features;
    at = f.at;
  }
  if (at !== raw.length) {
    return `a chunk with ${raw.length - at} bytes too many`;
  }
  return grids;
}

/** Reads a chunk's towns from at: its buildings, then its discs of harbour water. */
function readTown(v: DataView, start: number): { town: ChunkTown; at: number } | string {
  let at = start;
  if (v.byteLength < at + 2) {
    return 'a chunk’s town cut short';
  }
  const n = v.getUint16(at, true);
  at += 2;
  if (v.byteLength < at + n * BUILDING) {
    return 'a chunk’s buildings cut short';
  }
  const buildings: ChunkBuilding[] = [];
  for (let k = 0; k < n; k++, at += BUILDING) {
    const level = v.getInt16(at + 11, true) / 10;
    const sb = v.getUint8(at + 13);
    const colours = v.getUint8(at + 14);
    const more = v.getUint8(at + 15);
    buildings.push({
      kind: v.getUint8(at),
      kit: v.getUint8(at + 1),
      east: v.getInt32(at + 2, true) / 10,
      north: v.getInt32(at + 6, true) / 10,
      heading: (v.getUint8(at + 10) * 2 * Math.PI) / 256,
      level,
      storeys: sb & 3,
      seed: sb >> 2,
      wall: colours & 15,
      roof: colours >> 4,
      shutter: more & 15,
      flag: more >> 4,
      frontage: v.getUint8(at + 16) / 5,
      depth: v.getUint8(at + 17) / 5,
      top: level + v.getUint8(at + 18) / 4,
      town: v.getUint8(at + 19),
    });
  }
  if (v.byteLength < at + 2) {
    return 'a chunk’s harbour cut short';
  }
  const d = v.getUint16(at, true);
  at += 2;
  if (v.byteLength < at + d * DISC) {
    return 'a chunk’s harbour cut short';
  }
  const harbour: ChunkDisc[] = [];
  for (let k = 0; k < d; k++, at += DISC) {
    harbour.push({
      east: v.getInt32(at, true) / 10,
      north: v.getInt32(at + 4, true) / 10,
      radius: v.getUint16(at + 8, true) / 10,
    });
  }
  return { town: { buildings, harbour }, at };
}

/** Reads a chunk's features from at: its roofs, then its parts. */
function readFeatures(
  v: DataView,
  start: number,
  number: number,
): { features: ChunkFeatures; at: number } | string {
  let at = start;
  if (v.byteLength < at + 2) {
    return 'a chunk’s roofs cut short';
  }
  const n = v.getUint16(at, true);
  at += 2;
  if (v.byteLength < at + n * ROOF) {
    return 'a chunk’s roofs cut short';
  }
  const c0 = (number % GROUND.chunkSide) * GROUND.chunkColumns;
  const j0 = Math.floor(number / GROUND.chunkSide) * GROUND.chunkRows;
  const roofs: ChunkRoof[] = [];
  for (let k = 0; k < n; k++, at += ROOF) {
    const i = v.getUint32(at, true);
    if (i >= GROUND.chunkHexes) {
      return 'a roof off its chunk';
    }
    roofs.push({
      column: c0 + Math.floor(i / GROUND.chunkRows),
      row: j0 + (i % GROUND.chunkRows),
      top: v.getInt16(at + 4, true) / 10,
      under: v.getInt16(at + 6, true) / 10,
    });
  }
  if (v.byteLength < at + 2) {
    return 'a chunk’s parts cut short';
  }
  const p = v.getUint16(at, true);
  at += 2;
  if (v.byteLength < at + p * PART) {
    return 'a chunk’s parts cut short';
  }
  const parts: ChunkPart[] = [];
  for (let k = 0; k < p; k++, at += PART) {
    parts.push({
      kind: v.getUint8(at),
      east: v.getInt32(at + 1, true) / 10,
      north: v.getInt32(at + 5, true) / 10,
      level: v.getInt16(at + 9, true) / 10,
      heading: (v.getUint8(at + 11) * 2 * Math.PI) / 256,
      size: v.getUint16(at + 12, true) / 10,
      count: v.getUint16(at + 14, true),
      seed: v.getUint8(at + 16),
    });
  }
  return { features: { roofs, parts }, at };
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
