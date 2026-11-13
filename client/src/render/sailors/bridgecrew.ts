// SPDX-License-Identifier: AGPL-3.0-only

// A cruising catamaran's people's walks at a handover, along her ways (her
// model's `ways` node, bridgedeck.ts): the ship's way graph walked without
// her yards, braces or tops. A walk is a path over her floors; where it
// climbs her helm's ladder, that stretch is played by the ladder's clips
// (up from its foot, down from its head) over BRIDGE_LADDER_TIME, not
// walked.

import type { Vector3 } from 'three';
import {
  BRIDGE_LADDER_TIME,
  type BridgeBoat,
  type BridgeCrew,
  type BridgeLadder,
} from './bridgedeck';
import { CrewPath } from './crewrules';
import { deckPath, ShipWayGraph } from './shiprules';

/** A path's points this far apart at most up her ladder, m. */
const STEP = 0.05;

/** Her people's walks, from her deck; null if her model has no ways. */
export function bridgeCrew(boat: BridgeBoat | null): BridgeCrew | null {
  if (boat === null || boat.ways === null) {
    return null;
  }
  const graph = new ShipWayGraph(boat.ways);
  return {
    boat,
    walk(from: Vector3, to: Vector3): { path: CrewPath; ladder: BridgeLadder | null } {
      const route = graph.route(from, to, () => 1);
      // The walked stretches, each a path of its own (its corners rounded),
      // and the ladder between them straight.
      const points: [number, number, number][] = [];
      let piece: Vector3[] = [];
      let ladder: { a: number; b: number; up: boolean } | null = null;
      const flush = (): void => {
        if (piece.length >= 2) {
          const p = deckPath(piece);
          for (let i = 0; i < p.x.length; i++) {
            const q: [number, number, number] = [
              p.x[i] as number,
              p.y[i] as number,
              p.z[i] as number,
            ];
            const last = points.at(-1);
            if (last === undefined || Math.hypot(last[0] - q[0], last[2] - q[2]) > 1e-4) {
              points.push(q);
            }
          }
        } else if (piece.length === 1) {
          const q = piece[0] as Vector3;
          points.push([q.x, q.y, q.z]);
        }
        piece = [];
      };
      for (let i = 0; i < route.length; i++) {
        const r = route[i] as { at: Vector3; kind: number };
        if (i > 0 && r.kind !== 0) {
          const a = (route[i - 1] as { at: Vector3 }).at;
          if (piece.length === 0) {
            piece.push(a);
          }
          flush();
          // Up or down her ladder, straight from its foot to its head.
          const start = points.length - 1;
          const l = Math.hypot(r.at.x - a.x, r.at.z - a.z);
          const k = Math.max(1, Math.ceil(l / STEP));
          for (let j = 1; j <= k; j++) {
            points.push([
              a.x + ((r.at.x - a.x) * j) / k,
              a.y + ((r.at.y - a.y) * j) / k,
              a.z + ((r.at.z - a.z) * j) / k,
            ]);
          }
          ladder = { a: start, b: points.length - 1, up: r.at.y > a.y };
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
      const path = new CrewPath(points);
      return {
        path,
        ladder:
          ladder === null
            ? null
            : {
                s0: path.s[ladder.a] as number,
                s1: path.s[ladder.b] as number,
                up: ladder.up,
                time: BRIDGE_LADDER_TIME,
              },
      };
    },
  };
}
