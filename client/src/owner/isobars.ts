// SPDX-License-Identifier: AGPL-3.0-only

// The isobars over the disk: the pressure grid contoured by marching
// squares, a level every so many hPa, each level's pieces joined end to
// end into lines, so that a line is drawn and labelled whole; and the
// grid's highs and lows, each a point higher or lower than every point
// about it. A cell with a corner beyond the lip is left out, so a line
// ends where the grid does.

import type { PressureGrid } from './api';

/** A point east and north of the centre, m. */
export type Where = [number, number];

/** A level's lines, each open or, closed, ending where it began. */
export interface Isobar {
  hPa: number;
  lines: Where[][];
}

/** A high or a low: where, and its pressure. */
export interface Centre {
  east: number;
  north: number;
  hPa: number;
  high: boolean;
}

/** Where a grid point is, i east and j south of the north-west corner. */
export function gridPoint(g: PressureGrid, i: number, j: number): Where {
  const half = ((g.side - 1) / 2) * g.step;
  return [-half + i * g.step, half - j * g.step];
}

/** The pressure at a grid point; null beyond the lip or off the grid. */
function valueAt(g: PressureGrid, i: number, j: number): number | null {
  if (i < 0 || j < 0 || i >= g.side || j >= g.side) {
    return null;
  }
  return g.values[j * g.side + i] ?? null;
}

/** One level's lines. */
function contour(g: PressureGrid, level: number): Where[][] {
  // Where the level crosses an edge between two grid points, by the edge's
  // name: h i,j runs east from point (i, j), v i,j south from it. A
  // piece crosses its cell from one edge to another; two cells share an
  // edge, and their pieces meet there.
  const points = new Map<string, Where>();
  const pieces: [string, string][] = [];
  const atEdge = new Map<string, number[]>();
  const cross = (
    edge: string,
    i0: number,
    j0: number,
    v0: number,
    i1: number,
    j1: number,
    v1: number,
  ): string => {
    if (!points.has(edge)) {
      const t = (level - v0) / (v1 - v0);
      const [e0, n0] = gridPoint(g, i0, j0);
      const [e1, n1] = gridPoint(g, i1, j1);
      points.set(edge, [e0 + t * (e1 - e0), n0 + t * (n1 - n0)]);
    }
    return edge;
  };
  const piece = (from: string, to: string): void => {
    const n = pieces.length;
    pieces.push([from, to]);
    for (const edge of [from, to]) {
      const list = atEdge.get(edge);
      if (list === undefined) {
        atEdge.set(edge, [n]);
      } else {
        list.push(n);
      }
    }
  };
  for (let j = 0; j + 1 < g.side; j++) {
    for (let i = 0; i + 1 < g.side; i++) {
      const nw = valueAt(g, i, j);
      const ne = valueAt(g, i + 1, j);
      const se = valueAt(g, i + 1, j + 1);
      const sw = valueAt(g, i, j + 1);
      if (nw === null || ne === null || se === null || sw === null) {
        continue;
      }
      const up = [nw >= level, ne >= level, se >= level, sw >= level];
      const top = up[0] !== up[1] ? cross(`h${i},${j}`, i, j, nw, i + 1, j, ne) : null;
      const right =
        up[1] !== up[2] ? cross(`v${i + 1},${j}`, i + 1, j, ne, i + 1, j + 1, se) : null;
      const bottom =
        up[3] !== up[2] ? cross(`h${i},${j + 1}`, i, j + 1, sw, i + 1, j + 1, se) : null;
      const left = up[0] !== up[3] ? cross(`v${i},${j}`, i, j, nw, i, j + 1, sw) : null;
      if (top !== null && right !== null && bottom !== null && left !== null) {
        // A saddle: the cell's mean says which corners the level cuts off,
        // the two on the other side of it from the middle.
        const middle = (nw + ne + se + sw) / 4 >= level;
        if (up[0] !== middle) {
          piece(left, top);
          piece(right, bottom);
        } else {
          piece(top, right);
          piece(bottom, left);
        }
        continue;
      }
      const crossed = [top, right, bottom, left].filter((e): e is string => e !== null);
      if (crossed.length === 2) {
        piece(crossed[0] as string, crossed[1] as string);
      }
    }
  }

  // The pieces joined: from each not yet taken, onward from its end and
  // back from its beginning, through the piece sharing each edge.
  const taken = pieces.map(() => false);
  const onward = (edge: string): number | undefined => atEdge.get(edge)?.find((n) => !taken[n]);
  const lines: Where[][] = [];
  pieces.forEach(([from, to], first) => {
    if (taken[first]) {
      return;
    }
    taken[first] = true;
    const edges = [from, to];
    for (const forward of [true, false]) {
      let end = forward ? to : from;
      for (;;) {
        const n = onward(end);
        if (n === undefined) {
          break;
        }
        taken[n] = true;
        const [a, b] = pieces[n] as [string, string];
        end = a === end ? b : a;
        if (forward) {
          edges.push(end);
        } else {
          edges.unshift(end);
        }
      }
    }
    lines.push(
      edges.flatMap((e) => {
        const p = points.get(e);
        return p === undefined ? [] : [p];
      }),
    );
  });
  return lines;
}

/** The grid's isobars, a level every so many hPa, lowest first. */
export function isobars(g: PressureGrid, every = 2): Isobar[] {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const v of g.values) {
    if (v !== null) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  const out: Isobar[] = [];
  for (let k = Math.ceil(lo / every); k <= Math.floor(hi / every); k++) {
    const lines = contour(g, k * every);
    if (lines.length > 0) {
      out.push({ hPa: k * every, lines });
    }
  }
  return out;
}

/**
 * The grid's highs and lows: each point higher, or lower, than every other
 * within reach points of it, all of them within the lip, and by flat hPa
 * at the least, so that the rounding of a level field marks nothing.
 */
export function centres(g: PressureGrid, reach = 2, flat = 0.1): Centre[] {
  const out: Centre[] = [];
  for (let j = 0; j < g.side; j++) {
    for (let i = 0; i < g.side; i++) {
      const v = valueAt(g, i, j);
      if (v === null) {
        continue;
      }
      let high = true;
      let low = true;
      let most = 0;
      for (let dj = -reach; dj <= reach && (high || low); dj++) {
        for (let di = -reach; di <= reach; di++) {
          if (di === 0 && dj === 0) {
            continue;
          }
          const w = valueAt(g, i + di, j + dj);
          if (w === null) {
            high = false;
            low = false;
            break;
          }
          high &&= w < v;
          low &&= w > v;
          most = Math.max(most, Math.abs(w - v));
        }
      }
      if ((high || low) && most >= flat) {
        const [east, north] = gridPoint(g, i, j);
        out.push({ east, north, hPa: v, high });
      }
    }
  }
  return out;
}
