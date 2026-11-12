// SPDX-License-Identifier: AGPL-3.0-only

// What a ship's company does, by rule, from what is known of the ship each
// frame (her after yards' turn, her heel, the wind, the world's time), with
// no drawing in it: so the same rules run for the ship in view and for any
// other ship from her state as it is drawn, and every client draws the
// same person doing the same thing.
//
// - Her weather side is the side her after yards are braced for, so it
//   changes once a tack, as the after yards swing ("mainsail haul"), and
//   at the end of a wear; never with a gust. Stations to windward are drawn
//   on it, those to leeward on the other; when it changes, their people
//   walk across.
// - Everyone at a station plays one of their pose's idles at a time, a new
//   one every 20 to 60 seconds, chosen from their seat and the world's
//   time (idleAt), blended over IDLE_BLEND. Talking only with someone
//   within TALK_NEAR.
// - Those sat on a hatch stand up while she heels past SIT_HEEL or the wind
//   is past force 5, and sit again once both are back under their
//   hysteresis.
// - Anyone whose place changes walks there along the ship's ways (her
//   model's), at the walk's own pace: keeping to the lee side going aft
//   unless their place is to windward, to the right of a way along her
//   side, and behind anyone walking ahead of them. A ladder is crossed by a
//   cut (gone at its foot, there at its head after LADDER_TIME), and the
//   climb to the main top likewise; a walker waits at a ladder for the one
//   on it.
// - When the controls change hands, the figure at the wheel stays whoever
//   had them until the new holder has walked aft to behind them; after
//   RELIEF_PAUSE the new holder takes the spokes and the old steps to
//   leeward and walks to their place. Anyone else whose place changes
//   walks too. Under reduced motion every walk is a cut.
//
// Everything is in the ship model's frame (x to starboard, y up, z aft).

import { Matrix4, Vector3 } from 'three';
import type { BoatStation } from '../../catalog';
import {
  type CrewAboard,
  type CrewMember,
  type CrewMoment,
  CrewPath,
  type CrewSpot,
  placeOf,
} from './crewrules';
import { type Company, type ShipWays, WALK_SPEED, WAY_ALOFT, WAY_LADDER } from './ship';
import {
  CLIMB_PER_METRE,
  COIL_TIME,
  type HaulPlace,
  hauledSide,
  haulPlaces,
  keepers,
  REEF_STILL,
  reefedYards,
  SWING,
  SWING_MOVE,
  SWING_START,
  SWING_STOP,
  turnOf,
  type YardPlace,
  yardFrame,
  yardPlaces,
} from './shipwork';

/** Seconds a walker is gone on a ladder, and on the climb to the main top (a cut). */
export const LADDER_TIME = 1.5;
export const ALOFT_TIME = 8;
/** Seconds from a station's stance into the walk, and from the walk into the stance at its end. */
export const STEP_OFF = 0.5;
export const STEP_IN = 0.7;
/** How far behind someone walking ahead the one following keeps, m; and the longest a walker waits for anyone, s. */
export const KEEP_BEHIND = 0.6;
export const WAIT_MOST = 6;
/** Someone this near the line a walker heads along is in their way, m; anyone ahead nearer than TOO_CLOSE is. */
export const IN_WAY = 0.32;
export const TOO_CLOSE = 0.42;
/** How far a walker steps aside to let someone coming the other way by, m, and how fast, m/s. */
export const ASIDE = 0.32;
export const ASIDE_SPEED = 0.6;

/**
 * Whether b is in the way of a, walking along heading yaw: ahead within
 * KEEP_BEHIND and IN_WAY of their line, or nearer than TOO_CLOSE ahead; and
 * how far to a's right b is.
 */
function inWay(a: { v: Vector3; yaw: number }, b: { v: Vector3 }): { right: number } | null {
  const hx = Math.sin(a.yaw);
  const hz = Math.cos(a.yaw);
  const dx = b.v.x - a.v.x;
  const dz = b.v.z - a.v.z;
  const along = dx * hx + dz * hz;
  const right = -dx * hz + dz * hx;
  const cone = along > 0.05 && along <= KEEP_BEHIND && Math.abs(right) <= IN_WAY;
  const close = along > 0 && Math.hypot(dx, dz) < TOO_CLOSE;
  return cone || close ? { right } : null;
}

/** A walker's place along their walk at t, stepped aside as they are, into out. */
export function walkerAt(
  d: ShipDoing,
  out: Vector3,
): { yaw: number; gone: boolean; leg: ShipLeg | null } {
  const r = d.route as ShipRoute;
  const w = r.at(Math.max(r.legs[0]?.t0 ?? 0, d.t), out);
  if (!w.gone) {
    out.x += d.aside.x;
    out.z += d.aside.z;
  }
  return w;
}
/** How far to the right of a way along her side a walker keeps, m: two meeting pass each other this far either side. */
export const PASS_SIDE = 0.2;
/** How much dearer a way along her weather side is to one going aft whose place is not to windward. */
export const LEE_COST = 3;
/** How much dearer a way is that another walker walks the other way along, set off at the same moment. */
export const MET_COST = 4;
/** Seconds the relief stands behind the helmsman before taking the spokes; how far aft of the wheel's place they stand, and to leeward the relieved steps, m. */
export const RELIEF_PAUSE = 1.5;
export const RELIEF_AFT = 0.7;
export const STEP_LEE = 0.7;
/** An idle lasts IDLE_EVERY seconds give or take IDLE_JITTER (so 20 to 60 s between changes); one goes over into the next in IDLE_BLEND. */
export const IDLE_EVERY = 40;
export const IDLE_JITTER = 10;
export const IDLE_BLEND = 0.7;
/** Talking only with someone this near, m. */
export const TALK_NEAR = 2.5;
/** Those sat on a hatch stand past this heel or wind (force 5's top, m/s), and sit again under these. */
export const SIT_HEEL = (8 * Math.PI) / 180;
export const SIT_HEEL_BACK = (6 * Math.PI) / 180;
export const SIT_WIND = 10.8;
export const SIT_WIND_BACK = 9.8;
/** Seconds to sit down or stand up, and between one person's and the next's. */
export const SIT_TIME = 1;
export const SIT_STAGGER = 0.4;
/** How long the heel is smoothed over before it stands anyone up, s: the waves' roll is not her heel. */
export const HEEL_SMOOTH = 3;
/** How far past square the after yards must turn before her weather side changes, radians. */
export const YARDS_SIDE = (3 * Math.PI) / 180;
/** The most a standing figure is kept plumb against her heel and pitch, radians: past it, it leans with her. */
export const SEA_LEGS = (12 * Math.PI) / 180;

/**
 * Where a station's person stands, m from its point: leaning on the rail,
 * this far inboard of the cap's edge and this far under its top; sat on a
 * hatch, this far before its edge and under the grating; in the top, this
 * far out toward the shrouds.
 */
export const LEAN_BACK = 0.42;
export const RAIL_OVER = 0.908;
export const SIT_FEET = 0.45;
export const HATCH_OVER = 0.297;
export const TOP_OUT = 1.4;

/** The idles of each pose, by clip name: the first is the pose's own. */
export const IDLES = {
  standing: ['standing-idle', 'look-about', 'fold-arms', 'talking', 'habit-standing'],
  leaning: ['leaning'],
  seated: ['hatch-sit', 'hatch-shift', 'hatch-nod', 'hatch-talk'],
  aloft: ['aloft'],
} as const;
/** The idles that are talking: only with someone near. */
export const TALKING: readonly string[] = ['talking', 'hatch-talk'];

/** A ship's crew's plan: her stations, her company's places and her ways. */
export interface ShipPlan {
  stations: readonly BoatStation[];
  company: Company;
  ways: ShipWays;
}

/** A ship's plan from her stations and her model's company; null if her model has no ways. */
export function shipPlan(
  stations: readonly BoatStation[],
  company: Company | null,
): ShipPlan | null {
  if (company === null || company.ways === null) {
    return null;
  }
  return { stations, company, ways: company.ways };
}

/** Where a station's person is drawn: its point and facing, and the side they are on (+1 starboard). */
export interface ShipSpot {
  at: Vector3;
  facing: number;
  side: number;
}

/**
 * A station drawn with the weather on a side (+1 starboard): to windward
 * on that side, to leeward on the other, its point and facing mirrored
 * there; any other where it is. The side of one on the centreline is the
 * weather's (to windward) or the lee's.
 */
export function shipStation(s: BoatStation, weather: number, out: ShipSpot): ShipSpot {
  const [x, y, z] = s.at as [number, number, number];
  const want = s.windward === true ? weather : s.lee === true ? -weather : 0;
  const own = x < 0 ? -1 : x > 0 ? 1 : want || 1;
  const mirror = want !== 0 && want !== own;
  out.at.set(mirror ? -x : x, y, z);
  out.facing = mirror ? (360 - s.facing) % 360 : s.facing;
  out.side = want !== 0 ? want : own;
  return out;
}

/** A facing (degrees clockwise from the bow) as a way along the deck: (sin, −cos). */
function along(facing: number, out: Vector3): Vector3 {
  const f = (facing * Math.PI) / 180;
  return out.set(Math.sin(f), 0, -Math.cos(f));
}

const dir = new Vector3();

/** Where a station's person stands, drawn at spot: their feet's place on the deck (the top's floor aloft). */
export function standPoint(s: BoatStation, spot: ShipSpot, out: Vector3): Vector3 {
  out.copy(spot.at);
  switch (s.pose) {
    case 'leaning':
      out.addScaledVector(along(spot.facing, dir), -LEAN_BACK);
      out.y -= RAIL_OVER;
      break;
    case 'seated':
      out.addScaledVector(along(spot.facing, dir), SIT_FEET);
      out.y -= HATCH_OVER;
      break;
    case 'aloft':
      out.x = spot.side * TOP_OUT;
      break;
    default:
  }
  return out;
}

/** A small hash of two integers, 0 to 1: the same everywhere. */
export function hash(a: number, b: number): number {
  let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x165667b1, 0x9e3779b1)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** When a seat's k-th idle begins, world seconds: every IDLE_EVERY, give or take IDLE_JITTER. */
export function idleStart(seat: number, k: number): number {
  return k * IDLE_EVERY + (2 * hash(seat * 7 + 1, k) - 1) * IDLE_JITTER;
}

/** Which of n idles a seat's k-th is: a new one each time, but now and then the same twice. */
export function idlePick(seat: number, k: number, n: number): number {
  if (n <= 1) {
    return 0;
  }
  const raw = (j: number): number => Math.floor(hash(seat * 13 + 5, j) * n) % n;
  const r = raw(k);
  return r === raw(k - 1) ? (r + 1) % n : r;
}

/**
 * A seat's idle at a moment (world seconds): of the clips it may play
 * (allowed), the index of the one now and of the one before it, and how
 * far the one now has come in over IDLE_BLEND (1 once in).
 */
export function idleAt(
  seat: number,
  time: number,
  n: number,
  out: { now: number; was: number; f: number },
): { now: number; was: number; f: number } {
  let k = Math.floor(time / IDLE_EVERY);
  if (time < idleStart(seat, k)) {
    k--;
  } else if (time >= idleStart(seat, k + 1)) {
    k++;
  }
  out.now = idlePick(seat, k, n);
  out.was = idlePick(seat, k - 1, n);
  out.f = Math.max(0, Math.min(1, (time - idleStart(seat, k)) / IDLE_BLEND));
  return out;
}

/** A stretch of a walk: along the deck, or a cut (a ladder or the climb aloft), from seconds t0 to t1 of it. */
export interface ShipLeg {
  kind: 'walk' | 'cut';
  t0: number;
  t1: number;
  /** Along the deck: its path, walked at WALK_SPEED. */
  path: CrewPath | null;
  /** A cut: which way's stretch (its edge), from where to where. */
  edge: number;
  from: Vector3;
  to: Vector3;
}

/** A walk from a place to a place along the ship's ways. */
export class ShipRoute {
  readonly legs: ShipLeg[];
  readonly duration: number;
  /** Seconds from its start to the first leg (stepping off), and from the last to its end (stepping in). */
  readonly off: number;
  readonly in: number;

  /** The ways' stretches walked, by edge, and which way: +1 from its first point, −1 toward it. */
  ways = new Map<number, number>();

  constructor(legs: ShipLeg[], off: number, inTime: number) {
    this.legs = legs;
    this.off = off;
    this.in = inTime;
    this.duration = (legs.at(-1)?.t1 ?? off) + inTime;
  }

  /** The leg at t seconds into the walk; null while stepping off or in. */
  legAt(t: number): ShipLeg | null {
    for (const l of this.legs) {
      if (t >= l.t0 && t < l.t1) {
        return l;
      }
    }
    return null;
  }

  /** Where the walk is at t, into out (x, y, z), and the way it heads as a yaw; whether its walker is gone (on a cut). */
  at(t: number, out: Vector3): { yaw: number; gone: boolean; s: number; leg: ShipLeg | null } {
    const legs = this.legs;
    const first = legs[0];
    const last = legs.at(-1);
    if (first === undefined || last === undefined) {
      return { yaw: 0, gone: false, s: 0, leg: null };
    }
    const tt = Math.max(first.t0, Math.min(last.t1 - 1e-6, t));
    const leg = this.legAt(tt) ?? last;
    if (leg.kind === 'cut' || leg.path === null) {
      out.copy(tt - leg.t0 < (leg.t1 - leg.t0) / 2 ? leg.from : leg.to);
      return {
        yaw: Math.atan2(leg.to.x - leg.from.x, leg.to.z - leg.from.z),
        gone: true,
        s: 0,
        leg,
      };
    }
    const s = Math.max(0, Math.min(leg.path.length, (tt - leg.t0) * WALK_SPEED));
    const p = { x: 0, y: 0, z: 0 };
    const yaw = leg.path.at(s, p);
    out.set(p.x, p.y, p.z);
    return { yaw, gone: false, s, leg };
  }
}

/** The corners of a walk's path rounded to this radius, m; its points this far apart at most. */
const CORNER = 0.35;
const STEP = 0.05;

/** A path through points on the deck (x, y, z): its corners rounded, its points STEP apart, the height between each two straight. */
export function deckPath(points: readonly Vector3[]): CrewPath {
  const flat: Vector3[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as Vector3;
    if (i === 0 || i === points.length - 1) {
      flat.push(p.clone());
      continue;
    }
    const a = points[i - 1] as Vector3;
    const b = points[i + 1] as Vector3;
    const la = Math.hypot(p.x - a.x, p.z - a.z);
    const lb = Math.hypot(b.x - p.x, b.z - p.z);
    const r = Math.min(CORNER, la / 2, lb / 2);
    if (r <= 1e-6) {
      flat.push(p.clone());
      continue;
    }
    const from = p.clone().lerp(a, r / la);
    const to = p.clone().lerp(b, r / lb);
    for (let j = 0; j <= 8; j++) {
      const t = j / 8;
      const u = 1 - t;
      flat.push(
        new Vector3(
          u * u * from.x + 2 * u * t * p.x + t * t * to.x,
          u * u * from.y + 2 * u * t * p.y + t * t * to.y,
          u * u * from.z + 2 * u * t * p.z + t * t * to.z,
        ),
      );
    }
  }
  const dense: [number, number, number][] = [];
  for (let i = 0; i < flat.length; i++) {
    const p = flat[i] as Vector3;
    if (i > 0) {
      const a = flat[i - 1] as Vector3;
      const l = Math.hypot(p.x - a.x, p.z - a.z);
      const k = Math.ceil(l / STEP);
      for (let j = 1; j < k; j++) {
        const f = j / k;
        dense.push([a.x + (p.x - a.x) * f, a.y + (p.y - a.y) * f, a.z + (p.z - a.z) * f]);
      }
    }
    const prev = dense.at(-1);
    if (prev === undefined || Math.hypot(p.x - prev[0], p.z - prev[2]) > 1e-6) {
      dense.push([p.x, p.y, p.z]);
    }
  }
  if (dense.length === 1) {
    const d = dense[0] as [number, number, number];
    dense.push([d[0], d[1], d[2] + 1e-4]);
  }
  return new CrewPath(dense);
}

/** An edge of the ways graph as walked: from a node to a node, which edge, its kind and how long it is. */
interface Arc {
  to: number;
  edge: number;
  kind: number;
  length: number;
}

/** How near a walk's end must be to a point of the ways to begin or end there, m. */
const AT_NODE = 0.25;
/** How near in height a place must be to a way's stretch to be on its deck, m. */
const SAME_DECK = 0.6;

/** The ways as a graph, and the shortest walks over it. */
export class ShipWayGraph {
  readonly nodes: Vector3[];
  readonly edges: [number, number, number][];
  readonly #arcs: Arc[][];

  constructor(ways: ShipWays) {
    this.nodes = ways.nodes;
    this.edges = ways.edges;
    this.#arcs = ways.nodes.map(() => []);
    ways.edges.forEach(([a, b, kind], e) => {
      const pa = ways.nodes[a] as Vector3;
      const pb = ways.nodes[b] as Vector3;
      const length =
        kind === WAY_LADDER
          ? LADDER_TIME * WALK_SPEED
          : kind === WAY_ALOFT
            ? ALOFT_TIME * WALK_SPEED
            : Math.hypot(pa.x - pb.x, pa.z - pb.z);
      this.#arcs[a]?.push({ to: b, edge: e, kind, length });
      this.#arcs[b]?.push({ to: a, edge: e, kind, length });
    });
  }

  /** Where a walk's end joins the ways: at a point of theirs it is on, else the nearest walked stretch on its deck. */
  #end(p: Vector3): { edge: number; f: number; d: number; node: number } {
    for (let i = 0; i < this.nodes.length; i++) {
      if ((this.nodes[i] as Vector3).distanceTo(p) < AT_NODE) {
        return { edge: -1, f: 0, d: 0, node: i };
      }
    }
    return { ...this.nearest(p), node: -1 };
  }

  /** The walked stretch nearest a place on its deck: its edge, and how far along it (0 at its first node). */
  nearest(p: Vector3): { edge: number; f: number; d: number } {
    let best = { edge: -1, f: 0, d: Number.POSITIVE_INFINITY };
    this.edges.forEach(([a, b, kind], e) => {
      if (kind !== 0) {
        return;
      }
      const pa = this.nodes[a] as Vector3;
      const pb = this.nodes[b] as Vector3;
      const dx = pb.x - pa.x;
      const dz = pb.z - pa.z;
      const l2 = dx * dx + dz * dz;
      const f = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - pa.x) * dx + (p.z - pa.z) * dz) / l2)) : 0;
      const y = pa.y + (pb.y - pa.y) * f;
      if (Math.abs(y - p.y) > SAME_DECK) {
        return;
      }
      const d = Math.hypot(pa.x + dx * f - p.x, pa.z + dz * f - p.z);
      if (d < best.d) {
        best = { edge: e, f, d };
      }
    });
    return best;
  }

  /**
   * The shortest walk from a place to a place, as the points walked through
   * (each with the kind of stretch it is reached by, and its edge): along
   * the nearest stretch on each one's deck; a stretch's length weighed by
   * cost (edge, and whether walked from its first node).
   */
  route(
    from: Vector3,
    to: Vector3,
    cost: (edge: number, forward: boolean, a: Vector3, b: Vector3) => number,
  ): { at: Vector3; kind: number; edge: number }[] {
    const s = this.#end(from);
    const t = this.#end(to);
    const n = this.nodes.length;
    const S = n;
    const T = n + 1;
    const point = (q: { edge: number; f: number; node: number }): Vector3 => {
      if (q.node >= 0) {
        return (this.nodes[q.node] as Vector3).clone();
      }
      const [a, b] = this.edges[q.edge] as [number, number, number];
      return (this.nodes[a] as Vector3).clone().lerp(this.nodes[b] as Vector3, q.f);
    };
    if ((s.edge < 0 && s.node < 0) || (t.edge < 0 && t.node < 0)) {
      return [
        { at: from.clone(), kind: 0, edge: -1 },
        { at: to.clone(), kind: 0, edge: -1 },
      ];
    }
    const ps = point(s);
    const pt = point(t);
    const nodeAt = (i: number): Vector3 =>
      i === S ? ps : i === T ? pt : (this.nodes[i] as Vector3);
    // The two ends' arcs: to the ends of their stretches (and to each other on one stretch).
    const extra = new Map<number, Arc[]>();
    const add = (i: number, arc: Arc): void => {
      const list = extra.get(i) ?? [];
      list.push(arc);
      extra.set(i, list);
    };
    for (const [end, q, p] of [
      [S, s, ps],
      [T, t, pt],
    ] as const) {
      if (q.node >= 0) {
        // At a point of the ways: joined to it alone.
        add(end, { to: q.node, edge: -1, kind: 0, length: 0 });
        add(q.node, { to: end, edge: -1, kind: 0, length: 0 });
        continue;
      }
      const [a, b] = this.edges[q.edge] as [number, number, number];
      for (const node of [a, b]) {
        const l = Math.hypot(
          (this.nodes[node] as Vector3).x - p.x,
          (this.nodes[node] as Vector3).z - p.z,
        );
        add(end, { to: node, edge: q.edge, kind: 0, length: l });
        add(node, { to: end, edge: q.edge, kind: 0, length: l });
      }
    }
    if (s.edge === t.edge && s.edge >= 0) {
      const l = Math.hypot(ps.x - pt.x, ps.z - pt.z);
      add(S, { to: T, edge: s.edge, kind: 0, length: l });
    }
    const dist = new Float64Array(n + 2).fill(Number.POSITIVE_INFINITY);
    const prev = new Int32Array(n + 2).fill(-1);
    const via = new Array<Arc | null>(n + 2).fill(null);
    const done = new Uint8Array(n + 2);
    dist[S] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < n + 2; i++) {
        if (done[i] === 0 && (u < 0 || (dist[i] as number) < (dist[u] as number))) {
          u = i;
        }
      }
      if (u < 0 || !Number.isFinite(dist[u] as number) || u === T) {
        break;
      }
      done[u] = 1;
      const arcs = [...(u < n ? (this.#arcs[u] as Arc[]) : []), ...(extra.get(u) ?? [])];
      for (const arc of arcs) {
        const forward = (this.edges[arc.edge]?.[0] ?? -1) === u;
        const w =
          arc.length * (arc.kind === 0 ? cost(arc.edge, forward, nodeAt(u), nodeAt(arc.to)) : 1);
        const d = (dist[u] as number) + w;
        if (d < (dist[arc.to] as number)) {
          dist[arc.to] = d;
          prev[arc.to] = u;
          via[arc.to] = arc;
        }
      }
    }
    const out: { at: Vector3; kind: number; edge: number }[] = [];
    for (let i = T; i >= 0; i = prev[i] as number) {
      const arc = via[i];
      out.push({ at: nodeAt(i).clone(), kind: arc?.kind ?? 0, edge: arc?.edge ?? -1 });
      if (i === S) {
        break;
      }
    }
    out.reverse();
    out.unshift({ at: from.clone(), kind: 0, edge: -1 });
    out.push({ at: to.clone(), kind: 0, edge: -1 });
    return out;
  }
}

/** A way's stretch is along her side if it runs fore and aft this far out from her centreline, m; across her if it runs athwartships this far. */
const SIDE_OUT = 1.0;
const CROSS_LONG = 0.8;

/**
 * The legs of a walk through points (as ShipWayGraph.route gives them):
 * the walked ones joined into paths, each point along her side kept
 * PASS_SIDE to the walker's right; each ladder or climb aloft a cut.
 */
export function legsOf(
  points: readonly { at: Vector3; kind: number; edge: number }[],
  off: number,
): ShipLeg[] {
  const legs: ShipLeg[] = [];
  let walk: Vector3[] = [];
  let t = off;
  const flush = (): void => {
    if (walk.length >= 2) {
      const path = deckPath(keptRight(walk));
      const t1 = t + path.length / WALK_SPEED;
      legs.push({
        kind: 'walk',
        t0: t,
        t1,
        path,
        edge: -1,
        from: walk[0] as Vector3,
        to: walk.at(-1) as Vector3,
      });
      t = t1;
    }
    walk = [];
  };
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as { at: Vector3; kind: number; edge: number };
    if (i > 0 && p.kind !== 0) {
      const prev = points[i - 1] as { at: Vector3 };
      if (walk.length === 0) {
        walk.push(prev.at);
      }
      flush();
      const time = p.kind === WAY_ALOFT ? ALOFT_TIME : LADDER_TIME;
      legs.push({
        kind: 'cut',
        t0: t,
        t1: t + time,
        path: null,
        edge: p.edge,
        from: prev.at,
        to: p.at,
      });
      t += time;
      walk = [p.at];
      continue;
    }
    // Points closer than a centimetre are one.
    const last = walk.at(-1);
    if (last === undefined || Math.hypot(last.x - p.at.x, last.z - p.at.z) > 0.01) {
      walk.push(p.at);
    }
  }
  flush();
  return legs;
}

/** Each point along her side or across her moved PASS_SIDE to the right of the way walked there. */
function keptRight(points: readonly Vector3[]): Vector3[] {
  return points.map((p, i) => {
    if (i === 0 || i === points.length - 1) {
      return p;
    }
    const a = points[i - 1] as Vector3;
    const b = points[i + 1] as Vector3;
    const q = p.clone();
    for (const [u, v] of [
      [a, p],
      [p, b],
    ] as const) {
      const dx = v.x - u.x;
      const dz = v.z - u.z;
      if (Math.abs(dz) > 2 * Math.abs(dx) && Math.abs(u.x) > SIDE_OUT && Math.abs(v.x) > SIDE_OUT) {
        // Going forward (−z), the right is to starboard.
        q.x = p.x + (dz < 0 ? PASS_SIDE : -PASS_SIDE);
        return q;
      }
      if (Math.abs(dx) > 2 * Math.abs(dz) && Math.abs(dx) > CROSS_LONG) {
        // Across her, going to starboard (+x), the right is aft.
        q.z = p.z + (dx > 0 ? PASS_SIDE : -PASS_SIDE);
        return q;
      }
    }
    return q;
  });
}

/**
 * A ship's member's work: hauling on a brace (its place on the fall; how
 * hard they haul now, 0 … 1, eased in and out as the yards swing and stop),
 * or aloft on a yard (its place on it, the foot of the shrouds they climb
 * and how long the climb takes); going to it, at it, or going back from it.
 */
export interface ShipWork {
  kind: 'haul' | 'aloft';
  haul: HaulPlace | null;
  pull: number;
  yard: YardPlace | null;
  foot: Vector3;
  climb: number;
  phase: 'going' | 'at' | 'back';
}

/** What a ship's member is doing beyond the rules every crew keeps. */
export interface ShipDoing {
  /** Their walk, if walking; t seconds into it; whether they wait (for a ladder or someone ahead) and how long they have. */
  route: ShipRoute | null;
  t: number;
  waited: number;
  /** Where they walk from and to: a station's index, or RELIEF (behind the helmsman) or WHEEL (stepping to leeward of it). */
  from: number;
  to: number;
  /** Where they walked from, and the spot they walk to, drawn. */
  fromSpot: ShipSpot;
  toSpot: ShipSpot;
  /** Sat (1) or stood (0) at a seated station, and on the way between. */
  sat: number;
  satTo: number;
  /** Whether someone stands within TALK_NEAR of them. */
  company: boolean;
  /** Gone, on a ladder or the climb aloft. */
  gone: boolean;
  /** At the end of a walk to relieve the helmsman, seconds waited there. */
  relieving: number;
  /** Their work, while at the braces or aloft or going to or from them; null otherwise. */
  work: ShipWork | null;
  /** How far they have stepped aside off their walk (x and z, m), to let someone by. */
  aside: { x: number; z: number };
}

/** A walk's ends that are not stations: behind the helmsman, the wheel, and a member's work. */
export const RELIEF = -2;
export const WHEEL = -1;
export const WORK = -3;

/** How fast a hauler takes to hauling and leaves off, s. */
export const PULL_EASE = 0.5;
/** A station's person is in a fall's way within this of its places, m: they go to the braces first. */
export const FALL_CLEAR = 0.6;

/** A group of yards' swing, as followed from its turn: its last turn, how long it has gone fast and slow, whether it swings and which way. */
interface Swing {
  last: number;
  fast: number;
  slow: number;
  on: boolean;
  dir: number;
  /** Where its turn was when it began to go fast this way. */
  from: number;
}

function swing(): Swing {
  return {
    last: Number.NaN,
    fast: 0,
    slow: Number.POSITIVE_INFINITY,
    on: false,
    dir: 0,
    from: 0,
  };
}

function spot(): ShipSpot {
  return { at: new Vector3(), facing: 0, side: 1 };
}

/** A ship's member: a crew member with what the ship's rules keep of them. */
export interface ShipMember extends CrewMember {
  ship: ShipDoing;
}

const here = new Vector3();
const there = new Vector3();
const frameNow = new Matrix4();

/** A ship's company under the rules. */
export class ShipRules {
  /** Her weather side, + starboard, held till her after yards are YARDS_SIDE past square on the other; how often it changed. */
  readonly side = { side: 0, tack: true, changes: 0 };
  members: ShipMember[] = [];
  /** Whose look is drawn at the wheel: whoever held the controls until relieved. −1 for nobody. */
  wheelSeat = -1;
  /** Counts the changes of members: whoever draws them takes the new ones. */
  version = 0;
  readonly graph: ShipWayGraph;
  #crew: CrewAboard | null = null;
  /** The world's time, seconds; her heel smoothed; whether those on a hatch stand now, and seconds since that changed. */
  time = 0;
  #heel = 0;
  #stand = false;
  #since = Number.POSITIVE_INFINITY;
  #talkCheck = 0;
  /** Her yards' turns, the fore yards' and the after ones' (as yardsTurn has them), and her reef (0 … 2), as last told. */
  readonly turns = { fore: 0, after: 0 };
  reef = 0;
  readonly #swings = { after: swing(), fore: swing() };
  /** The hands at the braces: which group's and which side's; seconds since its swing stopped (coiling down), or −1 while it swings. */
  gang: { group: 'fore' | 'after'; side: number; coil: number } | null = null;
  /** The reef as followed: its last level, seconds since it changed, and the band it changes in (1 the topgallants, 2 the topsails). */
  readonly #reefing = { last: Number.NaN, still: Number.POSITIVE_INFINITY, band: 0 };
  /** The band of yards the topmen are aloft for, 0 for none. */
  aloftBand = 0;
  /** The stations whose people stay when the hands go to the braces or aloft. */
  readonly #keep: Set<number>;

  constructor(
    readonly plan: { stations: readonly BoatStation[]; ship: ShipPlan },
    /** Under reduced motion: every walk a cut. */
    readonly still = false,
  ) {
    this.graph = new ShipWayGraph(plan.ship.ways);
    this.#keep = keepers(plan.stations);
  }

  get company(): Company {
    return this.plan.ship.company;
  }

  get stations(): readonly BoatStation[] {
    return this.plan.stations;
  }

  /** The ship's rules never draw the helm away: the wheel always has someone. */
  get helmAway(): boolean {
    return false;
  }

  /** Whether those sat on a hatch are standing for the weather. */
  get standing(): boolean {
    return this.#stand;
  }

  /** Where a station is drawn now, into out. */
  spotOf(station: number, out: ShipSpot): ShipSpot {
    const s = this.stations[station];
    if (s === undefined) {
      return out;
    }
    return shipStation(s, this.side.side || 1, out);
  }

  /** Where a place's person stands now: a station's stand point, behind the helmsman, to leeward of the wheel, or at their work (m's). */
  #placeAt(place: number, out: Vector3, sp: ShipSpot, m: ShipMember | null = null): ShipSpot {
    const work = m?.ship.work ?? null;
    if (place === WORK && work !== null) {
      if (work.haul !== null) {
        out.copy(work.haul.feet);
        sp.facing = (((((Math.PI - work.haul.yaw) * 180) / Math.PI) % 360) + 360) % 360;
        sp.side = work.haul.side;
      } else {
        out.copy(work.foot);
        sp.facing = 0;
        sp.side = Math.sign(work.foot.x) || 1;
      }
      sp.at.copy(out);
      return sp;
    }
    const helm = this.stations[0];
    if (place === RELIEF || place === WHEEL || helm === undefined) {
      const [x, y, z] = (helm?.at ?? [0, 0, 0]) as [number, number, number];
      sp.at.set(x, y, z);
      sp.facing = 0;
      sp.side = this.side.side || 1;
      out.copy(sp.at);
      if (place === RELIEF) {
        out.z += RELIEF_AFT;
      } else {
        out.x -= sp.side * STEP_LEE;
      }
      sp.at.copy(out);
      return sp;
    }
    const st = this.stations[place];
    this.spotOf(place, sp);
    if (st !== undefined) {
      standPoint(st, sp, out);
    }
    return sp;
  }

  /** Where a member is now: along their walk, or at their place. */
  #where(m: ShipMember, out: Vector3): Vector3 {
    const d = m.ship;
    if (d.route !== null) {
      d.route.at(Math.max(d.route.legs[0]?.t0 ?? 0, d.t), out);
      return out;
    }
    this.#placeAt(d.to === WORK ? WORK : m.station, out, spot(), m);
    return out;
  }

  /**
   * Where a member is now, into out: along their walk, at their place, or
   * at their work (on a yard, where the yard is now); whether gone (on a
   * ladder or the shrouds), and whether out on a yard.
   */
  whereIs(m: ShipMember, out: Vector3): { gone: boolean; aloft: boolean } {
    const d = m.ship;
    const w = d.work;
    if (d.route === null && d.to === WORK && w?.yard != null) {
      const y = this.company.yards[w.yard.yard];
      if (y !== undefined) {
        out
          .set(w.yard.x, 0, 0)
          .applyMatrix4(yardFrame(y, turnOf(y, this.turns), this.reef, frameNow));
        return { gone: false, aloft: true };
      }
    }
    if (d.route !== null) {
      const at = walkerAt(d, out);
      return { gone: at.gone, aloft: false };
    }
    this.#where(m, out);
    return { gone: false, aloft: false };
  }

  /**
   * Who is aboard: those already aboard keep their places; when the
   * controls change hands, the new holder walks aft to relieve the one at
   * the wheel and anyone else whose place changes walks to it. walks:
   * false to put everyone in place at once (a ship first met).
   */
  set(crew: CrewAboard | null, walks = true): void {
    const old = this.#crew;
    this.#crew = crew;
    if (crew === null) {
      this.members = [];
      this.wheelSeat = -1;
      return;
    }
    const n = this.stations.length;
    const aboard = (seat: number): boolean => crew.people.some((p) => p.seat === seat);
    const holderAboard = aboard(crew.holder);
    // Nobody at the wheel yet, or whoever is gone ashore: the holder at once.
    if (!walks || this.still || !aboard(this.wheelSeat) || old === null) {
      this.wheelSeat = holderAboard ? crew.holder : -1;
    }
    const before = new Map(this.members.map((m) => [m.seat, m]));
    const members: ShipMember[] = [];
    const planned: ShipMember[] = [];
    for (const p of crew.people) {
      if (p.seat === this.wheelSeat) {
        continue;
      }
      // Their place: the holder's is behind the helmsman till relieved; the others' as placeOf has it.
      const place = p.seat === crew.holder ? RELIEF : placeOf(crew, p.seat, n);
      if (place === undefined) {
        continue;
      }
      let m = before.get(p.seat);
      if (m === undefined) {
        // Come aboard, or met afresh: at their place, or, the old helmsman just relieved, beside the wheel.
        m = this.#member(p.seat, p.look, place);
      } else {
        m.look = p.look;
        // At work for a place still theirs: kept at it.
        const working = m.ship.work !== null && m.station === place;
        if (m.ship.to !== place && !working) {
          m.ship.work = null;
          if (walks && !this.still) {
            this.#walk(m, null, place, planned);
            planned.push(m);
          } else {
            this.#put(m, place);
          }
        }
      }
      members.push(m);
    }
    this.members = members;
    this.version++;
    this.#talk();
  }

  #member(seat: number, look: number, place: number): ShipMember {
    const side = this.side.side || 1;
    const m: ShipMember = {
      seat,
      look,
      station: place,
      side,
      lean: 0,
      leanTo: 0,
      moving: null,
      ship: {
        route: null,
        t: 0,
        waited: 0,
        from: place,
        to: place,
        fromSpot: spot(),
        toSpot: spot(),
        sat: this.#stand ? 0 : 1,
        satTo: this.#stand ? 0 : 1,
        company: false,
        gone: false,
        relieving: 0,
        work: null,
        aside: { x: 0, z: 0 },
      },
    };
    this.#put(m, place);
    return m;
  }

  /** Puts a member at a place at once. */
  #put(m: ShipMember, place: number): void {
    const d = m.ship;
    d.route = null;
    d.t = 0;
    d.gone = false;
    d.from = place;
    d.to = place;
    d.relieving = 0;
    m.moving = null;
    m.station = place;
    this.#placeAt(place, here, d.toSpot);
    d.fromSpot.at.copy(d.toSpot.at);
    d.fromSpot.facing = d.toSpot.facing;
    d.fromSpot.side = d.toSpot.side;
    m.side = d.toSpot.side;
  }

  /**
   * Starts a member's walk to a place: from where they are, or from a place
   * (from); along the ways, kept off the stretches those in others (already
   * planned this moment) walk the other way.
   */
  #walk(
    m: ShipMember,
    from: number | null,
    to: number,
    others: readonly ShipMember[],
    begin: { at: Vector3; spot: ShipSpot } | null = null,
    aloft: { up?: { at: Vector3; time: number }; down?: { at: Vector3; time: number } } = {},
  ): void {
    const d = m.ship;
    const start = new Vector3();
    let fromSpot = spot();
    if (aloft.down !== undefined && begin !== null) {
      // Coming down from aloft: from the foot of the shrouds, after the climb down.
      start.copy(begin.at);
      fromSpot = begin.spot;
      d.from = WORK;
    } else if (begin !== null) {
      start.copy(begin.at);
      fromSpot = begin.spot;
      d.from = m.station;
    } else if (from !== null) {
      this.#placeAt(from, start, fromSpot);
      d.from = from;
    } else if (d.route !== null) {
      d.route.at(Math.max(d.route.legs[0]?.t0 ?? 0, d.t), start);
      fromSpot.at.copy(start);
      d.from = d.to;
    } else if (d.to === WORK) {
      this.#placeAt(WORK, start, fromSpot, m);
      d.from = WORK;
    } else {
      this.#placeAt(m.station, start, fromSpot);
      d.from = m.station;
    }
    const toSpot = spot();
    const end = new Vector3();
    this.#placeAt(to, end, toSpot, m);
    // Stretches others set off along at this moment, and which way.
    const met = new Map<number, number>();
    for (const o of others) {
      for (const [edge, way] of o.ship.route?.ways ?? []) {
        met.set(edge, way);
      }
    }
    const weather = this.side.side || 1;
    const toWindward = Math.sign(toSpot.at.x) === weather;
    const cost = (edge: number, forward: boolean, a: Vector3, b: Vector3): number => {
      let c = 1;
      // Going aft along her weather side, unless their place is to windward.
      const side =
        Math.abs(a.x) > SIDE_OUT && Math.abs(b.x) > SIDE_OUT && Math.sign(a.x) === weather;
      if (side && b.z > a.z + 1e-3 && !toWindward) {
        c *= LEE_COST;
      }
      const way = met.get(edge);
      if (way !== undefined && way !== (forward ? 1 : -1)) {
        c *= MET_COST;
      }
      return c;
    };
    const points = this.graph.route(start, end, cost);
    const down = aloft.down;
    const off = down === undefined && (d.route === null || from !== null) ? STEP_OFF : 0;
    const legs = legsOf(points, down === undefined ? off : down.time);
    // The climb (a cut, each topman's own): down from aloft before the walk, up aloft after it.
    const climb = -1000 - m.seat;
    if (down !== undefined) {
      legs.unshift({
        kind: 'cut',
        t0: 0,
        t1: down.time,
        path: null,
        edge: climb,
        from: down.at.clone(),
        to: start.clone(),
      });
    }
    if (aloft.up !== undefined) {
      const t = legs.at(-1)?.t1 ?? off;
      legs.push({
        kind: 'cut',
        t0: t,
        t1: t + aloft.up.time,
        path: null,
        edge: climb,
        from: end.clone(),
        to: aloft.up.at.clone(),
      });
    }
    const first = legs[0];
    const last = legs.at(-1);
    const route = new ShipRoute(
      legs,
      first?.kind === 'walk' ? off : 0,
      last?.kind === 'walk' ? STEP_IN : 0,
    );
    if (first?.kind !== 'walk' && down === undefined) {
      // Begins with a cut (from the top): gone at once.
      for (const l of legs) {
        l.t0 -= off;
        l.t1 -= off;
      }
    }
    // The stretches walked, and which way.
    for (let i = 1; i < points.length; i++) {
      const p = points[i] as { at: Vector3; kind: number; edge: number };
      const e = this.graph.edges[p.edge];
      if (p.kind !== 0 || e === undefined) {
        continue;
      }
      const prev = (points[i - 1] as { at: Vector3 }).at;
      const na = this.graph.nodes[e[0]] as Vector3;
      const nb = this.graph.nodes[e[1]] as Vector3;
      const dot = (p.at.x - prev.x) * (nb.x - na.x) + (p.at.z - prev.z) * (nb.z - na.z);
      route.ways.set(p.edge, dot >= 0 ? 1 : -1);
    }
    d.route = route;
    d.t = 0;
    d.waited = 0;
    d.to = to;
    d.relieving = 0;
    d.fromSpot = fromSpot;
    d.toSpot = toSpot;
    if (to !== WORK) {
      m.station = to;
    }
    m.side = toSpot.side;
    m.moving = {
      path: first?.path ?? deckPath([start, end]),
      from: { station: d.from, side: fromSpot.side } as CrewSpot,
      to: { station: to, side: toSpot.side },
      t: 0,
      duration: route.duration,
      kind: to === RELIEF || d.from === WHEEL ? 'change' : 'cross',
      waited: 0,
    };
  }

  /**
   * Everyone walks at once to the place of the one aboard after them (a
   * crowd's dearest moment, for tests and measuring): told who is aboard
   * again, they walk back.
   */
  shuffle(): void {
    const places = this.members.map((m) => m.station);
    const planned: ShipMember[] = [];
    this.members.forEach((m, i) => {
      const to = places[(i + 1) % places.length] as number;
      if (to !== m.station && !this.still) {
        this.#walk(m, null, to, planned);
        planned.push(m);
      }
    });
  }

  /** Whether each member has someone standing within TALK_NEAR of them, at their places. */
  #talk(): void {
    const at = this.members.map((m) => this.#where(m, new Vector3()));
    this.members.forEach((m, i) => {
      const a = at[i] as Vector3;
      m.ship.company = at.some(
        (b, j) =>
          j !== i &&
          (this.members[j] as ShipMember).ship.route === null &&
          a.distanceTo(b) < TALK_NEAR,
      );
    });
  }

  /** A frame: the weather side by the after yards, those on a hatch by the heel and wind, the walks and the relief. */
  step(m: CrewMoment): void {
    const dt = Math.max(0, m.dt);
    const ship = m.ship;
    if (ship !== undefined) {
      this.time = ship.time;
      this.turns.after = ship.yards;
      this.turns.fore = ship.foreYards ?? ship.yards;
      this.reef = ship.reef ?? 0;
      this.#swing(this.#swings.after, this.turns.after, dt);
      this.#swing(this.#swings.fore, this.turns.fore, dt);
      // The weather side: the side the after yards are braced for.
      const y = ship.yards;
      const was = this.side.side;
      let side = was;
      if (y > YARDS_SIDE || (was === 0 && y > 0)) {
        side = 1;
      } else if (y < -YARDS_SIDE || (was === 0 && y < 0)) {
        side = -1;
      }
      if (was === 0 && side === 0) {
        side = 1;
      }
      if (side !== was) {
        this.side.side = side;
        if (was !== 0) {
          this.side.changes++;
          this.#cross(was);
        } else {
          for (const p of this.members) {
            if (p.ship.route === null) {
              this.#put(p, p.station);
            }
          }
        }
      }
      // Those on a hatch: stand past the heel or wind, sit under them.
      const k = Math.min(1, dt / HEEL_SMOOTH);
      this.#heel += (Math.abs(ship.heel) - this.#heel) * k;
      const stand = this.#stand
        ? this.#heel > SIT_HEEL_BACK || ship.wind > SIT_WIND_BACK
        : this.#heel > SIT_HEEL || ship.wind > SIT_WIND;
      if (stand !== this.#stand) {
        this.#stand = stand;
        this.#since = 0;
      } else {
        this.#since += dt;
      }
    }
    const seated = this.members
      .filter((p) => this.stations[p.station]?.pose === 'seated')
      .sort((a, b) => a.seat - b.seat);
    seated.forEach((p, i) => {
      if (this.#since >= i * SIT_STAGGER) {
        p.ship.satTo = this.#stand ? 0 : 1;
      }
    });
    for (const p of this.members) {
      const d = p.ship;
      const step = dt / SIT_TIME;
      d.sat = d.satTo > d.sat ? Math.min(d.satTo, d.sat + step) : Math.max(d.satTo, d.sat - step);
    }
    this.#hands(dt);
    this.#topmen(dt);
    this.#walks(dt);
    this.#talkCheck -= dt;
    if (this.#talkCheck <= 0) {
      this.#talkCheck = 1;
      this.#talk();
    }
  }

  /** Follows a group of yards' swing by its turn: swinging once faster than SWING for SWING_START, stopped once slower for SWING_STOP. */
  #swing(sw: Swing, turn: number, dt: number): void {
    if (Number.isNaN(sw.last) || dt <= 0) {
      sw.last = turn;
      return;
    }
    const rate = (turn - sw.last) / dt;
    const was = sw.last;
    sw.last = turn;
    if (Math.abs(rate) > SWING) {
      if (sw.fast === 0 || Math.sign(rate) !== Math.sign(turn - sw.from)) {
        // Going fast from here, or the other way now.
        sw.from = was;
        sw.fast = 0;
      }
      sw.fast += dt;
      sw.slow = 0;
      if (sw.fast >= SWING_START && Math.abs(turn - sw.from) >= SWING_MOVE) {
        sw.on = true;
        sw.dir = Math.sign(rate);
      }
    } else {
      sw.slow += dt;
      sw.fast = 0;
      if (sw.slow >= SWING_STOP) {
        sw.on = false;
      }
    }
  }

  /** Whether a member may be sent to work: not one who stays (the helm, the master, the lookouts), nor aloft, nor relieving the wheel. */
  #free(m: ShipMember, haul: boolean): boolean {
    const d = m.ship;
    if (this.#keep.has(m.station) || d.to === RELIEF || this.still) {
      return false;
    }
    const w = d.work;
    return w === null || (haul ? w.kind === 'haul' : w.phase === 'back' && w.kind === 'haul');
  }

  /**
   * The hands at the braces: when a group of yards swings, all but those who
   * stay go to its hauled braces; when it stops, to the other group's if it
   * swings, else they coil down and, after COIL_TIME, walk back.
   */
  #hands(dt: number): void {
    const sw = this.#swings;
    const gang = this.gang;
    if (gang === null) {
      const group = sw.after.on ? 'after' : sw.fore.on ? 'fore' : null;
      if (group !== null) {
        this.#haulOn(group, hauledSide(sw[group].dir));
      }
    } else {
      const now = sw[gang.group];
      const other = gang.group === 'after' ? 'fore' : 'after';
      if (now.on) {
        gang.coil = -1;
        const side = hauledSide(now.dir);
        if (side !== gang.side) {
          this.#haulOn(gang.group, side);
        }
      } else if (sw[other].on) {
        this.#haulOn(other, hauledSide(sw[other].dir));
      } else {
        gang.coil = Math.max(0, gang.coil) + dt;
        if (gang.coil >= COIL_TIME) {
          this.gang = null;
          const planned: ShipMember[] = [];
          for (const m of this.members) {
            if (m.ship.work?.kind === 'haul' && m.ship.work.phase !== 'back') {
              this.#home(m, planned);
            }
          }
        }
      }
    }
    // How hard each at the braces hauls: while their group swings.
    const hauling = this.gang !== null && this.gang.coil < 0;
    const k = Math.min(1, dt / PULL_EASE);
    for (const m of this.members) {
      const w = m.ship.work;
      if (w?.kind === 'haul') {
        const want = hauling && w.phase === 'at' ? 1 : 0;
        w.pull += (want - w.pull) * k;
      }
    }
  }

  /** A member's walk back from their work to their station. */
  #home(m: ShipMember, planned: ShipMember[]): void {
    const w = m.ship.work;
    if (w === null) {
      return;
    }
    w.phase = 'back';
    this.#walk(m, null, m.station, planned);
    planned.push(m);
  }

  /**
   * Sends the hands to a group's braces on a side: the places in the order
   * they fill (the main or fore brace first), as many as there are hands;
   * anyone standing in a fall's way first, then the nearest. Each place
   * goes to the nearest of them; those not needed stay or walk back.
   */
  #haulOn(group: 'fore' | 'after', side: number): void {
    const c = this.company;
    const places = haulPlaces(c, group, side);
    this.gang = { group, side, coil: -1 };
    const free = this.members.filter((m) => this.#free(m, true));
    const at = new Map(free.map((m) => [m, this.#where(m, new Vector3())]));
    const home = new Map(
      free.map((m) => {
        const p = new Vector3();
        this.#placeAt(m.station, p, spot());
        return [m, p];
      }),
    );
    const near = (a: Vector3, b: Vector3): number =>
      Math.hypot(a.x - b.x, a.z - b.z) + (Math.abs(a.y - b.y) > 1 ? 3 : 0);
    const inWay = (m: ShipMember): boolean => {
      const p = home.get(m) as Vector3;
      return places.some(
        (q) =>
          Math.abs(q.feet.y - p.y) < 1 &&
          (Math.hypot(q.feet.x - p.x, q.feet.z - p.z) < FALL_CLEAR ||
            Math.hypot(q.hands.x - p.x, q.hands.z - p.z) < FALL_CLEAR),
      );
    };
    const nearest = (m: ShipMember): number =>
      Math.min(...places.map((q) => near(at.get(m) as Vector3, q.feet)));
    const chosen = [...free]
      .sort((a, b) => {
        const wa = inWay(a) ? 0 : 1;
        const wb = inWay(b) ? 0 : 1;
        return wa - wb || nearest(a) - nearest(b) || a.seat - b.seat;
      })
      .slice(0, places.length);
    const left = new Set(chosen);
    const planned: ShipMember[] = [];
    for (const q of places) {
      let best: ShipMember | null = null;
      let bestD = Number.POSITIVE_INFINITY;
      for (const m of left) {
        const dd = near(at.get(m) as Vector3, q.feet);
        if (dd < bestD) {
          best = m;
          bestD = dd;
        }
      }
      if (best === null) {
        break;
      }
      left.delete(best);
      const w = best.ship.work;
      if (
        w?.haul !== null &&
        w?.haul !== undefined &&
        w.phase !== 'back' &&
        w.haul.brace === q.brace &&
        w.haul.k === q.k &&
        w.haul.side === q.side
      ) {
        continue;
      }
      best.ship.work = {
        kind: 'haul',
        haul: q,
        pull: w?.kind === 'haul' ? w.pull : 0,
        yard: null,
        foot: q.feet,
        climb: 0,
        phase: 'going',
      };
      this.#walk(best, null, WORK, planned);
      planned.push(best);
    }
    // Those hauling before and not now: back to their stations.
    for (const m of free) {
      if (!chosen.includes(m) && m.ship.work?.kind === 'haul' && m.ship.work.phase !== 'back') {
        this.#home(m, planned);
      }
    }
  }

  /**
   * The topmen: when the reef changes, up to four a yard (two on the
   * mizzen topsail's) go aloft by the weather shrouds of its mast, those
   * of the waist's and the forecastle's stations nearest it; once the reef
   * is in, they come down and walk back.
   */
  #topmen(dt: number): void {
    const r = this.#reefing;
    const reef = this.reef;
    if (Number.isNaN(r.last)) {
      r.last = reef;
    } else if (Math.abs(reef - r.last) > 1e-5) {
      const up = reef > r.last;
      r.band = Math.min(
        2,
        Math.max(1, up ? Math.floor(r.last + 1e-6) + 1 : Math.ceil(r.last - 1e-6)),
      );
      r.still = 0;
      r.last = reef;
    } else {
      r.still += dt;
    }
    const reefing = r.still < REEF_STILL;
    if (reefing && r.band !== this.aloftBand) {
      this.#comeDown();
      this.aloftBand = r.band;
      this.#goAloft(r.band);
    } else if (!reefing && this.aloftBand !== 0) {
      this.aloftBand = 0;
      this.#comeDown();
    }
  }

  /** Sends topmen aloft to the yards reefed in a band, by the weather shrouds. */
  #goAloft(band: number): void {
    const c = this.company;
    const weather = this.side.side || 1;
    const taken = new Set<ShipMember>();
    const planned: ShipMember[] = [];
    const yard = new Vector3();
    const frame = new Matrix4();
    for (const yi of reefedYards(c, band)) {
      const y = c.yards[yi];
      const foot = c.aloft.find((a) => a.mast === y?.mast)?.foot;
      if (y === undefined || foot === undefined) {
        continue;
      }
      const at = new Vector3(weather * foot.x, foot.y, foot.z);
      for (const place of yardPlaces(c, yi)) {
        // The nearest the mast of those free in the waist and on the forecastle.
        let best: ShipMember | null = null;
        let bestD = Number.POSITIVE_INFINITY;
        for (const m of this.members) {
          if (taken.has(m) || !this.#free(m, false)) {
            continue;
          }
          const p = new Vector3();
          this.#placeAt(m.station, p, spot());
          if (p.z > 0 && p.y > 4.5) {
            // On the quarterdeck.
            continue;
          }
          const dd = Math.abs(p.z - y.origin.z) + Math.abs(p.x) * 0.1;
          if (dd < bestD) {
            best = m;
            bestD = dd;
          }
        }
        if (best === null) {
          break;
        }
        taken.add(best);
        yardFrame(y, turnOf(y, this.turns), this.reef, frame);
        yard.set(place.x, 0, 0).applyMatrix4(frame);
        const climb = CLIMB_PER_METRE * Math.max(0, yard.y - at.y);
        best.ship.work = {
          kind: 'aloft',
          haul: null,
          pull: 0,
          yard: place,
          foot: at.clone(),
          climb,
          phase: 'going',
        };
        this.#walk(best, null, WORK, planned, null, { up: { at: yard.clone(), time: climb } });
        planned.push(best);
      }
    }
  }

  /** The topmen come down: from the yard by the shrouds they went up, or back from wherever they are, and walk back. */
  #comeDown(): void {
    const planned: ShipMember[] = [];
    const frame = new Matrix4();
    for (const m of this.members) {
      const w = m.ship.work;
      if (w?.kind !== 'aloft' || w.phase === 'back' || w.yard === null) {
        continue;
      }
      const d = m.ship;
      const r = d.route;
      const now = r?.legAt(Math.max(r.legs[0]?.t0 ?? 0, d.t)) ?? null;
      let down: { at: Vector3; time: number } | null = null;
      if (r === null) {
        // On the yard.
        const y = this.company.yards[w.yard.yard];
        if (y !== undefined) {
          yardFrame(y, turnOf(y, this.turns), this.reef, frame);
          down = { at: new Vector3(w.yard.x, 0, 0).applyMatrix4(frame), time: w.climb };
        }
      } else if (now !== null && now.kind === 'cut' && now.edge === -1000 - m.seat) {
        // On the shrouds going up: down again as far as they climbed.
        down = { at: now.to.clone(), time: Math.max(0.5, d.t - now.t0) };
      }
      w.phase = 'back';
      if (down !== null) {
        const sp = spot();
        sp.at.copy(w.foot);
        sp.side = Math.sign(w.foot.x) || 1;
        this.#walk(m, null, m.station, planned, { at: w.foot.clone(), spot: sp }, { down });
      } else {
        this.#walk(m, null, m.station, planned);
      }
      planned.push(m);
    }
  }

  /** The weather side changed from was: those to windward and to leeward walk across, from where they were. */
  #cross(was: number): void {
    const planned: ShipMember[] = [];
    for (const p of this.members) {
      const s = this.stations[p.station];
      if (s === undefined || (s.windward !== true && s.lee !== true) || p.ship.work !== null) {
        // At work: to the new side once back.
        continue;
      }
      if (this.still) {
        this.#put(p, p.station);
        continue;
      }
      let start: { at: Vector3; spot: ShipSpot } | null = null;
      if (p.ship.route === null) {
        const sp = shipStation(s, was, spot());
        start = { at: standPoint(s, sp, new Vector3()), spot: sp };
      }
      this.#walk(p, null, p.station, planned, start);
      planned.push(p);
    }
  }

  /**
   * The walks on: each waits for a ladder another is on, and behind anyone
   * ahead of them in their way (walking or standing), for at most
   * WAIT_MOST each time; two meeting head-on pass, each keeping to their
   * right.
   */
  #walks(dt: number): void {
    const walkers = this.members.filter((p) => p.ship.route !== null);
    if (walkers.length === 0) {
      return;
    }
    // Where everyone is, and which way each walker heads.
    const all = this.members.map((p) => {
      const v = new Vector3();
      const r = p.ship.route;
      if (r === null) {
        const w = this.whereIs(p, v);
        return {
          p,
          v,
          yaw: 0,
          gone: w.gone || w.aloft,
          leg: null as ShipLeg | null,
          walking: false,
        };
      }
      const w = walkerAt(p.ship, v);
      return { p, v, yaw: w.yaw, gone: w.gone, leg: w.leg, walking: true };
    });
    for (const me of all) {
      if (!me.walking) {
        continue;
      }
      const p = me.p;
      const d = p.ship;
      const r = d.route as ShipRoute;
      let next = d.t + dt;
      // Arrived behind the helmsman: waits, then takes the spokes.
      if (d.to === RELIEF && next >= r.duration) {
        d.t = r.duration;
        d.relieving += dt;
        if (d.relieving >= RELIEF_PAUSE) {
          this.#relieve(p);
        }
        continue;
      }
      let wait = false;
      // A ladder or the climb ahead, with someone on it: wait at its foot.
      const ahead = r.legAt(next);
      if (ahead !== null && ahead.kind === 'cut' && (me.leg === null || me.leg !== ahead)) {
        wait = all.some((o) => o !== me && o.leg?.edge === ahead.edge && o.gone);
      }
      // Someone ahead in their way, within KEEP_BEHIND: keeps behind; one
      // coming the other way, the lesser steps aside, away from them, and
      // waits for them to pass, and the other waits till they have; two in
      // each other's way otherwise, the lesser waits.
      let ax = 0;
      let az = 0;
      let back = false;
      if (!wait && !me.gone && me.leg !== null && d.t >= me.leg.t0) {
        for (const o of all) {
          if (o === me || o.gone || Math.abs(o.v.y - me.v.y) > 1 || inWay(me, o) === null) {
            continue;
          }
          if (!o.walking || o.leg === null) {
            wait = true;
            continue;
          }
          const lesser = p.seat > o.p.seat;
          const facing = Math.sin(o.yaw) * Math.sin(me.yaw) + Math.cos(o.yaw) * Math.cos(me.yaw);
          if (facing < -0.7) {
            // Coming the other way: the lesser steps aside off their line; the other waits till they have.
            if (lesser) {
              const rx = -Math.cos(o.yaw);
              const rz = Math.sin(o.yaw);
              const side = (me.v.x - o.v.x) * rx + (me.v.z - o.v.z) * rz >= 0 ? 1 : -1;
              ax = side * rx * ASIDE;
              az = side * rz * ASIDE;
              wait = true;
            } else if (Math.hypot(o.p.ship.aside.x, o.p.ship.aside.z) < ASIDE * 0.9) {
              wait = true;
            }
          } else if (inWay(o, me) === null) {
            // Behind them: keeps behind.
            wait = true;
          } else if (lesser) {
            // Across each other's way: the lesser steps back out of it.
            wait = true;
            back = true;
          }
        }
      }
      const step = ASIDE_SPEED * dt;
      const ex = ax - d.aside.x;
      const ez = az - d.aside.z;
      const el = Math.hypot(ex, ez);
      if (el > 0) {
        const k = Math.min(1, step / el);
        d.aside.x += ex * k;
        d.aside.z += ez * k;
      }
      if (wait && d.waited < WAIT_MOST) {
        d.waited += dt;
        next = back && me.leg !== null ? Math.max(me.leg.t0, d.t - dt) : d.t;
      } else if (!wait) {
        d.waited = 0;
      }
      d.t = next;
      if (p.moving !== null) {
        p.moving.t = d.t;
        p.moving.waited = d.waited;
      }
      d.gone = r.at(Math.max(r.legs[0]?.t0 ?? 0, d.t), there).gone && d.t < r.duration;
      if (d.t >= r.duration) {
        this.#arrive(p);
      }
    }
  }

  /** A walk ended: at their place, or at their work. */
  #arrive(p: ShipMember): void {
    const d = p.ship;
    d.aside.x = 0;
    d.aside.z = 0;
    d.route = null;
    d.t = 0;
    d.gone = false;
    p.moving = null;
    d.from = d.to;
    p.side = d.toSpot.side;
    if (d.work !== null) {
      if (d.to === WORK) {
        d.work.phase = 'at';
      } else {
        d.work = null;
      }
    }
  }

  /** The relief takes the spokes: the one at the wheel steps to leeward and walks to their place. */
  #relieve(p: ShipMember): void {
    const crew = this.#crew;
    const old = this.wheelSeat;
    this.wheelSeat = p.seat;
    this.members = this.members.filter((x) => x !== p);
    this.version++;
    if (crew === null) {
      return;
    }
    const was = crew.people.find((q) => q.seat === old);
    const place = was === undefined ? undefined : placeOf(crew, old, this.stations.length);
    if (was !== undefined && place !== undefined && place >= 0) {
      const m = this.#member(old, was.look, place);
      this.#walk(m, WHEEL, place, this.members);
      this.members.push(m);
    }
  }
}

/**
 * The ship's moment, beside the crew's: her after yards' turn and her fore
 * yards' (as yardsTurn has them; the after ones' if not told), her reef
 * (0 … 2), her heel, the wind's speed (m/s) and the world's time (s).
 */
export interface ShipMoment {
  yards: number;
  foreYards?: number;
  reef?: number;
  heel: number;
  wind: number;
  time: number;
}
