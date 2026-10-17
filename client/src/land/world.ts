// SPDX-License-Identifier: AGPL-3.0-only

// A whole world in the sandbox, from a world file (keel worldgen -out, which
// go run ./tools/dev -world writes to .dev/worlds): its start area, and its
// chunks handed to the land by the server's own rule as the boat sails, with
// no server. The file is the bundle as one file: a magic, then the records
// (JSON), the report, the digest and each chunk's payload, each as a
// little-endian length and its bytes. Its chunks carry the zero world's id.

import type { WorldHandout } from '../catalog/types.gen';
import { GROUND } from '../predict/layout.gen';
import { unpackChunk } from '../workers/mesh/chunk';
import { Handout } from './handout';
import type { Land } from './land';

/** A world file's magic. */
const MAGIC = 'KEELWRLD';
/** The world id the file's chunks carry. */
export const FILE_WORLD = '00000000-0000-0000-0000-000000000000';

/** A world file read: where boats start, its water's way round the disk, and each chunk's payload by number. */
export interface WorldFile {
  start: { heading: number; places: [number, number][] };
  /** 1 clockwise seen from above, −1 the other way. */
  circulation: number;
  payloads: Uint8Array[];
}

/** Reads a world file, or throws. */
export function readWorldFile(data: ArrayBuffer): WorldFile {
  const b = new Uint8Array(data);
  const v = new DataView(data);
  if (new TextDecoder().decode(b.subarray(0, MAGIC.length)) !== MAGIC) {
    throw new Error('not a world file');
  }
  let at = MAGIC.length;
  const next = (): Uint8Array => {
    if (at + 4 > b.length) {
      throw new Error('a world file cut short');
    }
    const n = v.getUint32(at, true);
    if (at + 4 + n > b.length) {
      throw new Error('a world file cut short');
    }
    const part = b.subarray(at + 4, at + 4 + n);
    at += 4 + n;
    return part;
  };
  const records = JSON.parse(new TextDecoder().decode(next())) as {
    start: { heading: number; places: [number, number][] };
    circulation?: number;
  };
  next(); // the report
  next(); // the digest
  const payloads: Uint8Array[] = [];
  for (let n = 0; n < GROUND.chunkSide * GROUND.chunkSide; n++) {
    payloads.push(next());
  }
  // A file written before the way was kept: clockwise.
  return { start: records.start, circulation: records.circulation ?? 1, payloads };
}

/** Fetches the world file of a seed from the development server. */
export async function fetchWorldFile(seed: string): Promise<WorldFile> {
  if (!/^\d+$/.test(seed)) {
    throw new Error(`?world wants a seed, a whole number: ${seed}`);
  }
  const res = await fetch(`/dev-worlds/${seed}.world`);
  if (!res.ok) {
    throw new Error(
      `no world file for seed ${seed} (${res.status}): run go run ./tools/dev -world ${seed}`,
    );
  }
  return readWorldFile(await res.arrayBuffer());
}

/**
 * Hands the land a world file's chunks as a boat at where() could see
 * them, as the server would: looked at again every half second. Returns a
 * function that stops it.
 */
export async function handWorld(
  land: Land,
  file: WorldFile,
  rule: WorldHandout,
  where: () => [number, number],
): Promise<() => void> {
  const elevations = new Map<number, Int16Array | null>();
  const zero = new Uint8Array(16);
  await Promise.all(
    file.payloads.map(async (p, n) => {
      const g = await unpackChunk(p, n, zero);
      if (typeof g === 'string') {
        throw new Error(`the world file's chunk ${n}: ${g}`);
      }
      elevations.set(n, g.elevation);
    }),
  );
  const handout = new Handout(rule, elevations);
  const given = new Set<number>();
  const look = (): void => {
    const [east, north] = where();
    for (const n of handout.seen(east, north)) {
      if (!given.has(n)) {
        given.add(n);
        const p = file.payloads[n] as Uint8Array;
        land.give(n, p.slice().buffer);
      }
    }
  };
  look();
  const timer = setInterval(look, 500);
  return () => clearInterval(timer);
}
