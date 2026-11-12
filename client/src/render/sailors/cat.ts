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

import { Matrix4, Mesh, type Object3D, Raycaster, Vector3 } from 'three';

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
export function catPoint(a: Aboard, place: CatPlace, out = new Vector3()): Vector3 | null {
  switch (place) {
    case 'helm-inner':
      return out.copy(a.helm.inner);
    case 'helm-outer':
      return out.copy(a.helm.outer);
    case 'crew-inner':
      return out.copy(a.crew.inner);
    case 'crew-outer':
      return out.copy(a.crew.outer);
    case 'net':
      return out.set(0, a.net.y, (a.net.fore + a.net.aft) / 2);
    case 'stand':
      return null;
  }
}

/**
 * A clip's place (from the figure to its starboard point) into the model's
 * frame at a point of the starboard side (at), on the clip's side: the port
 * side's the point's mirror.
 */
export function catPlace(place: Matrix4, at: Vector3, side: number, out = new Matrix4()): Matrix4 {
  return out.makeTranslation(side * at.x, at.y, at.z).multiply(place);
}

/**
 * How her people cross her net: sideways, facing forward, along her net's
 * middle, clear of both beams (a figure on hands and knees is near the
 * net's length, its head by the front beam and its feet by the rear), each
 * in turn, from this far inboard of the side bar on the side left to as far
 * on the other: at a crouch, at CROUCH_ACROSS, and on hands and knees where
 * the boom leaves less headroom than the crouch, at CRAWL_ACROSS (the
 * crawl's own pace, about twice the clip's), going over from one to the
 * other in CRAWL_CHANGE. The crouch is in the boom's way within CRAWL_NEAR
 * of its line seen from above, clear of it from CRAWL_FAR.
 */
export const CROSS_IN = 0.25;
export const CROUCH_ACROSS = 0.8;
export const CRAWL_ACROSS = 0.3;
export const CRAWL_CHANGE = 0.4;
export const CRAWL_NEAR = 0.45;
export const CRAWL_FAR = 0.7;

/** The way across her net: its z, and how far out each end is from the centreline. */
export function netWay(a: Aboard): { z: number; x: number } {
  return { z: (a.net.fore + a.net.aft) / 2, x: a.helm.bar.x - CROSS_IN };
}

/** Her boom as the crossing needs it: its gooseneck's height and z, and its length. */
export interface CatBoom {
  y: number;
  z: number;
  length: number;
}

/** What a beach cat's people need of her, in her model's frame. */
export interface CatBoat {
  /** The places her people's clips are placed from (her model's `aboard` node). */
  aboard: Aboard;
  /** Her boom: under it the net is crossed on hands and knees. */
  boom: CatBoom;
  /** Where her sailor stands on her lower hull to right her, lying to port (standOf's); and her crew, beside them (CREW_BESIDE aft); null if not found. */
  stand: Vector3 | null;
  crewStand: Vector3 | null;
  /** Each side's crew's trapeze ring (starboard, port) and the hounds, where the crew's wire hangs from; null if she has none. */
  crewRings: [Vector3, Vector3] | null;
  hounds: Vector3 | null;
}

/** How far aft of her sailor her crew stands to right her beside them, on her lower hull, m. */
export const CREW_BESIDE = 1.15;

/**
 * How far on hands and knees (0 to 1) someone crossing at x on the way at
 * z must be under the boom (radians, + starboard): wholly within
 * CRAWL_NEAR of its line seen from above, not at all from CRAWL_FAR.
 */
export function crawlFor(boom: CatBoom, angle: number, x: number, z: number): number {
  const dx = Math.sin(angle);
  const dz = Math.cos(angle);
  const pz = z - boom.z;
  const d = Math.max(0, Math.min(boom.length, x * dx + pz * dz));
  const off = Math.hypot(x - d * dx, pz - d * dz);
  return off <= CRAWL_NEAR
    ? 1
    : off >= CRAWL_FAR
      ? 0
      : (CRAWL_FAR - off) / (CRAWL_FAR - CRAWL_NEAR);
}

/**
 * Someone crossing her net, from the side left (+1 starboard) to the
 * other: where they are across (x), how far on hands and knees, and each
 * loop's own time, its feet kept on the net as the figure moves.
 */
export class NetCross {
  x: number;
  crawl = 0;
  /** The crouch's and the crawl's clip times, seconds. */
  crouchT = 0;
  crawlT = 0;
  constructor(
    readonly from: number,
    /** How far out each end is. */
    readonly end: number,
    /** The crawl to begin with. */
    crawl = 0,
  ) {
    this.x = from * end;
    this.crawl = crawl;
  }

  /** How far across, 0 to 1. */
  get done(): number {
    return Math.min(1, Math.max(0, (this.end - this.from * this.x) / (2 * this.end)));
  }

  /** dt seconds on, the crawl wanted where they are: whether they have come to the other end. */
  step(dt: number, want: number): boolean {
    const k = dt / CRAWL_CHANGE;
    this.crawl =
      want > this.crawl ? Math.min(want, this.crawl + k) : Math.max(want, this.crawl - k);
    const speed = CROUCH_ACROSS + (CRAWL_ACROSS - CROUCH_ACROSS) * this.crawl;
    const left = this.x + this.from * this.end;
    const ds = Math.min(speed * dt, Math.max(0, this.from * left));
    this.x -= this.from * ds;
    // Each loop on as far as its feet would carry it.
    this.crouchT += ds / (CROSS_SPEED['net-crouch-left'] ?? 0.5);
    this.crawlT += ds / (CROSS_SPEED['net-crawl-left'] ?? 0.14);
    return this.from * this.x <= -this.end + 1e-6;
  }

  /** The loops for its way: to port, the left ones. */
  get crouch(): string {
    return this.from > 0 ? 'net-crouch-left' : 'net-crouch-right';
  }

  get crawlClip(): string {
    return this.from > 0 ? 'net-crawl-left' : 'net-crawl-right';
  }
}

/**
 * Where someone stands to right her, on her lower hull as she lies on her
 * side (to port: the port hull lowest), at z, in her model's frame: where a
 * line straight down (as she lies) over the hull's middle meets her hull's
 * side that faces the sky; null if it meets none. keel is how far out each
 * hull's centreline is.
 */
export function standOf(model: Object3D, keel: number, z: number): Vector3 | null {
  const hull = model.getObjectByName('hull');
  if (hull === undefined) {
    return null;
  }
  model.updateMatrixWorld(true);
  const toModel = model.matrixWorld.clone().invert();
  const meshes: Mesh[] = [];
  hull.traverse((o) => {
    if (o instanceof Mesh) {
      meshes.push(o);
    }
  });
  // Lying to port, down is her model's −x.
  const from = new Vector3(-keel + 0.6, STAND_Y, z).applyMatrix4(model.matrixWorld);
  const down = new Vector3(-1, 0, 0).transformDirection(model.matrixWorld);
  const hit = new Raycaster(from, down).intersectObjects(meshes, false)[0];
  return hit === undefined ? null : hit.point.applyMatrix4(toModel);
}

/** How high up her hull's side, from her waterline, the feet stand to right her, m. */
export const STAND_Y = 0.05;

const RZ = new Matrix4();
const RY = new Matrix4();

/**
 * A righting clip's place (from the figure to where its feet stand) into
 * her model's frame on her lower hull, low (−1 lying to port, +1 to
 * starboard), from where one stands to port (standOf's): upright in the
 * world as she lies on her side; on her starboard hull, turned about the
 * vertical to face her as on the port.
 */
export function standPlace(
  place: Matrix4,
  stand: Vector3,
  low: number,
  out = new Matrix4(),
): Matrix4 {
  out.makeTranslation(low < 0 ? stand.x : -stand.x, stand.y, stand.z);
  if (low < 0) {
    out.multiply(RZ.makeRotationZ(-Math.PI / 2));
  } else {
    out.multiply(RZ.makeRotationZ(Math.PI / 2)).multiply(RY.makeRotationY(Math.PI));
  }
  return out.multiply(place);
}
