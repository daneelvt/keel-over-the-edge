// SPDX-License-Identifier: AGPL-3.0-only

// The tall ship's company, as its clips have it: two files beside a look's
// clips, each loaded only when someone is drawn who needs them.
//
// `<version>.ship.glb`, about her decks:
//  - standing about, not placed (the figure at its origin facing +z, the
//    soles on a flat deck): `look-about`, `fold-arms` (not a machine's),
//    `talking`;
//  - leaning on her rail facing outboard, the forearms on the cap rail's
//    top (`leaning`), placed from the cap rail's inner edge on its top;
//  - sat on her fore hatch's forward edge facing forward (`hatch-sit`,
//    `hatch-shift`, `hatch-nod`, `hatch-talk`), placed from that edge on her
//    centreline;
//  - walking in place (`walk`): a foot bearing on the deck moves back (−z)
//    at WALK_SPEED, so a figure moved forward at that speed, times the rate
//    the clip plays at, keeps its feet still. Not placed.
//
// `<version>.aloft.glb`, her work and aloft, each with its -port mirror:
//  - hauling on the main brace's fall hand over hand, facing its lead
//    (`haul`), placed from the point of the fall the hands are about;
//  - standing in the main top, a hand on a topmast shroud (`aloft`),
//    placed from the top's floor at her centreline;
//  - lying over the main topsail yard on its footrope (`yard`), placed from
//    the yard's axis over the footrope's point it stands at: put it under
//    the yard's node, so it turns with the braces and comes down with the
//    reefed yard.
//
// Every placed clip is placed from a place of the starboard side (on the
// port side for a -port clip) of her model's `company` node. A clip with no
// -port is put on the port side by its place mirrored (shipPlace): the
// figure itself is not, only where it stands.

import { Matrix4, type Object3D, Vector3 } from 'three';

/** The clips about her decks, by what they are. */
export const DECK_CLIPS = {
  idles: ['look-about', 'fold-arms', 'talking'],
  leaning: ['leaning'],
  seated: ['hatch-sit', 'hatch-shift', 'hatch-nod', 'hatch-talk'],
  walk: 'walk',
} as const;

/** What a machine sailor has not: its hands would meet its plates, its long coat the deck and the rail. */
export const NOT_FOR_MACHINES: readonly string[] = [
  'fold-arms',
  'hatch-talk',
  'leaning',
  'haul',
  'haul-port',
];

/** Her work and aloft, by name; each has its -port mirror. */
export const ALOFT_CLIPS = {
  haul: 'haul',
  aloft: 'aloft',
  yard: 'yard',
} as const;

/** How fast the walk goes over the deck at its own rate, m/s. */
export const WALK_SPEED = 0.9;

const PORT = '-port';
const DECK_FILE: readonly string[] = [
  ...DECK_CLIPS.idles,
  ...DECK_CLIPS.leaning,
  ...DECK_CLIPS.seated,
  DECK_CLIPS.walk,
];
const ALOFT_FILE: readonly string[] = Object.values(ALOFT_CLIPS).flatMap((c) => [c, `${c}${PORT}`]);

/** Where on the ship each placed clip is placed from, by clip (its -port the same on the port side). */
export const SHIP_ANCHORS: Readonly<Record<string, ShipPlace>> = {
  leaning: 'rail',
  'hatch-sit': 'hatch',
  'hatch-shift': 'hatch',
  'hatch-nod': 'hatch',
  'hatch-talk': 'hatch',
  haul: 'brace',
  aloft: 'top',
  yard: 'yard',
};

/** A place of the ship's company's (her model's `company` node) a clip is placed from. */
export type ShipPlace = 'rail' | 'hatch' | 'brace' | 'top' | 'yard';

/** Whether a clip is in the ship's deck file. */
export function inShipFile(clip: string): boolean {
  return DECK_FILE.includes(clip);
}

/** Whether a clip is in the ship's work and aloft file. */
export function inAloftFile(clip: string): boolean {
  return ALOFT_FILE.includes(clip);
}

/** A look's clips about the ship's decks, beside its other clips (the art path of its clips' file). */
export function shipClips(clips: string): string {
  return clips.replace(/\.clips\.glb$/, '.ship.glb');
}

/** A look's clips of the ship's work and aloft, beside its other clips. */
export function aloftClips(clips: string): string {
  return clips.replace(/\.clips\.glb$/, '.aloft.glb');
}

/** The ship's side a clip is on: −1 for a -port one, else +1. */
export function shipSide(clip: string): number {
  return clip.endsWith(PORT) ? -1 : 1;
}

/** The place a clip is placed from, or null for one that is not (standing about, walking). */
export function shipAnchor(clip: string): ShipPlace | null {
  const base = clip.endsWith(PORT) ? clip.slice(0, -PORT.length) : clip;
  return SHIP_ANCHORS[base] ?? null;
}

/** The places of the ship's company her model marks (its `company` node's extras), in the model's frame. */
export interface Company {
  /** The quarterdeck's cap rail's inner edge, on its top. */
  rail: Vector3;
  /** The fore hatch's forward edge on its grating, on her centreline. */
  hatch: Vector3;
  /** The main brace's lead on the quarterdeck's rail, and a point along its fall. */
  brace: { lead: Vector3; fall: Vector3 };
  /** The main top's floor, at her centreline by the mast. */
  top: Vector3;
  /** The main topsail yard: its node, its radius, and its footrope's points from the yard's middle out (in the node's frame). */
  yard: { node: string; radius: number; footrope: Vector3[] };
  /** The ways her company walks: points on her decks (and the main top) and the stretches between them; null if her model has none. */
  ways: ShipWays | null;
  /** Her yards that are braced and reefed, her braces, and where her topmen go aloft by each mast (empty if her model has none). */
  yards: ShipYard[];
  braces: ShipBrace[];
  aloft: ShipAloft[];
}

/**
 * A yard of hers that is braced and reefed: its mast and the group of
 * yards it swings with, the node of its mast's yards (turned about the
 * mast by the braces) and that node's place in her frame, its own node if
 * it has one (a topsail's, lowered as it is reefed), its middle in its
 * mast's yards' node's frame at rest, half its length, its radius, how far
 * it comes down reefed and at which reef its sail is taken in (1 the
 * topgallants, 2 the topsails, 0 never).
 */
export interface ShipYard {
  name: string;
  mast: 'fore' | 'main' | 'mizzen';
  group: 'fore' | 'after';
  node: string;
  origin: Vector3;
  own: string | null;
  at: Vector3;
  half: number;
  radius: number;
  drop: number;
  reef: number;
}

/**
 * A brace of hers, the starboard side's (the port's the mirror): from its
 * yard's arm through a block (her frame) to its lead (a pin on her rail or
 * a lead in her deck); and where those hauling on its fall have their
 * hands, from its lead out, this high over her deck.
 */
export interface ShipBrace {
  yard: number;
  group: 'fore' | 'after';
  block: Vector3;
  lead: Vector3;
  hands: Vector3[];
  over: number;
}

/** Where her topmen go aloft by a mast: the foot of its shrouds on her deck, the starboard side's. */
export interface ShipAloft {
  mast: 'fore' | 'main' | 'mizzen';
  foot: Vector3;
}

/** What a stretch of a way is: walked along a deck, a ladder, or the climb aloft. */
export const WAY_WALKED = 0;
export const WAY_LADDER = 1;
export const WAY_ALOFT = 2;

/** The ways along the ship: points (each on its deck) and the stretches between two of them, each walked, a ladder or the climb aloft. */
export interface ShipWays {
  nodes: Vector3[];
  edges: [number, number, number][];
}

/** The places of the ship's company her model's `company` node gives; null if it has none. */
export function company(parts: Map<string, Object3D>): Company | null {
  const e = parts.get('company')?.userData as Record<string, unknown> | undefined;
  if (e === undefined || e.rail === undefined) {
    return null;
  }
  const v = (p: unknown): Vector3 => new Vector3(...(p as [number, number, number]));
  const hatch = e.hatch as { edge: number[] };
  const brace = e.brace as { lead: number[]; fall: number[] };
  const top = e.top as { floor: number[] };
  const yard = e.yard as { node: string; radius: number; footrope: number[][] };
  const ways = e.ways as { nodes: number[][]; edges: number[][] } | undefined;
  const yards = ((e.yards ?? []) as Record<string, unknown>[]).map(
    (y): ShipYard => ({
      name: y.name as string,
      mast: y.mast as ShipYard['mast'],
      group: y.group as ShipYard['group'],
      node: y.node as string,
      origin: v(y.origin),
      own: (y.own as string | null) ?? null,
      at: v(y.at),
      half: y.half as number,
      radius: y.radius as number,
      drop: y.drop as number,
      reef: y.reef as number,
    }),
  );
  const braces = ((e.braces ?? []) as Record<string, unknown>[]).map(
    (b): ShipBrace => ({
      yard: yards.findIndex((y) => y.name === b.yard),
      group: b.group as ShipBrace['group'],
      block: v(b.block),
      lead: v(b.lead),
      hands: (b.hands as number[][]).map(v),
      over: b.over as number,
    }),
  );
  const aloft = ((e.aloft ?? []) as Record<string, unknown>[]).map(
    (a): ShipAloft => ({ mast: a.mast as ShipAloft['mast'], foot: v(a.foot) }),
  );
  return {
    rail: v(e.rail),
    hatch: v(hatch.edge),
    brace: { lead: v(brace.lead), fall: v(brace.fall) },
    top: v(top.floor),
    yard: { node: yard.node, radius: yard.radius, footrope: yard.footrope.map(v) },
    ways:
      ways === undefined
        ? null
        : {
            nodes: ways.nodes.map(v),
            edges: ways.edges.map(
              (e) => [e[0] ?? 0, e[1] ?? 0, e[2] ?? 0] as [number, number, number],
            ),
          },
    yards,
    braces: braces.filter((b) => b.yard >= 0),
    aloft,
  };
}

/**
 * Where the build staged the ship's clips beyond what her model marks: the
 * hauler's hands' place along the main brace's fall from its lead, the
 * fall as hauled this far over its lead, and the footrope's share of its
 * run out from the yard's middle a figure on the yard stands at.
 */
export const STAGED = { braceAt: 1.6, braceUp: 0.1, yardAt: 0.2 } as const;

/**
 * The point of the ship's company's a placed clip is placed from, on the
 * starboard side, in her model's frame; for the yard, in its node's (`node`:
 * put the figure under it).
 */
export function shipPoint(c: Company, place: ShipPlace): { at: Vector3; node: string | null } {
  switch (place) {
    case 'rail':
      return { at: c.rail.clone(), node: null };
    case 'hatch':
      return { at: c.hatch.clone(), node: null };
    case 'top':
      return { at: c.top.clone(), node: null };
    case 'brace': {
      const along = c.brace.fall.clone().sub(c.brace.lead).normalize();
      const at = c.brace.lead.clone().addScaledVector(along, STAGED.braceAt);
      at.y += STAGED.braceUp;
      return { at, node: null };
    }
    case 'yard': {
      const rope = c.yard.footrope;
      const x = STAGED.yardAt * (rope.length - 1);
      const i = Math.min(Math.floor(x), rope.length - 2);
      const a = rope[i] as Vector3;
      const b = rope[i + 1] as Vector3;
      return { at: new Vector3(a.x + (b.x - a.x) * (x - i), 0, 0), node: c.yard.node };
    }
  }
}

/** The mirror across her centreline (x). */
const MIRROR = new Matrix4().makeScale(-1, 1, 1);

/**
 * A clip's place (from the figure to its place on the ship) into the
 * model's frame at a point of that kind (the starboard side's, or the
 * port's mirror), on the clip's side. A clip with no -port put on the port
 * side has its place mirrored: the same figure, standing as the mirror of
 * where it stands to starboard.
 */
export function shipPlace(place: Matrix4, at: Vector3, side: number, mirrored = false): Matrix4 {
  if (side < 0 && mirrored) {
    // The starboard place, seen in the mirror.
    return new Matrix4()
      .makeTranslation(at.x, at.y, at.z)
      .multiply(place)
      .premultiply(MIRROR)
      .multiply(MIRROR);
  }
  return new Matrix4().makeTranslation(side * at.x, at.y, at.z).multiply(place);
}
