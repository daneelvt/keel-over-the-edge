// SPDX-License-Identifier: AGPL-3.0-only

// A beach cat's people, as their clips have it: a file of its own beside a
// look's clips, `<version>.cat.glb`, loaded only when someone is drawn
// aboard a kind whose art names it (the catalog's `sailorClips`). Each is
// placed from a place of the starboard side (on the port side for a -port
// clip) of her model's `aboard` node, in her model's frame:
//  - the helm sat on the windward hull's deck by its inner edge, the legs
//    across the net and the feet under the hiking strap (`cat-helm`), and
//    the crew so at the crew's station (`hull`): placed from the deck's
//    inner edge at the station;
//  - the helm sitting out from the hull's outer edge (`cat-hike`), and on
//    the wire from it, out fully and part out (`cat-trapeze`,
//    `cat-trapeze-low`); the crew on the wire beside the helm (`hull-wire`):
//    placed from the deck's outer edge at the station;
//  - crossing the net facing forward, at a crouch (`net-crouch-enter`,
//    `net-crouch-left`, `net-crouch-right`, `net-crouch-exit`) or on hands
//    and knees under the boom (`net-crawl-left`, `net-crawl-right`): placed
//    from the net's middle on her centreline, where it is laced (on its
//    strands, a few millimetres over: the clip stands so). A loop
//    steps or crawls in place: what bears on the net moves the other way at
//    its speed (CROSS_SPEED), so a figure moved that way at that speed,
//    times the rate the clip plays at, keeps it still on the net;
//  - righting her, standing on her lower hull as she lies on her side,
//    hauling hand over hand on the righting line over her upper hull
//    (`cat-righting`): placed from where the feet stand, as on a floor, the
//    figure facing her, upright in the world; it has no -port.

import { Matrix4, type Object3D, Vector3 } from 'three';

/** The clips, by what they are; those on the hull and the wire each have their -port mirror (the crossings go either way, and righting her is the same on either hull). */
export const CAT_CLIPS = {
  helm: 'cat-helm',
  hike: 'cat-hike',
  wire: 'cat-trapeze',
  wireLow: 'cat-trapeze-low',
  crew: 'hull',
  crewWire: 'hull-wire',
  righting: 'cat-righting',
  crouch: ['net-crouch-enter', 'net-crouch-left', 'net-crouch-right', 'net-crouch-exit'],
  crawl: ['net-crawl-left', 'net-crawl-right'],
} as const;

/** How fast the crossings go over the net at their own rate, m/s: sideways, to their side. */
export const CROSS_SPEED: Readonly<Record<string, number>> = {
  'net-crouch-left': 0.5,
  'net-crouch-right': 0.5,
  'net-crawl-left': 0.14,
  'net-crawl-right': 0.14,
};

/** Where each is placed from: the deck's inner or outer edge at the helm's or the crew's station, the net, or where she is righted from. */
export type CatPlace = 'helm-inner' | 'helm-outer' | 'crew-inner' | 'crew-outer' | 'net' | 'stand';

const PORT = '-port';
const ANCHORS: Readonly<Record<string, CatPlace>> = {
  [CAT_CLIPS.helm]: 'helm-inner',
  [CAT_CLIPS.hike]: 'helm-outer',
  [CAT_CLIPS.wire]: 'helm-outer',
  [CAT_CLIPS.wireLow]: 'helm-outer',
  [CAT_CLIPS.crew]: 'crew-inner',
  [CAT_CLIPS.crewWire]: 'crew-outer',
  [CAT_CLIPS.righting]: 'stand',
  ...Object.fromEntries([...CAT_CLIPS.crouch, ...CAT_CLIPS.crawl].map((c) => [c, 'net' as const])),
};
const SIDED: readonly string[] = [
  CAT_CLIPS.helm,
  CAT_CLIPS.hike,
  CAT_CLIPS.wire,
  CAT_CLIPS.wireLow,
  CAT_CLIPS.crew,
  CAT_CLIPS.crewWire,
];
const IN_FILE: readonly string[] = [
  ...SIDED.flatMap((c) => [c, `${c}${PORT}`]),
  CAT_CLIPS.righting,
  ...CAT_CLIPS.crouch,
  ...CAT_CLIPS.crawl,
];

/** Whether a clip is in the beach cat's file. */
export function inCatFile(clip: string): boolean {
  return IN_FILE.includes(clip);
}

/** A look's clips aboard a beach cat, beside its other clips (the art path of its clips' file). */
export function catClips(clips: string): string {
  return clips.replace(/\.clips\.glb$/, '.cat.glb');
}

/** Whether a kind's art names the beach cat's clips. */
export function namesCatClips(art: { sailorClips?: readonly string[] }): boolean {
  return art.sailorClips?.includes('cat') === true;
}

/** The side a clip is on: −1 for a -port one, else +1. */
export function catSide(clip: string): number {
  return clip.endsWith(PORT) ? -1 : 1;
}

/** The place a clip is placed from, or null if it is none of the file's. */
export function catAnchor(clip: string): CatPlace | null {
  const base = clip.endsWith(PORT) ? clip.slice(0, -PORT.length) : clip;
  return ANCHORS[base] ?? null;
}

/** A station's places on the starboard hull, in the model's frame. */
export interface CatStation {
  /** The deck's inner edge, on its top. */
  inner: Vector3;
  /** The deck's outer edge, on its top. */
  outer: Vector3;
  /** The side bar's top, where the net is laced to it. */
  bar: Vector3;
  /** The hiking strap's underside, where the feet go. */
  strap: Vector3;
}

/** The places of a beach cat's people her model marks (its `aboard` node's extras), in the model's frame. */
export interface Aboard {
  helm: CatStation;
  crew: CatStation;
  /** The net: its height where it is laced, its fore and aft edges (z), and how far its middle sags. */
  net: { y: number; fore: number; aft: number; sag: number };
  /** The boom's underside at its lowest. */
  boom: number;
  /** The righting line as it lies on the net: from its end at the starboard pylon to its middle. */
  line: [Vector3, Vector3];
}

function vec(a: unknown): Vector3 | null {
  return Array.isArray(a) &&
    a.length === 3 &&
    a.every((v) => typeof v === 'number' && Number.isFinite(v))
    ? new Vector3(a[0] as number, a[1] as number, a[2] as number)
    : null;
}

function station(d: unknown): CatStation | null {
  const s = d as Record<string, unknown> | undefined;
  const inner = vec(s?.inner);
  const outer = vec(s?.outer);
  const bar = vec(s?.bar);
  const strap = vec(s?.strap);
  return inner === null || outer === null || bar === null || strap === null
    ? null
    : { inner, outer, bar, strap };
}

/** A beach cat's places from her `aboard` node's data, or null if the data is none. */
export function aboardData(data: unknown): Aboard | null {
  const d = data as Record<string, unknown> | undefined;
  const helm = station(d?.helm);
  const crew = station(d?.crew);
  const n = d?.net as Record<string, unknown> | undefined;
  const line = Array.isArray(d?.line) ? (d.line as unknown[]).map(vec) : [];
  const [end, middle] = line;
  const nums = [n?.y, n?.fore, n?.aft, n?.sag, d?.boom];
  if (
    helm === null ||
    crew === null ||
    !nums.every((x) => typeof x === 'number' && Number.isFinite(x)) ||
    end == null ||
    middle == null
  ) {
    return null;
  }
  const [y, fore, aft, sag, boom] = nums as number[];
  return {
    helm,
    crew,
    net: { y: y as number, fore: fore as number, aft: aft as number, sag: sag as number },
    boom: boom as number,
    line: [end, middle],
  };
}

/** A boat's model's beach cat places (its nodes by name), or null if it has none. */
export function aboard(parts: Map<string, Object3D>): Aboard | null {
  return aboardData(parts.get('aboard')?.userData);
}

/**
 * The starboard side's point a clip is placed from, in the model's frame:
 * a station's deck edge, or the net's middle on her centreline where it is
 * laced. Null for righting her, whose place is where she lies.
 */
export function catPoint(a: Aboard, place: CatPlace): Vector3 | null {
  switch (place) {
    case 'helm-inner':
      return a.helm.inner.clone();
    case 'helm-outer':
      return a.helm.outer.clone();
    case 'crew-inner':
      return a.crew.inner.clone();
    case 'crew-outer':
      return a.crew.outer.clone();
    case 'net':
      return new Vector3(0, a.net.y, (a.net.fore + a.net.aft) / 2);
    case 'stand':
      return null;
  }
}

/**
 * A clip's place (from the figure to its starboard point) into the model's
 * frame at a point of the starboard side (at), on the clip's side: the port
 * side's the point's mirror.
 */
export function catPlace(place: Matrix4, at: Vector3, side: number): Matrix4 {
  return new Matrix4().makeTranslation(side * at.x, at.y, at.z).multiply(place);
}
