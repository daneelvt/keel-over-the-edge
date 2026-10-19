// SPDX-License-Identifier: AGPL-3.0-only

// An island's model for the chart, as the server serves it once the island
// is charted: a coarse grid of its land, each cell its highest ground and
// that ground's surface, gzipped (internal/chart/models.go). It is fetched
// from the address its charting carries, as a chunk is, and read here.

/** An island's model. */
export interface IslandModel {
  island: number;
  /** Hexagons a cell's side. */
  cell: number;
  columns: number;
  rows: number;
  /** The first cell's centre, m east and north; a column's and a row's step, m. */
  x: number;
  y: number;
  dx: number;
  dy: number;
  /** Each cell's highest ground, m (0: not the island's land), and its surface, row by row from the south-west. */
  heights: Uint8Array;
  surfaces: Uint8Array;
}

const FORMAT = 1;
const HEADER = 22;

/** Reads a model's payload, gunzipped; throws on one it cannot read. */
export function readModel(raw: Uint8Array): IslandModel {
  if (raw.length < HEADER || raw[0] !== FORMAT) {
    throw new Error('not an island model');
  }
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const columns = v.getUint16(2, true);
  const rows = v.getUint16(4, true);
  const n = columns * rows;
  if (raw.length !== HEADER + 2 * n) {
    throw new Error('an island model of the wrong length');
  }
  return {
    cell: raw[1] ?? 4,
    columns,
    rows,
    x: v.getInt32(6, true) / 100,
    y: v.getInt32(10, true) / 100,
    dx: v.getUint16(14, true) / 1000,
    dy: v.getUint16(16, true) / 1000,
    island: v.getUint32(18, true),
    heights: raw.subarray(HEADER, HEADER + n),
    surfaces: raw.subarray(HEADER + n, HEADER + 2 * n),
  };
}

/** Gunzips a payload. */
export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Islands' models, each fetched once from its address and kept: online, an
 * address on the play origin; offline, "#n", the sandbox's file's n-th.
 */
export class Models {
  readonly #kept = new Map<string, Promise<IslandModel | null>>();
  readonly #inline: readonly Uint8Array[];
  readonly #fetch: (url: string) => Promise<Response>;

  constructor(
    inline: readonly Uint8Array[] = [],
    fetcher: (url: string) => Promise<Response> = (u) => fetch(u),
  ) {
    this.#inline = inline;
    this.#fetch = fetcher;
  }

  /** The model at an address, or null if it cannot be had. */
  get(address: string): Promise<IslandModel | null> {
    let p = this.#kept.get(address);
    if (p === undefined) {
      p = this.#load(address).catch(() => null);
      this.#kept.set(address, p);
    }
    return p;
  }

  async #load(address: string): Promise<IslandModel | null> {
    if (address === '') {
      return null;
    }
    let payload: Uint8Array;
    if (address.startsWith('#')) {
      const n = Number(address.slice(1));
      const p = this.#inline[n];
      if (p === undefined) {
        return null;
      }
      payload = p;
    } else {
      const res = await this.#fetch(address);
      if (!res.ok) {
        return null;
      }
      payload = new Uint8Array(await res.arrayBuffer());
    }
    return readModel(await gunzip(payload));
  }
}
