// SPDX-License-Identifier: AGPL-3.0-only

// A cruising catamaran's people's walks at a handover, along her ways (her
// model's `ways` node, bridgedeck.ts): the ship's way graph walked without
// her yards, braces or tops. A walk is a path over her floors; where it
// climbs her helm's ladder, that stretch is played by the ladder's clips
// (up from its foot, down from its head) over BRIDGE_LADDER_TIME, not
// walked. Where two may pass (her ways' `wide` points), each keeps
// PASS_RIGHT to the right of the way; a stretch past someone sat (where
// they would stand up) costs PAST_SAT times its length, so a walk keeps
// off it where it can.

import type { Vector3 } from 'three';
import {
  BRIDGE_EDGE_SPEED,
  BRIDGE_LADDER_TIME,
  BRIDGE_PIVOT_TIME,
  type BridgeBoat,
  type BridgeCrew,
  type BridgeStretch,
  STANCE_SHORT,
} from './bridgedeck';
import { CrewPath } from './crewrules';
import { deckPath, ShipWayGraph } from './shiprules';

/** A path's points this far apart at most up her ladder, m. */
const STEP = 0.05;
/** How far to the right of the way two who may pass keep, m. */
export const PASS_RIGHT = 0.22;
/** How much dearer a metre is past someone sat; and how near the way they are, m. */
const PAST_SAT = 6;
const SAT_NEAR = 0.3;

/** A walk on from a stretch not walked, or onto one, shorter than this is not walked, m. */
const MIN_WALK = 0.35;

/** How long points are from the first to the kth, in plan. */
function lengthTo(points: readonly [number, number, number][], k: number): number {
  let l = 0;
  for (let i = 1; i <= k; i++) {
    const a = points[i - 1] as [number, number, number];
    const b = points[i] as [number, number, number];
    l += Math.hypot(b[0] - a[0], b[2] - a[2]);
  }
  return l;
}

/** How long points are from the kth to the last, in plan. */
function lengthFrom(points: readonly [number, number, number][], k: number): number {
  return lengthTo(points, points.length - 1) - lengthTo(points, k);
}

/** How near a point comes to the segment a–b, in plan. */
function toSegment(p: Vector3, a: Vector3, b: Vector3): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  const f = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
  return Math.hypot(a.x + dx * f - p.x, a.z + dz * f - p.z);
}

/** Her people's walks, from her deck; null if her model has no ways. */
export function bridgeCrew(boat: BridgeBoat | null): BridgeCrew | null {
  if (boat === null || boat.ways === null) {
    return null;
  }
  const ways = boat.ways;
  const graph = new ShipWayGraph(ways);
  const wide = new Set(ways.wide);
  const narrow = new Set(ways.narrow);
  /** An edge two may pass on: both its points wide. */
  const passes = (e: number): boolean => {
    const edge = ways.edges[e];
    return edge !== undefined && wide.has(edge[0]) && wide.has(edge[1]);
  };
  return {
    boat,
    walk(
      from: Vector3,
      to: Vector3,
      sat: readonly Vector3[] = [],
    ): { path: CrewPath; stretches: BridgeStretch[] } {
      const near = sat.filter(
        (p) =>
          Math.hypot(p.x - from.x, p.z - from.z) > 0.05 &&
          Math.hypot(p.x - to.x, p.z - to.z) > 0.05,
      );
      const route = graph.route(from, to, (_e, _f, a, b) =>
        near.some((p) => Math.abs(p.y - a.y) < 0.6 && toSegment(p, a, b) < SAT_NEAR) ? PAST_SAT : 1,
      );
      // Each point on a way two may pass (in or out of it), to the right of it.
      for (let i = 1; i + 1 < route.length; i++) {
        const r = route[i] as { at: Vector3; edge: number; kind: number };
        const next = route[i + 1] as { at: Vector3; edge: number; kind: number };
        if (r.kind !== 0 || next.kind !== 0 || !(passes(r.edge) || passes(next.edge))) {
          continue;
        }
        const a = (route[i - 1] as { at: Vector3 }).at;
        const dx = next.at.x - a.x;
        const dz = next.at.z - a.z;
        const l = Math.hypot(dx, dz);
        if (l > 1e-6) {
          // Heading (dx, dz), the right is (−dz, dx).
          r.at = r.at.clone();
          r.at.x += (-dz / l) * PASS_RIGHT;
          r.at.z += (dx / l) * PASS_RIGHT;
        }
      }
      // The walked stretches, each a path of its own (its corners rounded);
      // her ladder, and the gaps edged along, straight.
      const points: [number, number, number][] = [];
      const marks: { a: number; b: number; kind: BridgeStretch['kind']; yaw: number }[] = [];
      let piece: Vector3[] = [];
      const push = (q: [number, number, number]): void => {
        const last = points.at(-1);
        if (last === undefined || Math.hypot(last[0] - q[0], last[2] - q[2]) > 1e-4) {
          points.push(q);
        }
      };
      const flush = (): void => {
        if (piece.length >= 2) {
          const p = deckPath(piece);
          for (let i = 0; i < p.x.length; i++) {
            push([p.x[i] as number, p.y[i] as number, p.z[i] as number]);
          }
        } else if (piece.length === 1) {
          const q = piece[0] as Vector3;
          push([q.x, q.y, q.z]);
        }
        piece = [];
      };
      const straight = (a: Vector3, b: Vector3): void => {
        const l = Math.hypot(b.x - a.x, b.z - a.z);
        const k = Math.max(1, Math.ceil(l / STEP));
        for (let j = 1; j <= k; j++) {
          push([
            a.x + ((b.x - a.x) * j) / k,
            a.y + ((b.y - a.y) * j) / k,
            a.z + ((b.z - a.z) * j) / k,
          ]);
        }
      };
      const table = boat.table;
      for (let i = 0; i < route.length; i++) {
        const r = route[i] as { at: Vector3; kind: number; edge: number };
        const a = i > 0 ? (route[i - 1] as { at: Vector3 }).at : null;
        const edged = a !== null && r.kind === 0 && narrow.has(r.edge);
        if (a !== null && (r.kind !== 0 || edged)) {
          if (piece.length === 0) {
            piece.push(a);
          }
          flush();
          push([a.x, a.y, a.z]);
          const start = points.length - 1;
          straight(a, r.at);
          if (Math.hypot(r.at.x - a.x, r.at.z - a.z) > 1e-3) {
            // Edged along facing the table (across the gap, toward its
            // middle), or as her ways say.
            const dx = r.at.x - a.x;
            const dz = r.at.z - a.z;
            let yaw = Math.atan2(-dz, dx);
            const faces = ways.facing.get(r.edge);
            const ends = ways.edges[r.edge];
            if (faces !== undefined && ends !== undefined) {
              const second = ways.nodes[ends[1]] as Vector3;
              const toSecond =
                Math.hypot(second.x - r.at.x, second.z - r.at.z) <
                Math.hypot(second.x - a.x, second.z - a.z);
              yaw = Math.PI - ((toSecond ? faces[0] : faces[1]) * Math.PI) / 180;
            } else if (table !== null) {
              const cx = (table.x0 + table.x1) / 2 - a.x;
              const cz = (table.z0 + table.z1) / 2 - a.z;
              if (-dz * cx + dx * cz < 0) {
                yaw = Math.atan2(dz, -dx);
              }
            }
            marks.push({
              a: start,
              b: points.length - 1,
              kind: edged ? 'edge' : r.at.y > a.y ? 'up' : 'down',
              yaw,
            });
          }
          piece = [r.at];
          continue;
        }
        const last = piece.at(-1);
        if (last === undefined || Math.hypot(last.x - r.at.x, last.z - r.at.z) > 0.01) {
          piece.push(r.at);
        }
      }
      flush();
      if (points.length === 1) {
        const q = points[0] as [number, number, number];
        points.push([q[0], q[1], q[2] + 1e-4]);
      }
      // A step on from a gap edged along or her ladder, or onto one, too
      // short to walk: taken getting up or sitting down.
      const first = marks[0];
      if (first !== undefined && first.a > 0 && lengthTo(points, first.a) < MIN_WALK) {
        points.splice(0, first.a);
        const k = first.a;
        for (const m of marks) {
          m.a -= k;
          m.b -= k;
        }
      }
      const last = marks.at(-1);
      if (
        last !== undefined &&
        last.b < points.length - 1 &&
        lengthFrom(points, last.b) < MIN_WALK
      ) {
        points.splice(last.b + 1);
      }
      // Short of her helm's stance at either end.
      const stance = boat.places.stance.at;
      for (const end of [0, 1]) {
        const q = end === 0 ? from : to;
        if (Math.hypot(q.x - stance.x, q.z - stance.z) > 0.05 || points.length < 3) {
          continue;
        }
        let cut = 0;
        while (points.length > 2 && cut < STANCE_SHORT) {
          const a = (end === 0 ? points[0] : points.at(-1)) as [number, number, number];
          const b = (end === 0 ? points[1] : points.at(-2)) as [number, number, number];
          cut += Math.hypot(a[0] - b[0], a[2] - b[2]);
          if (end === 0) {
            points.shift();
            for (const m of marks) {
              m.a--;
              m.b--;
            }
          } else {
            points.pop();
          }
        }
      }
      const path = new CrewPath(points);
      // Edged stretches next to each other, one.
      const stretches: BridgeStretch[] = [];
      for (const m of marks) {
        const s0 = path.s[m.a] as number;
        const s1 = path.s[m.b] as number;
        const last = stretches.at(-1);
        if (
          m.kind === 'edge' &&
          last?.kind === 'edge' &&
          Math.abs(last.s1 - s0) < 1e-3 &&
          Math.abs(last.yaw - m.yaw) < 1e-3
        ) {
          last.s1 = s1;
          last.time = (last.s1 - last.s0) / BRIDGE_EDGE_SPEED;
          continue;
        }
        stretches.push({
          s0,
          s1,
          kind: m.kind,
          yaw: m.yaw,
          time:
            m.kind === 'edge'
              ? (s1 - s0) / BRIDGE_EDGE_SPEED
              : BRIDGE_LADDER_TIME + BRIDGE_PIVOT_TIME,
        });
      }
      return { path, stretches };
    },
  };
}
