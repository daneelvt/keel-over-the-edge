// SPDX-License-Identifier: AGPL-3.0-only

// What a boat's crew does, by rule, from what is known of the boat each
// frame (its boom, the wind off its bow, how far its helm hikes), with no
// drawing in it: so the same rules run for the boat in view and for any
// other boat from its state as it is drawn.
//
// - The crew sit to windward: the side away from the boom. The side
//   changes once the boom has crossed the centreline by SIDE_HYSTERESIS,
//   so a boom slatting in a calm moves nobody; a helm sitting to leeward
//   does not take them with it.
// - When it changes, each person at a station to windward crosses to the
//   new side at a crouch, along a path that stays in the boat: through the
//   cockpit for those whose station is beside it, round the front of the
//   mast for those forward of it. In a tack those through the cockpit go
//   first, from forward aft, then those round the mast from aft forward,
//   each CROSS_GAP after the one before; in a gybe the other way about. A
//   tack is told from a gybe by the wind: forward of the beam, a tack.
// - The crew sit up while the helm sits in, and lean out once the helm
//   hikes past LEAN_OUT, back below LEAN_IN; each moves over LEAN_TIME,
//   LEAN_STAGGER after the one aft of them.
// - When the controls are handed over, everyone whose place changes walks
//   to their new place at a crouch along the windward side deck; the helm
//   is drawn by the crew meanwhile, not at the tiller.
//
// Everything is in the boat model's frame (x to starboard, y up, z aft).

import type { BoatStation } from '../../catalog';
import type { HullSolid } from './solid';

/** How far past the centreline the boom must go before the crew's side changes, radians. */
export const SIDE_HYSTERESIS = (5 * Math.PI) / 180;
/** Seconds between one person's crossing and the next's. */
export const CROSS_GAP = 0.4;
/** Seconds to come off a station into the crouch, and to sit down out of it. */
export const RISE = 0.5;
export const SIT = 0.5;
/** How far a step of the crouch's walk goes, m: half its cycle at its own speed (rail.ts). */
export const STRIDE = 0.7;
/** How fast a crossing person goes along the path, m/s. */
export const CROSS_SPEED = 1;
/** The helm's hiking depth past which the crew lean out, and under which they sit up again. */
export const LEAN_OUT = 0.25;
export const LEAN_IN = 0.15;
/** Seconds each takes to lean out or sit up, and between one and the next, aft first. */
export const LEAN_TIME = 0.6;
export const LEAN_STAGGER = 0.3;
/** How far round the front of the mast a crossing goes, from its centre, m. */
export const MAST_CLEAR = 0.45;
/** How far inboard of the deck's edge a walk along the side deck goes, forward of the cockpit, m. */
export const EDGE_IN = 0.29;
/** How far in from the cockpit's sides and ends a crossing through it goes, m. */
export const COCKPIT_IN = 0.25;
const COCKPIT_END = 0.2;
/** How far aft of the cockpit's fore end (the cuddy's after face) a crossing aft through it goes, m. */
const COCKPIT_FORE = 0.35;
/** How far out from the cockpit's side (and the cuddy's, as wide at its after end) a walk along the side deck keeps beside them, m. */
const COCKPIT_SIDE = 0.28;
/** How near the boom may cross the side deck to a station, m, for its person to wait before crossing: it is over them. */
export const BOOM_OVER = 0.45;
/** Whether those forward of the cockpit go aft through it when the boom lies forward of them. */
const AFT_WAY = false;
/** The longest a person waits for the boom to move off before crossing all the same, seconds. */
export const WAIT_MOST = 3;
/** How far two people changing places along the side deck keep from each other's line, m; and how far aft of the helm's place one coming forward to it stops before sitting. */
export const PASS = 0.04;
const APPROACH = 0.15;
/** How far one crossing behind another along the same way keeps behind them, m. */
export const FOLLOW = 0.6;
/** The corners of a path rounded to this radius, m. */
const CORNER = 0.3;
/** A path's points at most this far apart, m. */
const STEP = 0.05;
/** How long a step down into the cockpit or up out of it is taken over, m; and how high a change of the deck is a step. */
const STEP_SPREAD = 0.4;
const STEP_HEIGHT = 0.05;

/** A boat's deck, as its crew's paths need it. */
export interface CrewPlan {
  stations: readonly BoatStation[];
  /** The deck's edge out from the centreline at z, and the sheer's height there. */
  edge(z: number): number;
  sheer(z: number): number;
  /** The cockpit, open above its floor; null for a boat with none (crossings go over the deck). */
  cockpit: { fore: number; aft: number; halfWidth: number; floor: number } | null;
  /** The mast's foot (z) and the boom: its gooseneck (y up, z aft) and its length. */
  mastZ: number;
  boom: { y: number; z: number; length: number };
  /** The deck's height under (x, z) as the model has it, crown and all; null where it has none there. */
  deck: ((x: number, z: number) => number | null) | null;
  /**
   * The tiller, over the cockpit on the centreline: its head (z, at the
   * rudder's stock), the extension's hinge on it (z), and the height of its
   * top; null for a boat with none (a wheel, or no cockpit).
   */
  tiller: { head: number; hinge: number; top: number } | null;
}

/** A boat's plan from its kind's stations, its model's hull solid, its boom's gooseneck and, if it can be read, its deck. */
export function crewPlan(
  stations: readonly BoatStation[],
  solid: HullSolid | null,
  gooseneck: { y: number; z: number } | null,
  boomLength: number,
  deck: CrewPlan['deck'] = null,
  tiller: CrewPlan['tiller'] = null,
): CrewPlan {
  const st = solid?.stations ?? [];
  const along = (z: number, k: number): number => {
    for (let i = 0; i + 1 < st.length; i++) {
      const a = st[i] as number[];
      const b = st[i + 1] as number[];
      const za = a[0] as number;
      const zb = b[0] as number;
      if ((z <= za && z >= zb) || (z >= za && z <= zb)) {
        const f = za === zb ? 0 : (z - za) / (zb - za);
        return (a[k] as number) + ((b[k] as number) - (a[k] as number)) * f;
      }
    }
    // Beyond the ends: the nearest end's.
    const end =
      st.length === 0
        ? null
        : Math.abs(z - (st[0]?.[0] ?? 0)) < Math.abs(z - (st.at(-1)?.[0] ?? 0))
          ? st[0]
          : st.at(-1);
    return (end?.[k] as number | undefined) ?? 0;
  };
  const plan: CrewPlan = {
    stations,
    edge: (z) => along(z, 1),
    sheer: (z) => along(z, 2),
    cockpit: solid?.cockpit ?? null,
    mastZ: gooseneck?.z ?? 0,
    boom: { y: gooseneck?.y ?? 0, z: gooseneck?.z ?? 0, length: boomLength },
    deck,
    tiller,
  };
  return plan;
}

/** The deck's height under (x, z): the model's, else the cockpit's floor within it and the sheer's without. */
export function deckY(plan: CrewPlan, x: number, z: number): number {
  const d = plan.deck?.(x, z) ?? null;
  if (d !== null) {
    return d;
  }
  const c = plan.cockpit;
  if (c !== null && z > c.fore && z < c.aft && Math.abs(x) < c.halfWidth) {
    return c.floor;
  }
  return plan.sheer(z);
}

/** How a station's person crosses the boat: through the cockpit, or round the front of the mast. */
export function crossingWay(plan: CrewPlan, station: BoatStation): 'cockpit' | 'mast' {
  const c = plan.cockpit;
  const z = station.at[2] as number;
  return c !== null && z >= c.fore - 0.1 ? 'cockpit' : 'mast';
}

/** Where a walk along the side deck goes at z, out from the centreline: between the cockpit's side and the edge, or EDGE_IN in from the edge forward of it. */
export function sideDeckX(plan: CrewPlan, z: number): number {
  const c = plan.cockpit;
  const edge = plan.edge(z);
  const x = Math.max(edge - EDGE_IN, edge / 2);
  if (c !== null && z > c.fore - COCKPIT_END && z < c.aft) {
    return Math.max((c.halfWidth + edge) / 2, Math.min(x, c.halfWidth + COCKPIT_SIDE));
  }
  return x;
}

/** A path over the deck: points close together, each with its height, and the distance along to each. */
export class CrewPath {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly s: Float32Array;
  readonly length: number;
  /** Where along it the deck steps up or down (into the cockpit or out of it): each step's start and end, metres along. */
  readonly steps: [number, number][] = [];
  /** Where along it something lying across it is stepped over: each step's start and end, metres along, and how high the feet go. */
  readonly overs: [number, number, number][] = [];
  /** How many whole steps of the walk it takes. */
  readonly paces: number;

  /** The steps and the stretches stepped over, in order along it: their starts and ends. */
  get anchors(): readonly (readonly [number, number])[] {
    return [...this.steps, ...this.overs.map((o): [number, number] => [o[0], o[1]])].sort(
      (a, b) => a[0] - b[0],
    );
  }

  constructor(
    points: readonly [number, number, number][],
    /** Stretches of the path, (x, z) to (x, z), over which something is stepped, and how high. */
    over: readonly { from: [number, number]; to: [number, number]; top: number }[] = [],
  ) {
    const n = points.length;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.z = new Float32Array(n);
    this.s = new Float32Array(n);
    let s = 0;
    points.forEach(([x, y, z], i) => {
      if (i > 0) {
        s += Math.hypot(x - (this.x[i - 1] as number), z - (this.z[i - 1] as number));
      }
      this.x[i] = x;
      this.y[i] = y;
      this.z[i] = z;
      this.s[i] = s;
    });
    this.length = s;
    // A step: the deck's height changing by more than STEP_HEIGHT between two points.
    for (let i = 0; i + 1 < n; i++) {
      if (Math.abs((this.y[i + 1] as number) - (this.y[i] as number)) > STEP_HEIGHT) {
        const mid = ((this.s[i] as number) + (this.s[i + 1] as number)) / 2;
        this.steps.push([
          Math.max(0, mid - STEP_SPREAD / 2),
          Math.min(this.length, mid + STEP_SPREAD / 2),
        ]);
      }
    }
    // Each stretch stepped over: from the point nearest its start to the point nearest its end.
    const nearest = ([x, z]: [number, number]): number => {
      let best = 0;
      let d = Number.POSITIVE_INFINITY;
      for (let i = 0; i < n; i++) {
        const e = Math.hypot((this.x[i] as number) - x, (this.z[i] as number) - z);
        if (e < d) {
          d = e;
          best = this.s[i] as number;
        }
      }
      return best;
    };
    this.paces = Math.max(1, Math.round(this.length / STRIDE));
    for (const o of over) {
      const a = nearest(o.from);
      const b = nearest(o.to);
      this.overs.push([Math.min(a, b), Math.max(a, b), o.top]);
    }
    // A step of the deck within a stretch stepped over is taken with it.
    const inOver = (st: [number, number]): boolean =>
      this.overs.some((o) => st[1] > o[0] && st[0] < o[1]);
    const steps = this.steps.filter((st) => !inOver(st));
    this.steps.length = 0;
    this.steps.push(...steps);
  }

  /** The step s lies on, if it lies on one: a step of the deck, or a stretch stepped over. */
  stepAt(s: number): [number, number] | null {
    for (const step of this.steps) {
      if (s > step[0] && s < step[1]) {
        return step;
      }
    }
    for (const o of this.overs) {
      if (s > o[0] && s < o[1]) {
        return [o[0], o[1]];
      }
    }
    return null;
  }

  /** How high the feet are carried at s, stepping over something there; −∞ if nothing is. */
  overAt(s: number): number {
    for (const o of this.overs) {
      if (s > o[0] && s < o[1]) {
        return o[2];
      }
    }
    return Number.NEGATIVE_INFINITY;
  }

  /**
   * The point s along (clamped to the path), into at, and the way it heads
   * there as a yaw: the figure's +z turned to (sin yaw, cos yaw).
   */
  at(s: number, at: { x: number; y: number; z: number }): number {
    const n = this.s.length;
    const d = Math.max(0, Math.min(this.length, s));
    let i = 0;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((this.s[mid] as number) <= d) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    i = Math.min(lo, n - 2);
    const s0 = this.s[i] as number;
    const s1 = this.s[i + 1] as number;
    const f = s1 > s0 ? (d - s0) / (s1 - s0) : 0;
    const x0 = this.x[i] as number;
    const z0 = this.z[i] as number;
    const x1 = this.x[i + 1] as number;
    const z1 = this.z[i + 1] as number;
    at.x = x0 + (x1 - x0) * f;
    at.y = (this.y[i] as number) + ((this.y[i + 1] as number) - (this.y[i] as number)) * f;
    at.z = z0 + (z1 - z0) * f;
    return Math.atan2(x1 - x0, z1 - z0);
  }
}

/**
 * A path over the deck through waypoints (x, z), its corners rounded, its
 * points STEP apart at most, each at the deck's height (a step into the
 * cockpit or out of it taken over STEP_SPREAD: CrewPath's steps).
 */
export function pathThrough(
  plan: CrewPlan,
  way: readonly [number, number][],
  over: ConstructorParameters<typeof CrewPath>[1] = [],
): CrewPath {
  // The corners rounded: each replaced by an arc from the line before to the line after.
  const flat: [number, number][] = [];
  for (let i = 0; i < way.length; i++) {
    const p = way[i] as [number, number];
    if (i === 0 || i === way.length - 1) {
      flat.push(p);
      continue;
    }
    const a = way[i - 1] as [number, number];
    const b = way[i + 1] as [number, number];
    const la = Math.hypot(p[0] - a[0], p[1] - a[1]);
    const lb = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const r = Math.min(CORNER, la / 2, lb / 2);
    if (r <= 1e-6) {
      flat.push(p);
      continue;
    }
    const ua: [number, number] = [(p[0] - a[0]) / la, (p[1] - a[1]) / la];
    const ub: [number, number] = [(b[0] - p[0]) / lb, (b[1] - p[1]) / lb];
    // A quadratic curve from r before the corner to r after it, the corner its control.
    const from: [number, number] = [p[0] - ua[0] * r, p[1] - ua[1] * r];
    const to: [number, number] = [p[0] + ub[0] * r, p[1] + ub[1] * r];
    const k = 8;
    for (let j = 0; j <= k; j++) {
      const t = j / k;
      const u = 1 - t;
      flat.push([
        u * u * from[0] + 2 * u * t * p[0] + t * t * to[0],
        u * u * from[1] + 2 * u * t * p[1] + t * t * to[1],
      ]);
    }
  }
  // Points no further than STEP apart.
  const dense: [number, number][] = [];
  for (let i = 0; i < flat.length; i++) {
    const p = flat[i] as [number, number];
    if (i > 0) {
      const a = flat[i - 1] as [number, number];
      const l = Math.hypot(p[0] - a[0], p[1] - a[1]);
      const k = Math.ceil(l / STEP);
      for (let j = 1; j < k; j++) {
        dense.push([a[0] + ((p[0] - a[0]) * j) / k, a[1] + ((p[1] - a[1]) * j) / k]);
      }
    }
    if (
      i === 0 ||
      Math.hypot(p[0] - (dense.at(-1)?.[0] ?? 0), p[1] - (dense.at(-1)?.[1] ?? 0)) > 1e-6
    ) {
      dense.push(p);
    }
  }
  // The deck's height under each: a step is taken as a step (CrewPath's steps).
  const points = dense.map(([x, z]): [number, number, number] => [x, deckY(plan, x, z), z]);
  return new CrewPath(points, over);
}

/** A station's point on a side (+1 starboard), as the windward rule draws it: its own, or its mirror. */
export function sideOf(station: BoatStation): number {
  return (station.at[0] as number) < 0 ? -1 : 1;
}

/**
 * Where along the side deck's line on the boom's side, beside a station,
 * the boom (radians, + starboard) crosses it (z); null if it does not
 * reach it.
 */
export function boomOverDeck(plan: CrewPlan, z: number, boom: number): number | null {
  const a = Math.abs(boom);
  const x = sideDeckX(plan, z);
  if (a < 1e-6 || plan.boom.length * Math.sin(a) < x) {
    return null;
  }
  return plan.boom.z + x / Math.tan(a);
}

/**
 * Whether the boom (radians, + starboard) lies over a station's place on
 * its side deck, on side: a crossing waits for it to move off.
 */
export function boomOver(
  plan: CrewPlan,
  station: BoatStation,
  side: number,
  boom: number,
): boolean {
  if (side * boom <= 0) {
    return false;
  }
  const z = station.at[2] as number;
  const at = boomOverDeck(plan, z, boom);
  return at !== null && Math.abs(at - z) < BOOM_OVER;
}

/** A crossing through the cockpit this near the tiller's hinge, or aft of it, goes over the deck aft of the cockpit instead, m. */
export const TILLER_CLEAR = 0.3;
/**
 * How far either side of the centreline a crossing behind the cockpit
 * steps over the tiller, m: from where the walk's feet are clear of it
 * wherever the rudder swings it, to where they are again; and how high
 * over its top the feet go.
 */
export const TILLER_SWING = 0.45;
export const TILLER_STEP = 0.12;
/** How far in from the deck's edge a crossing behind the cockpit walks beside it, m: the side deck there is narrow. */
export const QUARTER_IN = 0.14;

/**
 * The path a station's person takes across the boat, from the side from
 * to the other, to the station to (their own, or another of the same way
 * across): straight through the cockpit at the station (kept clear of its
 * ends); aft of the tiller's hinge, aft along the side deck and over the
 * deck aft of the cockpit, stepping over the tiller; or, forward of the
 * cockpit, along the side deck to the front of the mast, round it and back
 * along the other side deck, or, when the boom (radians, + starboard) out
 * on the side left crosses the side deck forward of the station, aft
 * along it and through the cockpit's fore end.
 */
export function crossPath(
  plan: CrewPlan,
  station: BoatStation,
  from: number,
  boom = 0,
  to: BoatStation = station,
): CrewPath {
  const z = station.at[2] as number;
  const z1 = to.at[2] as number;
  const c = plan.cockpit;
  const t = plan.tiller;
  if (
    crossingWay(plan, station) === 'cockpit' &&
    c !== null &&
    t !== null &&
    z > t.hinge - TILLER_CLEAR
  ) {
    // Behind the cockpit, between its after end and the tiller's head.
    const za = (c.aft + t.head) / 2;
    const zs = c.aft;
    const xa = sideDeckX(plan, za);
    // Along the side deck beside the cockpit's after end, as far out as the walk goes.
    const out = (zz: number): number => plan.edge(zz) - QUARTER_IN;
    return pathThrough(
      plan,
      [
        [from * out(z), z],
        [from * out(zs), zs],
        [from * xa, za],
        [-from * xa, za],
        [-from * out(zs), zs],
        [-from * out(z1), z1],
      ],
      [
        {
          from: [from * TILLER_SWING, za],
          to: [-from * TILLER_SWING, za],
          top: t.top + TILLER_STEP,
        },
      ],
    );
  }
  // Across the cockpit's floor, COCKPIT_IN in from its sides at most, in whole steps.
  const across = (): number =>
    c === null
      ? 0.35
      : (Math.max(1, Math.floor((2 * (c.halfWidth - COCKPIT_IN)) / STRIDE)) * STRIDE) / 2;
  if (crossingWay(plan, station) === 'cockpit' && c !== null) {
    const zc = Math.max(c.fore + COCKPIT_END, Math.min(c.aft - COCKPIT_END, z));
    const x = across();
    return pathThrough(plan, [
      [from * x, zc],
      [-from * x, zc],
    ]);
  }
  const over = AFT_WAY && from * boom > 0 ? boomOverDeck(plan, z, boom) : null;
  if (c !== null && over !== null && over < z) {
    const za = c.fore + COCKPIT_FORE;
    const x = across();
    return pathThrough(plan, [
      [from * sideDeckX(plan, z), z],
      [from * sideDeckX(plan, za), za],
      [from * x, za],
      [-from * x, za],
      [-from * sideDeckX(plan, za), za],
      [-from * sideDeckX(plan, z), z],
    ]);
  }
  const zf = plan.mastZ - MAST_CLEAR;
  return pathThrough(plan, [
    [from * sideDeckX(plan, z), z],
    [from * sideDeckX(plan, zf), zf],
    [-from * sideDeckX(plan, zf), zf],
    [-from * sideDeckX(plan, z1), z1],
  ]);
}

/**
 * The path along the side deck on side from one z to another, kept off
 * the line by off (outboard, +): for two people changing places.
 */
export function walkPath(
  plan: CrewPlan,
  side: number,
  z0: number,
  z1: number,
  off: number,
): CrewPath {
  const way: [number, number][] = [];
  const c = plan.cockpit;
  // A point at each end, and at the cockpit's fore end if it lies between.
  const zs = [z0];
  if (c !== null && (c.fore - z0) * (c.fore - z1) < 0) {
    zs.push(c.fore);
  }
  zs.push(z1);
  for (const z of zs) {
    way.push([side * (sideDeckX(plan, z) + off), z]);
  }
  return pathThrough(plan, way);
}

/**
 * The cockpit floor's lanes for a change of places, out from the
 * centreline to windward as fractions of the floor's half-width: the one
 * walking aft's, about the middle, and the one walking forward's, to
 * leeward; so that two changing places pass each other apart, inboard of
 * the feet of anyone sat on the windward side. A walk on the floor begins
 * and ends at LANE_ENDS, inboard of the feet of whoever sits there.
 */
export const LANE_AFT = 0.14;
export const LANE_FORE = -0.5;
export const LANE_ENDS = 0.34;
/** How far along a walk on the cockpit's floor goes into its lane and out of it, m; and how far past the place it goes to one walking forward goes before coming back to it. */
const LANE_TURN = 0.2;
const LANE_PAST = 0.4;
/**
 * The path someone changing places takes on side, from a place at z0 to
 * one at z1. Both beside the cockpit: on its floor, in the lane for the way
 * they walk, from inboard of their place to inboard of the other (kept
 * forward of the tiller); walking forward, on past the place forward and
 * back to it, while the one there goes aft. Otherwise, along the side
 * deck, kept off its line by off (outboard, +), as walkPath has it.
 */
export function changePath(
  plan: CrewPlan,
  side: number,
  z0: number,
  z1: number,
  off = 0,
): CrewPath {
  const c = plan.cockpit;
  if (c === null || Math.min(z0, z1) < c.fore) {
    return walkPath(plan, side, z0, z1, off);
  }
  const lane = (z1 > z0 ? LANE_AFT : LANE_FORE) * c.halfWidth;
  const near = LANE_ENDS * c.halfWidth;
  const lo = c.fore + COCKPIT_FORE;
  const hi = Math.min(
    c.aft - COCKPIT_END,
    plan.tiller === null ? Number.POSITIVE_INFINITY : plan.tiller.hinge - TILLER_CLEAR,
  );
  const floorZ = (z: number): number => Math.max(lo, Math.min(hi, z));
  const start = floorZ(Math.min(z0, z1));
  const stop = floorZ(Math.max(z0, z1));
  const turn = Math.min(LANE_TURN, (stop - start) / 3);
  const past = z1 < z0 ? Math.max(lo, start - LANE_PAST) : start + turn;
  // From the forward place aft, + to windward.
  const way: [number, number][] = [
    [near, start],
    [lane, past],
    [lane, stop - turn],
    [near, stop],
  ];
  if (z1 < z0) {
    way.reverse();
  }
  return pathThrough(
    plan,
    way.map(([x, z]): [number, number] => [side * x, z]),
  );
}

/** How far apart, m, two people changing places keep while both move, and while one waits at their place or is at their new one; and the most a walk waits for another to pass, s. */
export const KEEP = 0.8;
export const KEEP_STILL = 0.35;
const KEEP_WAIT = 8;

/** Where someone moving is at t seconds into a move, in (x, z): at their place, along the path, at their new place. */
function moveSpot(plan: CrewPlan, mv: CrewMove, t: number, out: { x: number; z: number }): void {
  const place = (spot: CrewSpot, o: { x: number; z: number }): void => {
    const st = plan.stations[Math.max(0, spot.station)];
    const x = Math.abs((st?.at[0] as number | undefined) ?? 0);
    o.x = spot.side * x;
    o.z = (st?.at[2] as number | undefined) ?? 0;
  };
  const at = { x: 0, y: 0, z: 0 };
  const w = moveAt({ ...mv, t }, { rise: 0, along: 0, sit: 0 });
  if (t <= 0) {
    place(mv.from, out);
  } else if (w.rise < 1) {
    place(mv.from, out);
    mv.path.at(0, at);
    out.x += (at.x - out.x) * w.rise;
    out.z += (at.z - out.z) * w.rise;
  } else if (w.sit <= 0) {
    mv.path.at(w.along, at);
    out.x = at.x;
    out.z = at.z;
  } else {
    mv.path.at(mv.path.length, at);
    place(mv.to, out);
    out.x = at.x + (out.x - at.x) * w.sit;
    out.z = at.z + (out.z - at.z) * w.sit;
  }
}

/**
 * How near two moves made at once come to keeping apart, the second delay
 * seconds after the first: the least of their distance less KEEP while
 * both move, and less KEEP_STILL while one waits at their place or has
 * come to their new one; at least 0, kept apart.
 */
function nearestOf(plan: CrewPlan, mv: CrewMove, delay: number, other: CrewMove): number {
  const a = { x: 0, z: 0 };
  const b = { x: 0, z: 0 };
  const still = (u: number, m: CrewMove): boolean => u <= 0 || u >= m.duration;
  let least = Number.POSITIVE_INFINITY;
  for (let t = 0; t <= mv.duration + delay; t += 0.1) {
    const ot = t + other.t;
    const sa = still(t - delay, mv);
    const sb = still(ot, other);
    if (sa && sb) {
      continue;
    }
    moveSpot(plan, mv, t - delay, a);
    moveSpot(plan, other, ot, b);
    least = Math.min(least, Math.hypot(a.x - b.x, a.z - b.z) - (sa || sb ? KEEP_STILL : KEEP));
  }
  return least;
}

/**
 * Delays for moves made at once: in whichever order lets them start
 * soonest, each as little as lets it keep KEEP from those before it while
 * either moves; the first goes at once. If no order does, the order and
 * delays that keep them furthest apart.
 */
function keepApart(plan: CrewPlan, moves: CrewMove[]): void {
  const orders: CrewMove[][] = [];
  const permute = (rest: CrewMove[], done: CrewMove[]): void => {
    if (rest.length === 0) {
      orders.push(done);
      return;
    }
    rest.forEach((m, i) => {
      permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...done, m]);
    });
  };
  permute(moves.slice(0, 4), []);
  let best: { delays: number[]; order: CrewMove[]; least: number; wait: number } | null = null;
  for (const order of orders) {
    const delays: number[] = [0];
    let least = Number.POSITIVE_INFINITY;
    if (order[0] !== undefined) {
      order[0].t = 0;
    }
    for (let i = 1; i < order.length; i++) {
      const mv = order[i] as CrewMove;
      let pick = 0;
      let pickLeast = Number.NEGATIVE_INFINITY;
      for (let delay = 0; delay <= KEEP_WAIT + 1e-9; delay += 0.1) {
        let near = Number.POSITIVE_INFINITY;
        for (let k = 0; k < i; k++) {
          near = Math.min(near, nearestOf(plan, mv, delay, order[k] as CrewMove));
        }
        if (near >= 0) {
          pick = delay;
          pickLeast = near;
          break;
        }
        if (near > pickLeast) {
          pickLeast = near;
          pick = delay;
        }
      }
      mv.t = -pick;
      delays.push(pick);
      least = Math.min(least, pickLeast);
    }
    const wait = Math.max(...delays);
    const ok = (x: { least: number }): boolean => x.least >= 0;
    if (
      best === null ||
      (ok({ least }) && (!ok(best) || wait < best.wait)) ||
      (!ok({ least }) && !ok(best) && least > best.least)
    ) {
      best = { delays, order, least, wait };
    }
  }
  if (best !== null) {
    best.order.forEach((m, i) => {
      m.t = -(best.delays[i] as number);
    });
  }
}

/** The boom's nearest approach to a point, m: the boom a segment from its gooseneck out its length at its angle (+ starboard). */
export function boomDistance(
  plan: CrewPlan,
  boom: number,
  x: number,
  y: number,
  z: number,
): number {
  const b = plan.boom;
  const dx = Math.sin(boom);
  const dz = Math.cos(boom);
  const px = x;
  const pz = z - b.z;
  const d = Math.max(0, Math.min(b.length, px * dx + pz * dz));
  return Math.hypot(px - d * dx, y - b.y, pz - d * dz);
}

/** How near the boom may come to a head before its person ducks fully, and from how near they begin to (m). */
export const DUCK_NEAR = 0.6;
export const DUCK_FROM = 0.85;
/** Seconds to duck fully, and to come up again. */
export const DUCK_DOWN = 0.15;
export const DUCK_UP = 0.5;
/** How far ahead the boom's swing is looked at for a duck, seconds. */
export const DUCK_AHEAD = 0.25;

/**
 * How far someone ducks (0 to 1) with their head (as it would be upright)
 * at h: fully once the boom, now (boom, radians) or as it swings on at
 * rate (radians a second) over DUCK_AHEAD, is DUCK_NEAR from it; not at
 * all from DUCK_FROM.
 */
export function duckFor(
  plan: CrewPlan,
  boom: number,
  rate: number,
  h: { x: number; y: number; z: number },
): number {
  const ahead = rate * DUCK_AHEAD;
  let d = Number.POSITIVE_INFINITY;
  for (let k = 0; k <= 2; k++) {
    d = Math.min(d, boomDistance(plan, boom + (ahead * k) / 2, h.x, h.y, h.z));
  }
  return d <= DUCK_NEAR ? 1 : d >= DUCK_FROM ? 0 : (DUCK_FROM - d) / (DUCK_FROM - DUCK_NEAR);
}

/** A duck dt seconds on toward a target: down in DUCK_DOWN, up in DUCK_UP. */
export function duckStep(duck: number, target: number, dt: number): number {
  return target > duck
    ? Math.min(target, duck + dt / DUCK_DOWN)
    : Math.max(target, duck - dt / DUCK_UP);
}

/** The side away from the boom (+1 starboard), held till the boom is SIDE_HYSTERESIS past the centreline; and whether its last change was a tack. */
export class CrewSide {
  side = 0;
  tack = true;
  /** How many times it has changed. */
  changes = 0;

  /** The boom (radians, + starboard) and the wind's angle off the bow (radians): whether the side changed. */
  step(boom: number, windOffBow: number): boolean {
    if (this.side === 0) {
      this.side = boom > 0 ? -1 : 1;
      return false;
    }
    // The boom on the windward side, past the hysteresis: the side changes.
    if (this.side * boom > SIDE_HYSTERESIS) {
      this.side = -this.side;
      const off = Math.abs(Math.atan2(Math.sin(windOffBow), Math.cos(windOffBow)));
      this.tack = off < Math.PI / 2;
      this.changes++;
      return true;
    }
    return false;
  }
}

/** Someone aboard, as the rules hold them. */
export interface CrewMember {
  /** Their seat, look, and where they are: a station's index, or -1 at the helm. */
  seat: number;
  look: number;
  station: number;
  /** The side they sit on, + starboard: their station's mirror to windward, or its own side. */
  side: number;
  /** How far they lean out, 0 (upright) to 1, and which way they are going. */
  lean: number;
  leanTo: number;
  /**
   * What they are doing, if not sitting at their station: crossing the
   * boat or changing places, along a path, from a place to a place, t
   * seconds in (negative while waiting their turn).
   */
  moving: CrewMove | null;
}

/** A place someone is at: a station, or the helm (-1); on a side. */
export interface CrewSpot {
  station: number;
  side: number;
}

/** A move along a path, from a place to a place, t seconds since it began (negative till then). */
export interface CrewMove {
  path: CrewPath;
  from: CrewSpot;
  to: CrewSpot;
  t: number;
  /** Seconds it takes in all: rising, along the path, sitting. */
  duration: number;
  /** A crossing (the boat's side changed) or a change of places. */
  kind: 'cross' | 'change';
  /** Seconds waited, ducked, for the boom to move off the place it goes from. */
  waited: number;
  /** Who goes ahead of them along the same way, whom they keep FOLLOW behind; null for none. */
  after?: CrewMember | null;
}

/** Where along a move someone is, into out: rising (0 to 1), along the path (metres), sitting (0 to 1). */
export function moveAt(
  m: CrewMove,
  out: { rise: number; along: number; sit: number } = { rise: 0, along: 0, sit: 0 },
): { rise: number; along: number; sit: number } {
  const t = Math.max(0, m.t);
  const walk = m.path.length / CROSS_SPEED;
  out.rise = Math.min(1, t / RISE);
  out.along = Math.max(0, Math.min(m.path.length, (t - RISE) * CROSS_SPEED));
  out.sit = Math.max(0, Math.min(1, (t - RISE - walk) / SIT));
  return out;
}

function moveOf(
  path: CrewPath,
  from: CrewSpot,
  to: CrewSpot,
  delay: number,
  kind: CrewMove['kind'],
): CrewMove {
  return {
    path,
    from,
    to,
    t: -delay,
    duration: RISE + path.length / CROSS_SPEED + SIT,
    kind,
    waited: 0,
    after: null,
  };
}

/** What the rules need of the boat each frame. */
export interface CrewMoment {
  dt: number;
  /** The boom's angle, radians, + starboard. */
  boom: number;
  /** The true wind's angle off the bow, radians. */
  windOffBow: number;
  /** How far the helm hikes: 0 sat in, past 1 out on the first hiking depth. */
  depth: number;
}

/** Who is aboard, the skipper (seat 0) first, and the seat of whoever holds the controls. */
export interface CrewAboard {
  people: readonly { seat: number; look: number }[];
  holder: number;
}

/** Where each person aboard is: at the helm (-1) if holding the controls, the skipper at the holder's station, everyone else at their seat's; a seat past the stations nowhere (undefined). */
export function placeOf(crew: CrewAboard, seat: number, stations: number): number | undefined {
  if (seat === crew.holder) {
    return -1;
  }
  const station = seat === 0 ? crew.holder : seat;
  return station > 0 && station < stations ? station : undefined;
}

/** A boat's crew under the rules. */
export class CrewRules {
  readonly side = new CrewSide();
  /** Everyone aboard but whoever holds the controls, once they are at the helm. */
  members: CrewMember[] = [];
  #crew: CrewAboard | null = null;
  /** Whether the helm leans out now, and seconds since that last changed. */
  #out = false;
  #since = Number.POSITIVE_INFINITY;
  /** Each windward station's place in the crossing order, in a tack and in a gybe; and each station's in the leaning order (aft first). */
  readonly #tackRank: number[];
  readonly #gybeRank: number[];
  readonly #leanRank: number[];
  /**
   * Where each station's person is now, by the station their seat gives
   * (placeOf): those round the mast go in file, so each crossing sends the
   * one forward to the place aft and so on; unlisted, their own.
   */
  readonly #moved = new Map<number, number>();

  constructor(readonly plan: CrewPlan) {
    const st = plan.stations;
    const windward = st.map((s, i) => ({ s, i })).filter(({ s }) => s.windward === true);
    const z = ({ s }: { s: BoatStation }): number => s.at[2] as number;
    const cockpit = windward.filter(({ s }) => crossingWay(plan, s) === 'cockpit');
    const mast = windward.filter(({ s }) => crossingWay(plan, s) === 'mast');
    // In a tack, through the cockpit first, forward ones first, then round
    // the mast; in a gybe, round the mast first, then through the cockpit,
    // aft ones first. Round the mast, the forward one leads: in file, nobody
    // passes anybody.
    const byZ = (a: { s: BoatStation }, b: { s: BoatStation }): number => z(a) - z(b);
    const rank = (order: { i: number }[]): number[] => {
      const r = st.map(() => 0);
      order.forEach(({ i }, k) => {
        r[i] = k;
      });
      return r;
    };
    this.#tackRank = rank([...[...cockpit].sort(byZ), ...[...mast].sort(byZ)]);
    this.#gybeRank = rank([...[...mast].sort(byZ), ...[...cockpit].sort(byZ).reverse()]);
    this.#leanRank = st.map(() => 0);
    st.map((s, i) => ({ z: s.at[2] as number, i }))
      .filter(({ i }) => i > 0)
      .sort((a, b) => b.z - a.z)
      .forEach(({ i }, k) => {
        this.#leanRank[i] = k;
      });
  }

  /** How many windward stations cross in turn. */
  get crossers(): number {
    return this.plan.stations.filter((s) => s.windward === true).length;
  }

  /** Whether anyone is walking to or from the helm: the helm is drawn by the crew meanwhile. */
  get helmAway(): boolean {
    return this.members.some(
      (m) =>
        m.moving !== null &&
        m.moving.kind === 'change' &&
        (m.moving.from.station < 0 || m.moving.to.station < 0),
    );
  }

  /** The side a station's person sits on now: to windward its mirror on the windward side, else its own. */
  sideFor(station: number): number {
    const s = this.plan.stations[station];
    if (s === undefined || station <= 0) {
      return this.side.side || 1;
    }
    return s.windward === true ? this.side.side || 1 : sideOf(s);
  }

  /**
   * Who is aboard: those already aboard keep their places; when the
   * controls change hands, those whose places change walk to them.
   * walks: false to put everyone in place at once (a boat first met).
   */
  set(crew: CrewAboard | null, walks = true): void {
    const old = this.#crew;
    this.#crew = crew;
    const stations = this.plan.stations.length;
    if (crew === null) {
      this.members = [];
      return;
    }
    const same =
      old !== null &&
      old.people.length === crew.people.length &&
      old.people.every(
        (p, i) => p.seat === crew.people[i]?.seat && p.look === crew.people[i]?.look,
      );
    const handed = walks && same && old !== null && old.holder !== crew.holder;
    const before = new Map(this.members.map((m) => [m.seat, m]));
    const members: CrewMember[] = [];
    const walking: { m: CrewMember; from: CrewSpot; to: CrewSpot }[] = [];
    const moved = (station: number | undefined): number | undefined =>
      station === undefined || station < 0 ? station : (this.#moved.get(station) ?? station);
    for (const p of crew.people) {
      const now = moved(placeOf(crew, p.seat, stations));
      if (now === undefined) {
        continue;
      }
      const was = before.get(p.seat);
      const then = old === null ? undefined : moved(placeOf(old, p.seat, stations));
      const side = this.sideFor(now);
      const m: CrewMember = was ?? {
        seat: p.seat,
        look: p.look,
        station: now,
        side,
        lean: this.#out ? 1 : 0,
        leanTo: this.#out ? 1 : 0,
        moving: null,
      };
      m.look = p.look;
      if (handed && then !== undefined && then !== now) {
        // Walks from where they were to their new place, on the windward side.
        const from: CrewSpot = { station: then, side: m.side };
        const to: CrewSpot = { station: now, side };
        walking.push({ m, from, to });
      } else if (m.station !== now) {
        // Put there at once: someone come aboard, or a crew told afresh.
        m.moving = null;
        m.side = side;
      }
      m.station = now;
      members.push(m);
    }
    this.members = members;
    if (walking.length > 0) {
      // Each by the way for where they walk, past those who sit where they
      // stay, as soon as each can keep apart from the others.
      walking.sort(
        (a, b) =>
          this.#spotZ(b.to.station) -
          this.#spotZ(b.from.station) -
          (this.#spotZ(a.to.station) - this.#spotZ(a.from.station)),
      );
      // Beside the cockpit with nobody sat between: whoever walks to the
      // helm along the side deck, the other on the cockpit's floor. To or
      // from a place forward of it, both along the side deck, the one going
      // forward inboard of the other.
      const c = this.plan.cockpit;
      const sat = members
        .filter((m) => m.moving === null && m.station > 0)
        .map((m) => this.#spotZ(m.station));
      let floor = false;
      const moves = walking.map(({ m, from, to }) => {
        const z0 = this.#spotZ(from.station);
        const z1 = this.#spotZ(to.station);
        const zf = Math.min(z0, z1);
        const za = Math.max(z0, z1);
        const beside = c !== null && zf >= c.fore && !sat.some((z) => z > zf && z < za);
        // Coming forward to the helm, they stop short of it and sit forward into it.
        const path =
          beside && to.station < 0
            ? walkPath(this.plan, to.side, z0, z1 < z0 ? z1 + APPROACH : z1, 0)
            : changePath(this.plan, to.side, z0, z1, z1 < z0 ? -PASS : PASS);
        floor ||= beside;
        const mv = moveOf(path, from, to, 0, 'change');
        m.moving = mv;
        return mv;
      });
      // Those changing places beside the cockpit go in turn to keep apart;
      // along the side deck, at once, passing.
      if (floor) {
        keepApart(this.plan, moves);
      }
    }
  }

  /** The z of a place's walk on the side deck: a station's, or the helm's (station 0's). */
  #spotZ(station: number): number {
    const s = this.plan.stations[Math.max(0, station)];
    return (s?.at[2] as number | undefined) ?? 0;
  }

  /** A frame: the side by the boom, the crossings, the leaning, the walks. */
  step(m: CrewMoment): void {
    const dt = Math.max(0, m.dt);
    const first = this.side.side === 0;
    const changed = this.side.step(m.boom, m.windOffBow);
    const side = this.side.side || 1;
    const stations = this.plan.stations;
    if (first) {
      // The side first known: everyone is on it already.
      for (const p of this.members) {
        if (p.moving === null) {
          p.side = this.sideFor(p.station);
        }
      }
    }
    // Leaning out or sitting up with the helm, with a hysteresis.
    const out = this.#out ? m.depth > LEAN_IN : m.depth > LEAN_OUT;
    if (out !== this.#out) {
      this.#out = out;
      this.#since = 0;
    } else {
      this.#since += dt;
    }
    // Moving: on along the path; there, at the new place. A crossing takes
    // its way when it begins, by the boom then, and waits while the boom is
    // over the place it goes from (for WAIT_MOST at most); one in file keeps
    // FOLLOW behind the one ahead.
    for (const p of this.members) {
      const mv = p.moving;
      if (mv === null) {
        continue;
      }
      const was = mv.t;
      mv.t += dt;
      const lead = mv.after?.moving ?? null;
      if (lead !== null && lead.kind === mv.kind) {
        mv.t = Math.min(mv.t, lead.t - FOLLOW / CROSS_SPEED);
      }
      const from = stations[mv.from.station];
      const to = stations[mv.to.station];
      if (mv.kind === 'cross' && from !== undefined && to !== undefined && was < 0 && mv.t >= 0) {
        if (
          crossingWay(this.plan, from) === 'mast' &&
          mv.waited < WAIT_MOST &&
          boomOver(this.plan, from, mv.from.side, m.boom)
        ) {
          mv.waited += dt;
          mv.t = was;
        } else {
          mv.path = crossPath(this.plan, from, mv.from.side, m.boom, to);
          mv.duration = RISE + mv.path.length / CROSS_SPEED + SIT;
        }
      }
      if (mv.t >= mv.duration) {
        p.side = mv.to.side;
        p.moving = null;
      }
    }
    for (const p of this.members) {
      // At the helm: on the helm's side, the windward one, for a walk from it.
      if (p.station < 0 && p.moving === null) {
        p.side = side;
      }
    }
    // The side changed: those to windward cross, in turn; those round the
    // mast in file, the one forward leading, to the places in the same
    // order from aft, so that nobody passes anybody.
    const crossing = this.members.filter(
      (p) =>
        stations[p.station]?.windward === true &&
        p.station > 0 &&
        p.moving === null &&
        p.side !== side,
    );
    if (crossing.length > 0) {
      const z = (p: CrewMember): number => stations[p.station]?.at[2] as number;
      const file = crossing
        .filter((p) => crossingWay(this.plan, stations[p.station] as BoatStation) === 'mast')
        .sort((a, b) => z(a) - z(b));
      const places = file.map((p) => p.station).reverse();
      const rank = this.side.tack ? this.#tackRank : this.#gybeRank;
      const ranked = [...crossing].sort((a, b) => (rank[a.station] ?? 0) - (rank[b.station] ?? 0));
      for (const p of crossing) {
        const order = ranked.indexOf(p);
        const k = file.indexOf(p);
        const dest = k < 0 ? p.station : (places[k] as number);
        const from = stations[p.station] as BoatStation;
        const mv = moveOf(
          crossPath(this.plan, from, p.side, m.boom, stations[dest] as BoatStation),
          { station: p.station, side: p.side },
          { station: dest, side },
          changed ? order * CROSS_GAP : 0,
          'cross',
        );
        mv.after = k > 0 ? (file[k - 1] as CrewMember) : null;
        p.moving = mv;
      }
      // Each now at the place they go to, as the crew is told afresh.
      const n = stations.length;
      for (const [k, p] of file.entries()) {
        const home = this.#crew === null ? undefined : placeOf(this.#crew, p.seat, n);
        if (home !== undefined && home >= 0) {
          this.#moved.set(home, places[k] as number);
        }
        p.station = places[k] as number;
      }
    }
    for (const p of this.members) {
      // Leaning: each in their turn after the helm, aft first.
      const turn = (this.#leanRank[p.station] ?? 0) * LEAN_STAGGER;
      if (this.#since >= turn) {
        p.leanTo = out ? 1 : 0;
      }
      const step = dt / LEAN_TIME;
      p.lean =
        p.leanTo > p.lean ? Math.min(p.leanTo, p.lean + step) : Math.max(p.leanTo, p.lean - step);
    }
  }
}
