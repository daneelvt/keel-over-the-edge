// SPDX-License-Identifier: AGPL-3.0-only

// A cruising catamaran's people, as their clips have it: a file of its own
// beside a look's clips, `<version>.bridgedeck.glb`, loaded only when
// someone is drawn aboard a kind whose art names it (the catalog's
// `sailorClips`). Each is placed from a place of hers read from her model's
// nodes (the `sailor` node, and the `seats` node's data), in her model's
// frame, turned the way that place faces (a station's facing: degrees from
// ahead toward starboard):
//  - the helm at her wheel, standing aft of it, the hands on its rim
//    (`bridge-wheel`), and the look's habit there (`bridge-habit-wheel`);
//    and sat on the settle behind the helm's stance (`bridge-wheel-seated`):
//    placed from her stance (the `sailor` node), facing forward;
//  - sat on her seats facing as each faces, the feet on the floor before
//    it, the ship's company's idles (still, shifting, nodding off,
//    talking): on the settle beside the helm (`helm-seat`), on the bench
//    round her table (`table-`), on her aft bench (`beam-`) and on her
//    lounger (`lounger-`); and braced at the table, a hand gripping its
//    edge (`table-braced`), and on the aft bench, leaning back against its
//    rail, a leg braced out (`beam-braced`): each placed from its seat's
//    front edge where its clips are made (the `seats` node's `at`);
//  - walking her cockpit facing forward (`cockpit-walk`) and turning on the
//    spot (`cockpit-turn-left`, `cockpit-turn-right`): placed from her sole
//    where it is walked. The walk is in place: what bears on the sole moves
//    back at its speed (BRIDGE_WALK_SPEED), so a figure moved forward at
//    that speed keeps its feet still;
//  - up her helm's ladder from its foot (`stairs-up`) and down it from its
//    landing (`stairs-down`), once through, the body carried up or down it
//    by the clip: placed from its foot and its landing.
// A clip's -port is at the same place, the figure its own mirror image: for
// the wind over her port side (her places are hers alone, none mirrored
// across her).

import { Matrix4, type Object3D, Vector3 } from 'three';

/** The clips, by what they are; those at the wheel and the braced each have their -port mirror. */
export const BRIDGE_CLIPS = {
  wheel: 'bridge-wheel',
  habit: 'bridge-habit-wheel',
  seated: 'bridge-wheel-seated',
  helmSeat: ['helm-seat', 'helm-seat-shift', 'helm-seat-nod', 'helm-seat-talk'],
  table: ['table-sit', 'table-shift', 'table-nod', 'table-talk'],
  tableBraced: 'table-braced',
  beam: ['beam-sit', 'beam-shift', 'beam-nod', 'beam-talk'],
  beamBraced: 'beam-braced',
  lounger: ['lounger-sit', 'lounger-shift', 'lounger-nod', 'lounger-talk'],
  walk: 'cockpit-walk',
  turnLeft: 'cockpit-turn-left',
  turnRight: 'cockpit-turn-right',
  up: 'stairs-up',
  down: 'stairs-down',
} as const;

/** The clips a machine has not: its hands would meet its plates. */
export const BRIDGE_NOT_FOR_MACHINES: readonly string[] = [];

/** How fast the walk goes over the sole at its own rate, m/s, forward as it faces. */
export const BRIDGE_WALK_SPEED = 0.9;

/** Where each is placed from: the helm's stance, a seat's front edge, the sole where it is walked, the ladder's foot or its landing. */
export type BridgePlace =
  | 'stance'
  | 'helm'
  | 'table'
  | 'beam'
  | 'lounger'
  | 'sole'
  | 'foot'
  | 'landing';

const PORT = '-port';
const ANCHORS: Readonly<Record<string, BridgePlace>> = {
  [BRIDGE_CLIPS.wheel]: 'stance',
  [BRIDGE_CLIPS.habit]: 'stance',
  [BRIDGE_CLIPS.seated]: 'stance',
  ...Object.fromEntries(BRIDGE_CLIPS.helmSeat.map((c) => [c, 'helm' as const])),
  ...Object.fromEntries(BRIDGE_CLIPS.table.map((c) => [c, 'table' as const])),
  [BRIDGE_CLIPS.tableBraced]: 'table',
  ...Object.fromEntries(BRIDGE_CLIPS.beam.map((c) => [c, 'beam' as const])),
  [BRIDGE_CLIPS.beamBraced]: 'beam',
  ...Object.fromEntries(BRIDGE_CLIPS.lounger.map((c) => [c, 'lounger' as const])),
  [BRIDGE_CLIPS.walk]: 'sole',
  [BRIDGE_CLIPS.turnLeft]: 'sole',
  [BRIDGE_CLIPS.turnRight]: 'sole',
  [BRIDGE_CLIPS.up]: 'foot',
  [BRIDGE_CLIPS.down]: 'landing',
};
const SIDED: readonly string[] = [
  BRIDGE_CLIPS.wheel,
  BRIDGE_CLIPS.seated,
  BRIDGE_CLIPS.tableBraced,
  BRIDGE_CLIPS.beamBraced,
];
const IN_FILE: readonly string[] = [
  ...SIDED.flatMap((c) => [c, `${c}${PORT}`]),
  ...Object.keys(ANCHORS).filter((c) => !SIDED.includes(c)),
];

/** Every clip of the catamaran's file. */
export const BRIDGE_FILE: readonly string[] = IN_FILE;

/** Whether a clip is in the catamaran's file. */
export function inBridgeFile(clip: string): boolean {
  return IN_FILE.includes(clip);
}

/** A look's clips aboard a catamaran, beside its other clips (the art path of its clips' file). */
export function bridgeClips(clips: string): string {
  return clips.replace(/\.clips\.glb$/, '.bridgedeck.glb');
}

/** Whether a kind's art names the cruising catamaran's clips. */
export function namesBridgeClips(art: { sailorClips?: readonly string[] }): boolean {
  return art.sailorClips?.includes('bridgedeck') === true;
}

/** The side a clip is on: −1 for a -port one (the figure's mirror image), else +1. */
export function bridgeSide(clip: string): number {
  return clip.endsWith(PORT) ? -1 : 1;
}

/** The place a clip is placed from, or null if it is none of the file's. */
export function bridgeAnchor(clip: string): BridgePlace | null {
  const base = clip.endsWith(PORT) ? clip.slice(0, -PORT.length) : clip;
  return ANCHORS[base] ?? null;
}

/** A place of hers: a point in her model's frame, and the way one there faces (degrees from ahead toward starboard). */
export interface BridgeAnchor {
  at: Vector3;
  facing: number;
}

/** Her places her people's clips are placed from. */
export type BridgePlaces = Readonly<Record<BridgePlace, BridgeAnchor>>;

function num(a: unknown): number | null {
  return typeof a === 'number' && Number.isFinite(a) ? a : null;
}

function vec(a: unknown): Vector3 | null {
  if (!Array.isArray(a) || a.length !== 3) {
    return null;
  }
  const [x, y, z] = a.map(num);
  return x == null || y == null || z == null ? null : new Vector3(x, y, z);
}

/**
 * Her places from her model's nodes' places and data (by name): the
 * `sailor` node (the helm's stance, facing forward), and the `seats`
 * node's: each seat's `at` and `facing`, her sole where it is walked
 * (`walk`, facing forward), her ladder's foot (facing up it, forward) and
 * its head (facing down it, aft). Null if she lacks any of them.
 */
export function bridgePlaces(
  nodes: (name: string) => { at: Vector3; data: unknown } | null,
): BridgePlaces | null {
  const sailor = nodes('sailor');
  const seats = (nodes('seats')?.data as { seats?: Record<string, unknown> } | undefined)?.seats;
  if (sailor == null || seats === undefined) {
    return null;
  }
  const seat = (key: string): BridgeAnchor | null => {
    const s = seats[key] as { at?: unknown; facing?: unknown } | undefined;
    const at = vec(s?.at);
    const facing = num(s?.facing);
    return at === null || facing === null ? null : { at, facing };
  };
  const stairs = seats.stairs as { foot?: unknown; head?: unknown } | undefined;
  const walk = vec(seats.walk);
  const foot = vec(stairs?.foot);
  const head = vec(stairs?.head);
  const helm = seat('helm');
  const table = seat('table');
  const beam = seat('beam');
  const lounger = seat('lounger');
  if (
    walk === null ||
    foot === null ||
    head === null ||
    helm === null ||
    table === null ||
    beam === null ||
    lounger === null
  ) {
    return null;
  }
  return {
    stance: { at: sailor.at.clone(), facing: 0 },
    helm,
    table,
    beam,
    lounger,
    sole: { at: walk, facing: 0 },
    foot: { at: foot, facing: 0 },
    landing: { at: head, facing: 180 },
  };
}

/** A boat's model's catamaran's places (its nodes by name), or null if it has none. */
export function bridgeOf(parts: Map<string, Object3D>): BridgePlaces | null {
  return bridgePlaces((name) => {
    const o = parts.get(name);
    return o === undefined ? null : { at: o.position.clone(), data: o.userData };
  });
}

/**
 * A clip's place (from the figure to its place, the place facing ahead)
 * into the model's frame at one of her places: moved to it and turned the
 * way it faces. A -port clip is placed as its starboard one is.
 */
export function bridgePlace(place: Matrix4, anchor: BridgeAnchor, out = new Matrix4()): Matrix4 {
  out.makeRotationY((-anchor.facing * Math.PI) / 180);
  out.setPosition(anchor.at);
  return out.multiply(place);
}
