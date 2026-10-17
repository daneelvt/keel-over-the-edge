// SPDX-License-Identifier: AGPL-3.0-only

// A whole world in the sandbox, from a world file (keel worldgen -out, which
// go run ./tools/dev -world writes to .dev/worlds): its start area, and its
// chunks handed to the land by the server's own rule as the boat sails, with
// no server. The file is the bundle as one file: a magic, then the records
// (JSON), the report, the digest and each chunk's payload, each as a
// little-endian length and its bytes. Its chunks carry the zero world's id.

import type { WorldHandout } from '../catalog/types.gen';
import type { LightSeen, PlaceSeen } from '../net/messages';
import { GROUND } from '../predict/layout.gen';
import { unpackChunk } from '../workers/mesh/chunk';
import { chunkAt } from './ground';
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
  /** Its places and lights as its records hold them; none in a file made before it had them. */
  places: RecordPlace[];
  lights: RecordLight[];
}

/** A place as a world's records hold it. */
export interface RecordPlace {
  number: number;
  kind: string;
  x: number;
  y: number;
  heading: number;
  details?: { ship?: { rig: string; age: string; sunk: boolean; heel: number } };
}

/** A light as a world's records hold it. */
export interface RecordLight {
  number: number;
  place: number;
  role: string;
  x: number;
  y: number;
  ground: number;
  tower: number;
  focal: number;
  character: number;
  phase: number;
  range: number;
  daymark: number;
}

/** The catalog's lists a world file's places are read by: the kinds of place, the rigs and ages, by id. */
export interface PlaceLists {
  kinds: readonly { id: string }[];
  rigs: readonly { id: string }[];
  ages: readonly { id: string }[];
}

/** A world file's places as the server sends them: by the catalog's indices, never with a name. */
export function placesSeen(file: WorldFile, lists: PlaceLists): PlaceSeen[] {
  const towers = new Map(file.lights.map((l) => [l.place, l]));
  const index = (list: readonly { id: string }[], id: string | undefined): number =>
    Math.max(
      list.findIndex((k) => k.id === id),
      0,
    );
  return file.places.map((p) => {
    const t = towers.get(p.number);
    const ship = p.details?.ship;
    return {
      number: p.number,
      kind: index(lists.kinds, p.kind),
      east: p.x,
      north: p.y,
      heading: p.heading,
      ground: t?.ground ?? 0,
      tower: t?.tower ?? 0,
      daymark: t?.daymark ?? 0,
      rig: index(lists.rigs, ship?.rig),
      age: index(lists.ages, ship?.age),
      sunk: ship?.sunk ?? false,
      heel: ship?.heel ?? 0,
    };
  });
}

/** A world file's lights as the server sends them, the main port's first. */
export function lightsSeen(file: WorldFile): LightSeen[] {
  return file.lights.map((l) => ({
    number: l.number,
    east: l.x,
    north: l.y,
    focal: l.focal,
    character: l.character,
    phase: l.phase,
    range: l.range,
  }));
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
    places?: RecordPlace[] | null;
    lights?: RecordLight[] | null;
  };
  next(); // the report
  next(); // the digest
  const payloads: Uint8Array[] = [];
  for (let n = 0; n < GROUND.chunkSide * GROUND.chunkSide; n++) {
    payloads.push(next());
  }
  // A file written before the way was kept: clockwise.
  return {
    start: records.start,
    circulation: records.circulation ?? 1,
    payloads,
    places: records.places ?? [],
    lights: records.lights ?? [],
  };
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

/** What is told of a world file's places and lights as they are handed. */
export interface Seen {
  places: PlaceSeen[];
  lights: LightSeen[];
  /** A light is dropped this far beyond its range, m. */
  drop: number;
  onPlaces: (p: PlaceSeen[]) => void;
  onLights: (lights: LightSeen[], drop: number[] | 'all') => void;
}

/**
 * Hands the land a world file's chunks as a boat at where() could see
 * them, as the server would: looked at again every half second; and, if
 * also is given, as its rule sees them from its where() while that is not
 * null (the free camera, from higher). With seen, the places go with their
 * chunks and the lights by range, as the server sends them: the first light,
 * the main port's, at once, as a Welcome carries it. Returns a function
 * that stops it.
 */
export async function handWorld(
  land: Land,
  file: WorldFile,
  rule: WorldHandout,
  where: () => [number, number],
  also: { rule: WorldHandout; where: () => [number, number] | null } | null = null,
  seen: Seen | null = null,
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
  const second = also === null ? null : new Handout(also.rule, elevations);
  const given = new Set<number>();
  const give = (numbers: number[]): void => {
    const places: PlaceSeen[] = [];
    for (const n of numbers) {
      if (!given.has(n)) {
        given.add(n);
        const p = file.payloads[n] as Uint8Array;
        land.give(n, p.slice().buffer);
        for (const pl of seen?.places ?? []) {
          if (chunkAt(pl.east, pl.north) === n) {
            places.push(pl);
          }
        }
      }
    }
    if (seen !== null && places.length > 0) {
      seen.onPlaces(places);
    }
  };
  const [main, ...rest] = seen?.lights ?? [];
  if (seen !== null) {
    seen.onLights(main === undefined ? [] : [main], 'all');
  }
  const shown = new Set<number>();
  const lights = (east: number, north: number): void => {
    if (seen === null) {
      return;
    }
    const come: LightSeen[] = [];
    const drop: number[] = [];
    for (const l of rest) {
      const d = Math.hypot(l.east - east, l.north - north);
      if (!shown.has(l.number) && d <= l.range) {
        shown.add(l.number);
        come.push(l);
      } else if (shown.has(l.number) && d > l.range + seen.drop) {
        shown.delete(l.number);
        drop.push(l.number);
      }
    }
    if (come.length > 0 || drop.length > 0) {
      seen.onLights(come, drop);
    }
  };
  const look = (): void => {
    const [east, north] = where();
    give(handout.seen(east, north));
    const at = also?.where() ?? null;
    if (second !== null && at !== null) {
      give(second.seen(at[0], at[1]));
      lights(at[0], at[1]);
    } else {
      lights(east, north);
    }
  };
  look();
  const timer = setInterval(look, 500);
  return () => clearInterval(timer);
}
