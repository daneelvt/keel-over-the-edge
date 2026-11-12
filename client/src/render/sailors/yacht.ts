// SPDX-License-Identifier: AGPL-3.0-only

// A yacht's people, as their clips have it: a file of its own beside a
// look's clips, `<version>.cruiser.glb`, loaded only when someone is drawn
// aboard a kind whose art names it (the catalog's `sailorClips`). Each is
// placed from a place of her starboard side (on the port side for a -port
// clip), in her model's frame, read from her model's nodes:
//  - the helm at her windward wheel, standing aft of it, the hands on its
//    rim (`yacht-wheel`), and sat on the side deck outboard of it, perched
//    on its inner edge, leaning forward to the rim, a foot braced on the
//    sole (`yacht-wheel-seated`); and the look's habit there
//    (`yacht-habit-wheel`): placed from the stance aft of the wheel (the
//    `sailor` node moved out to the wheel by the `wheel` node's spread);
//  - on the cockpit's bench facing inboard, the feet on the sole: the
//    ship's company's idles sat on it (`bench`, `bench-shift`, `bench-nod`,
//    `bench-talk`), and braced as she heels, leaning back, a foot further
//    out (`bench-braced`): placed from the bench's front edge, on its top
//    (the `bench` node's `inner` and `top` at its station). The idles have
//    no -port: on the port bench they are the same turned about her
//    middle;
//  - on her rail facing outboard, the legs over the side under the lower
//    lifeline, the forearms over the upper, upright and leaning out
//    (`yacht-rail`, `yacht-rail-out`): placed from the deck's edge at the
//    station;
//  - crossing her cockpit and her coachroof at a crouch, facing across her
//    (`cockpit-crouch-walk`, `roof-crouch-walk`, made facing port: between
//    the coachroof's after face and the table there is no room fore and aft
//    for a crouch facing forward): placed from the sole, aft of the table,
//    or the coachroof's top, on her centreline. A loop walks in place: what bears
//    on the deck moves back at its speed (YACHT_CROSS_SPEED), so a figure
//    moved forward at that speed, times the rate the clip plays at, keeps
//    its feet still.

import { Matrix4, type Object3D, Vector3 } from 'three';

/** The clips, by what they are; those at the wheel, on the rail and braced on the bench each have their -port mirror. */
export const YACHT_CLIPS = {
  wheel: 'yacht-wheel',
  seated: 'yacht-wheel-seated',
  habit: 'yacht-habit-wheel',
  bench: ['bench', 'bench-shift', 'bench-nod', 'bench-talk'],
  braced: 'bench-braced',
  rail: 'yacht-rail',
  railOut: 'yacht-rail-out',
  cockpit: 'cockpit-crouch-walk',
  roof: 'roof-crouch-walk',
} as const;

/** The clips a machine has not: its hands would meet its plates. */
export const YACHT_NOT_FOR_MACHINES: readonly string[] = ['bench-talk'];

/** How fast the crossings go over the deck at their own rate, m/s, forward as they face. */
export const YACHT_CROSS_SPEED: Readonly<Record<string, number>> = {
  'cockpit-crouch-walk': 0.7,
  'roof-crouch-walk': 0.7,
};

/** Where each is placed from: the stance aft of the wheel, the bench's front edge, the deck's edge, the sole or the coachroof's top on her centreline. */
export type YachtPlace = 'stance' | 'bench' | 'rail' | 'sole' | 'roof';

const PORT = '-port';
const ANCHORS: Readonly<Record<string, YachtPlace>> = {
  [YACHT_CLIPS.wheel]: 'stance',
  [YACHT_CLIPS.seated]: 'stance',
  [YACHT_CLIPS.habit]: 'stance',
  [YACHT_CLIPS.braced]: 'bench',
  [YACHT_CLIPS.rail]: 'rail',
  [YACHT_CLIPS.railOut]: 'rail',
  [YACHT_CLIPS.roof]: 'roof',
  [YACHT_CLIPS.cockpit]: 'sole',
  ...Object.fromEntries(YACHT_CLIPS.bench.map((c) => [c, 'bench' as const])),
};
const SIDED: readonly string[] = [
  YACHT_CLIPS.wheel,
  YACHT_CLIPS.seated,
  YACHT_CLIPS.braced,
  YACHT_CLIPS.rail,
  YACHT_CLIPS.railOut,
];
const IN_FILE: readonly string[] = [
  ...SIDED.flatMap((c) => [c, `${c}${PORT}`]),
  YACHT_CLIPS.habit,
  ...YACHT_CLIPS.bench,
  YACHT_CLIPS.cockpit,
  YACHT_CLIPS.roof,
];

/** Every clip of the yacht's file. */
export const YACHT_FILE: readonly string[] = IN_FILE;

/** Whether a clip is in the yacht's file. */
export function inYachtFile(clip: string): boolean {
  return IN_FILE.includes(clip);
}

/** A look's clips aboard a yacht, beside its other clips (the art path of its clips' file). */
export function yachtClips(clips: string): string {
  return clips.replace(/\.clips\.glb$/, '.cruiser.glb');
}

/** Whether a kind's art names the cruising yacht's clips. */
export function namesYachtClips(art: { sailorClips?: readonly string[] }): boolean {
  return art.sailorClips?.includes('cruiser') === true;
}

/** The side a clip is on: −1 for a -port one, else +1. */
export function yachtSide(clip: string): number {
  return clip.endsWith(PORT) ? -1 : 1;
}

/** The place a clip is placed from, or null if it is none of the file's. */
export function yachtAnchor(clip: string): YachtPlace | null {
  const base = clip.endsWith(PORT) ? clip.slice(0, -PORT.length) : clip;
  return ANCHORS[base] ?? null;
}

/**
 * Where her cockpit is crossed, m aft of her table's after end (forward of
 * the wheels: forward of the table, by the coachroof's after face, there is
 * no room fore and aft for a crouch); and her coachroof, m aft of its fore end
 * (forward of the mast, over its scuttle: aft of the mast her boom is lower
 * over it than a crouching figure's hat).
 */
export const COCKPIT_CROSS = 0.45;
export const ROOF_CROSS = 0.5;

/** A yacht's places her people's clips are placed from, on her starboard side or her centreline, in her model's frame. */
export interface YachtPlaces {
  /** The stance aft of her starboard wheel, on the sole. */
  stance: Vector3;
  /** The bench's front edge, on its top, at its node's station. */
  bench: Vector3;
  /** The deck's edge at the rail's station (her `rail` node). */
  rail: Vector3;
  /** The sole on her centreline where her cockpit is crossed. */
  sole: Vector3;
  /** Her coachroof's top on her centreline where it is crossed: the roof's crown (its scuttles stand a little over it). */
  roof: Vector3;
}

function num(a: unknown): number | null {
  return typeof a === 'number' && Number.isFinite(a) ? a : null;
}

/**
 * Her places from her model's nodes' places and data (by name): the
 * `sailor` node and the `wheel` node's spread; the `bench` node's front
 * edge, top and sole; the `rail` node; the `table` node's after end; the
 * `coachroof` node's fore end and top. Null if she lacks any of them.
 */
export function yachtPlaces(
  nodes: (name: string) => { at: Vector3; data: unknown } | null,
): YachtPlaces | null {
  const sailor = nodes('sailor');
  const wheel = nodes('wheel');
  const bench = nodes('bench');
  const rail = nodes('rail');
  const table = nodes('table');
  const roof = nodes('coachroof');
  const spread = num((wheel?.data as { wheel?: { spread?: unknown } } | undefined)?.wheel?.spread);
  const b = (bench?.data as { bench?: Record<string, unknown> } | undefined)?.bench;
  const inner = num(b?.inner);
  const top = num(b?.top);
  const sole = num(b?.sole);
  const aft = num((table?.data as { table?: { aft?: unknown } } | undefined)?.table?.aft);
  const roofFore = num(
    (roof?.data as { coachroof?: { fore?: unknown } } | undefined)?.coachroof?.fore,
  );
  if (
    sailor == null ||
    bench == null ||
    rail == null ||
    roof == null ||
    spread === null ||
    spread <= 0 ||
    inner === null ||
    top === null ||
    sole === null ||
    aft === null ||
    roofFore === null
  ) {
    return null;
  }
  return {
    stance: sailor.at.clone().setX(sailor.at.x + spread),
    bench: new Vector3(inner, top, bench.at.z),
    rail: rail.at.clone(),
    sole: new Vector3(0, sole, aft + COCKPIT_CROSS),
    roof: new Vector3(0, roof.at.y, roofFore + ROOF_CROSS),
  };
}

/** A boat's model's cruising yacht's places (its nodes by name), or null if it has none. */
export function yachtOf(parts: Map<string, Object3D>): YachtPlaces | null {
  return yachtPlaces((name) => {
    const o = parts.get(name);
    return o === undefined ? null : { at: o.position.clone(), data: o.userData };
  });
}

/**
 * A clip's place (from the figure to its starboard point) into the model's
 * frame at a point of the starboard side (at), on a side: the port side's
 * the point's mirror. A clip without a -port (the bench's idles, the
 * crossings) is turned about her middle onto the port side (turn), as a
 * seat facing inboard is.
 */
export function yachtPlace(
  place: Matrix4,
  at: Vector3,
  side: number,
  turn = false,
  out = new Matrix4(),
): Matrix4 {
  out.makeTranslation(side * at.x, at.y, at.z);
  if (turn && side < 0) {
    out.multiply(new Matrix4().makeRotationY(Math.PI));
  }
  return out.multiply(place);
}
