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

/** How far ahead of where a walk's figure is set its hips are, m: the crossings' figure set this far ahead of a way's point has its hips on it. */
export const YACHT_WALK_AHEAD = 0.2;

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
export const COCKPIT_CROSS = 0.5;
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

/** Her deck as her people's ways need it, from her model's nodes, in her model's frame (the starboard side's; the port's its mirror). */
export interface YachtBoat {
  places: YachtPlaces;
  /** How far out each wheel is: the stance aft of either. */
  spread: number;
  /** The bench: its ends, its top, its front edge out from the centreline (at its node's station) and the sole under it. */
  bench: { fore: number; aft: number; top: number; inner: number; sole: number };
  /** The table on the centreline: its ends and half-width. */
  table: { fore: number; aft: number; halfWidth: number };
  /** The coachroof: its fore end at the roof, its after face (where the cockpit begins), its half-width aft. */
  coachroof: { fore: number; aft: number; halfWidth: number };
  /** The lifelines: their heights over the deck's edge, the stanchions' stations, how far in from the edge, and their ends. */
  lifelines: {
    heights: number[];
    stanchions: number[];
    inboard: number;
    fore: number;
    aft: number;
  } | null;
  /** Her shrouds' chainplates on her starboard side deck, (x, z). */
  chainplates: [number, number][];
}

function numbers(a: unknown): number[] | null {
  return Array.isArray(a) && a.every((x) => typeof x === 'number' && Number.isFinite(x))
    ? (a as number[])
    : null;
}

/** A boat's model's cruising yacht's deck (its nodes by name), or null if it has none. */
export function yachtBoat(parts: Map<string, Object3D>): YachtBoat | null {
  const places = yachtOf(parts);
  if (places === null) {
    return null;
  }
  const data = (name: string, key: string): Record<string, unknown> | undefined =>
    (
      parts.get(name)?.userData as Record<string, Record<string, unknown> | undefined> | undefined
    )?.[key];
  const w = data('wheel', 'wheel');
  const b = data('bench', 'bench');
  const t = data('table', 'table');
  const c = data('coachroof', 'coachroof');
  const l = data('lifelines', 'lifelines');
  const spread = num(w?.spread);
  const bench = [b?.fore, b?.aft, b?.top, b?.inner, b?.sole].map(num);
  const table = [t?.fore, t?.aft, t?.halfWidth].map(num);
  const roof = [c?.fore, c?.aft, c?.halfWidth].map(num);
  if (spread === null || bench.includes(null) || table.includes(null) || roof.includes(null)) {
    return null;
  }
  const [fore, aft, top, inner, sole] = bench as number[];
  const heights = numbers(l?.heights);
  const stanchions = numbers(l?.stanchions);
  const inboard = num(l?.inboard);
  const lfore = num(l?.fore);
  const laft = num(l?.aft);
  const chains = (parts.get('mast')?.userData as { chainplates?: unknown } | undefined)
    ?.chainplates;
  const chainplates = Array.isArray(chains)
    ? chains.filter((c): c is [number, number] => numbers(c)?.length === 2)
    : [];
  return {
    chainplates,
    places,
    spread,
    bench: {
      fore: fore as number,
      aft: aft as number,
      top: top as number,
      inner: inner as number,
      sole: sole as number,
    },
    table: {
      fore: table[0] as number,
      aft: table[1] as number,
      halfWidth: table[2] as number,
    },
    coachroof: { fore: roof[0] as number, aft: roof[1] as number, halfWidth: roof[2] as number },
    lifelines:
      heights === null || stanchions === null || inboard === null || lfore === null || laft === null
        ? null
        : { heights, stanchions, inboard, fore: lfore, aft: laft },
  };
}

// --- Her ways ------------------------------------------------------------------

/**
 * Her people's ways, each a line over her deck, walked at a crouch (her
 * crossing clips), on her starboard side and its mirror:
 *  - through the cockpit: a lane on the sole beside the table, from its
 *    fore end, under the sprayhood, to its after end; across the sole
 *    forward of the table and aft of it (between it and the wheels);
 *  - over the coachroof: a lane along the side deck, outboard of the
 *    shrouds' chainplates and inboard of the lifelines; across the
 *    coachroof's top forward of the mast; and down from the side deck
 *    into the cockpit at its fore end, by the bench's forward end;
 *  - between the wheels: on her centreline from aft of the table to the
 *    stance, and across the stance between the wheels.
 */
export interface YachtWays {
  /** The sole's lane out from the centreline; and where it is crossed, forward of the table and aft of it (z). */
  sole: number;
  foreZ: number;
  aftZ: number;
  /** The stance's line between the wheels (z), and each stance out from the centreline. */
  sternZ: number;
  stance: number;
  /** Where the coachroof is crossed from out from the centreline. */
  roofEnd: number;
  /** Where the coachroof is crossed (z); where the side deck is left for the cockpit (z), by the bench's forward end, and where the cockpit is left for it (z), over the bench's middle; how far out the bench is stepped on (x). */
  roofZ: number;
  downZ: number;
  upZ: number;
  benchEnd: number;
  /** The mast's station: the side deck's lane past it squeezes between the shrouds and the lifelines. */
  mastZ: number;
  /** The side deck's lane out from the centreline at z. */
  lane(z: number): number;
  /** How far her deck's edge turns from fore and aft at z, radians: + widening aft (her bow's). */
  railTurn(z: number): number;
  /**
   * Where a clip on her rail is placed from at z, out from the centreline:
   * the deck's edge there, moved in or out as far as her upper lifeline
   * (straight from stanchion to stanchion) is from where it was beside the
   * place the clips were made at; so the forearms lie on it there too.
   */
  railX(z: number): number;
}

/** How far aft of where her cockpit's crossing clip was made the cockpit is crossed, m: the turn onto the sole's lane clear of the trimmer's knees. */
const AFT_IN = 0.1;
/** How far inboard of the table's side the sole's lane is, m: clear of the feet of those sat on the bench. */
export const SOLE_LANE = 0.32;
/**
 * How far inboard of the deck's edge the side deck's lane is, m: by the
 * shrouds (BY_SHROUDS of a chainplate) and by the cockpit (BY_COCKPIT of its
 * fore end) between the chainplates or the cockpit and the lifelines; else
 * DECK_IN, so that a crouch turning on it (its head well ahead of its
 * hips) keeps its head inboard of the lifelines. Eased over EASE, m.
 */
export const DECK_LANE = 0.25;
export const DECK_IN = 0.45;
const BY_SHROUDS = 0.3;
const BY_COCKPIT = 0.3;
const EASE = 0.3;

function smoothstep(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}
/** How far aft of the middle between the companion's boards and the table the cockpit is crossed forward of the table (the boards stand proud of the coachroof's after face), m; and how far in from the bench's front edge it is stepped on, coming down into the cockpit there. */
const FORE_IN = 0.01;
const BENCH_STEP = 0.25;

/** Her ways from her deck, her deck's edge at z (the hull's: crewrules.ts's plan) and her mast's station. */
export function yachtWays(boat: YachtBoat, edge: (z: number) => number, mastZ: number): YachtWays {
  const p = boat.places;
  return {
    sole: boat.table.halfWidth + SOLE_LANE,
    foreZ: (boat.coachroof.aft + boat.table.fore) / 2 + FORE_IN,
    aftZ: p.sole.z + AFT_IN,
    roofEnd: edge(p.roof.z) - DECK_IN,
    sternZ: p.stance.z,
    stance: boat.spread,
    roofZ: p.roof.z,
    downZ: (boat.coachroof.aft + boat.table.fore) / 2 + FORE_IN,
    upZ: (boat.bench.fore + boat.bench.aft) / 2,
    benchEnd: boat.bench.inner + BENCH_STEP,
    mastZ,
    lane: (z) => {
      const l = lifelineX(boat, edge);
      // Abreast the coachroof and on the foredeck, well in from the edge; by
      // the cockpit and the shrouds, where the side deck is narrow, out.
      const near = Math.min(
        1,
        ...boat.chainplates.map(([, c]) => Math.max(0, (Math.abs(z - c) - BY_SHROUDS) / EASE)),
      );
      const fore = Math.min(1, Math.max(0, (boat.coachroof.aft - BY_COCKPIT - z) / EASE));
      const inset = DECK_LANE + (DECK_IN - DECK_LANE) * smoothstep(Math.min(near, fore));
      return Math.min(edge(z) - inset, l === null ? Number.POSITIVE_INFINITY : l(z) - LIFELINE_IN);
    },
    railTurn: (z) => Math.atan2(edge(z + 0.1) - edge(z - 0.1), 0.2),
    railX: (z) => {
      const line = lifelineX(boat, edge);
      return line === null ? edge(z) : line(z) + (edge(p.rail.z) - line(p.rail.z));
    },
  };
}

/** Her lifelines out from the centreline at z, straight from stanchion to stanchion (each the deck's edge less how far inboard they stand); null without them. */
export function lifelineX(
  boat: YachtBoat,
  edge: (z: number) => number,
): ((z: number) => number) | null {
  const l = boat.lifelines;
  if (l === null || l.stanchions.length < 2) {
    return null;
  }
  const zs = [...l.stanchions].sort((a, b) => a - b);
  return (z) => {
    let i = 0;
    while (i + 2 < zs.length && z > (zs[i + 1] as number)) {
      i++;
    }
    const a = zs[i] as number;
    const b = zs[i + 1] as number;
    const f = b === a ? 0 : (z - a) / (b - a);
    const xa = edge(a) - l.inboard;
    const xb = edge(b) - l.inboard;
    return xa + (xb - xa) * f;
  };
}

/** A place on her a way begins or ends at: a station's (on the bench or the rail) or the stance aft of a wheel (the helm's), on a side. */
export interface YachtSpot {
  /** Where on her: the bench, the rail, or the helm at the wheel; and its station (z). */
  at: 'bench' | 'rail' | 'helm';
  z: number;
  side: number;
}

/** A node of her ways: a point (x, z) and the stretches from it, to which node and at what cost a metre. */
interface WayNode {
  x: number;
  z: number;
  to: { node: number; cost: number }[];
}

/** How much more a metre costs on the windward sole's lane, walking to or from the helm: past the feet of those sat on the windward bench. */
const WINDWARD_SOLE = 1.5;
/** How much more a metre costs along the side deck past the mast (between the shrouds and the lifelines: only when there is no other way). */
const PAST_SHROUDS = 6;
/** A station's place this near where a way turns is taken at it, m. */
const AT_TURN = 0.15;
/** Coming down into the cockpit at its forward end, how far outboard of the sole's lane the turn aft is, and how far aft the way is back on the lane, m: the crouch's head kept clear of the table's end. */
const TURN_OUT = 0.25;
const TURN_AFT = 0.55;
/** How far short of a wheel's stance a way to it ends, m: the crouch's head well ahead of its hips, it stands up from there. */
export const STANCE_SHORT = 0.35;
/** How far inboard of her lifelines the side deck's lane keeps, m: where her bow narrows inside their straight line. */
const LIFELINE_IN = 0.24;

/**
 * The way from a spot to another over her deck, as points (x, z), the
 * cheapest by her ways: from where the person stands up (the sole's lane
 * beside a bench's station, the side deck's beside a station on the rail,
 * the stance at a wheel) to where they sit down. windward is the side the
 * crew sits on (+1 starboard): its sole's lane is dear (lee, when changing
 * places, keeps out of the feet of those sat to windward); null keeps both
 * alike (crossing).
 */
export function yachtWay(
  ways: YachtWays,
  from: YachtSpot,
  to: YachtSpot,
  benchZs: readonly number[],
  railZs: readonly number[],
  windward: number | null = null,
): [number, number][] {
  const nodes: WayNode[] = [];
  /** A station on the rail's z, or the turn's it is near. */
  const turnAt = (z: number): number =>
    Math.abs(z - ways.roofZ) < AT_TURN
      ? ways.roofZ
      : Math.abs(z - ways.downZ) < AT_TURN
        ? ways.downZ
        : z;
  const add = (x: number, z: number): number => {
    const k = nodes.findIndex((n) => Math.abs(n.x - x) < 1e-6 && Math.abs(n.z - z) < 1e-6);
    if (k >= 0) {
      return k;
    }
    nodes.push({ x, z, to: [] });
    return nodes.length - 1;
  };
  const join = (a: number, b: number, cost = 1, oneWay = false): void => {
    (nodes[a] as WayNode).to.push({ node: b, cost });
    if (!oneWay) {
      (nodes[b] as WayNode).to.push({ node: a, cost });
    }
  };
  const line = (ids: number[], cost = 1): void => {
    for (let i = 0; i + 1 < ids.length; i++) {
      join(ids[i] as number, ids[i + 1] as number, cost);
    }
  };
  const sorted = (zs: number[]): number[] =>
    [...new Set(zs.map((z) => Math.round(z * 1e4) / 1e4))].sort((a, b) => a - b);
  for (const s of [1, -1]) {
    // The sole's lane, and the crossing aft of the table.
    const soleZs = sorted([ways.downZ + TURN_AFT, ways.aftZ, ways.upZ, ...benchZs]);
    const sole = soleZs.map((z) => add(s * ways.sole, z));
    line(sole, windward === s ? WINDWARD_SOLE : 1);
    const aft = add(s * ways.sole, ways.aftZ);
    join(aft, add(0, ways.aftZ));
    // Between the wheels, to short of each stance.
    const centre = add(0, ways.sternZ);
    join(add(0, ways.aftZ), centre);
    join(centre, add(s * (ways.stance - STANCE_SHORT), ways.sternZ));
    // The side deck's lane, and the coachroof's crossing forward of the mast.
    // Where it is crossed, out by the edge: turning in toward the coachroof,
    // the crouch's knees are well ahead of its hips.
    const deckZs = sorted([ways.roofZ, ways.downZ, ways.upZ, ...railZs.map(turnAt)]);
    const deck = deckZs.map((z) => add(s * (z === ways.roofZ ? ways.roofEnd : ways.lane(z)), z));
    for (let i = 0; i + 1 < deck.length; i++) {
      const past =
        ((deckZs[i] as number) - ways.mastZ) * ((deckZs[i + 1] as number) - ways.mastZ) < 0;
      join(deck[i] as number, deck[i + 1] as number, past ? PAST_SHROUDS : 1);
    }
    const roof = add(s * ways.roofEnd, ways.roofZ);
    join(roof, add(-s * ways.roofEnd, ways.roofZ));
    // Changing places, on the lee side only (to windward the bench is sat
    // on): down into the cockpit by the bench's forward end, facing in,
    // turning aft clear of the table; never up there (facing forward to
    // turn out of the cockpit, a crouch's head is in the companion). Up
    // out of it over the bench's middle, facing out.
    if (windward !== null && windward !== s) {
      const step = add(s * ways.benchEnd, ways.downZ);
      const turn = add(s * (ways.sole + TURN_OUT), ways.downZ);
      join(add(s * ways.lane(ways.downZ), ways.downZ), step, 1, true);
      join(step, turn, 1, true);
      join(turn, add(s * ways.sole, ways.downZ + TURN_AFT), 1, true);
      const up = add(s * ways.benchEnd, ways.upZ);
      join(add(s * ways.sole, ways.upZ), up, 1, true);
      join(up, add(s * ways.lane(ways.upZ), ways.upZ), 1, true);
    }
  }
  const node = (spot: YachtSpot): number => {
    const s = spot.side < 0 ? -1 : 1;
    switch (spot.at) {
      case 'bench':
        return add(s * ways.sole, spot.z);
      case 'rail': {
        const z = turnAt(spot.z);
        return add(s * (z === ways.roofZ ? ways.roofEnd : ways.lane(z)), z);
      }
      default:
        return add(s * (ways.stance - STANCE_SHORT), ways.sternZ);
    }
  };
  const a = node(from);
  const b = node(to);
  // The cheapest way, by Dijkstra's search: a few dozen nodes.
  const cost = nodes.map(() => Number.POSITIVE_INFINITY);
  const back = nodes.map(() => -1);
  const done = nodes.map(() => false);
  cost[a] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < nodes.length; i++) {
      if (!done[i] && (u < 0 || (cost[i] as number) < (cost[u] as number))) {
        u = i;
      }
    }
    if (u < 0 || !Number.isFinite(cost[u] as number) || u === b) {
      break;
    }
    done[u] = true;
    const n = nodes[u] as WayNode;
    for (const e of n.to) {
      const m = nodes[e.node] as WayNode;
      const c = (cost[u] as number) + Math.hypot(m.x - n.x, m.z - n.z) * e.cost;
      if (c < (cost[e.node] as number)) {
        cost[e.node] = c;
        back[e.node] = u;
      }
    }
  }
  const out: [number, number][] = [];
  for (let i = b; i >= 0; i = back[i] as number) {
    const n = nodes[i] as WayNode;
    out.unshift([n.x, n.z]);
    if (i === a) {
      break;
    }
  }
  return out;
}
