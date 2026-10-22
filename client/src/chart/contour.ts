// SPDX-License-Identifier: AGPL-3.0-only

// Contours over a grid of the disk, as the chart draws its isobars and the
// edge of very poor visibility: marching squares, each level's pieces
// joined end to end into lines, so a line is drawn and lettered whole; and
// a grid's highs and lows, each a point higher or lower than every point
// about it. A cell with a corner beyond the lip is left out, so a line ends
// where the grid does.

/** A point east and north of the centre, m. */
export type Where = [number, number];

/**
 * A square grid over the disk: side points a side, step m apart, row by row
 * from the north-west, east along a row; null beyond the lip.
 */
export interface Grid {
  side: number;
  step: number;
  values: ArrayLike<number | null>;
}

/** A high or a low: where, and its value. */
export interface Centre {
  east: number;
  north: number;
  value: number;
  high: boolean;
}

/** Where a grid point is, i east and j south of the north-west corner. */
export function gridPoint(g: Grid, i: number, j: number): Where {
  const half = ((g.side - 1) / 2) * g.step;
  return [-half + i * g.step, half - j * g.step];
}

function valueAt(g: Grid, i: number, j: number): number | null {
  if (i < 0 || j < 0 || i >= g.side || j >= g.side) {
    return null;
  }
  const v = g.values[j * g.side + i];
  return v === undefined || v === null || Number.isNaN(v) ? null : v;
}

/** A level's lines over the grid. */
export function contour(g: Grid, level: number): Where[][] {
  // Where the level crosses an edge between two grid points, by the edge's
  // name: h i,j runs east from point (i, j), v i,j south from it.
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
  ) => {
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
        // A saddle: the cell's mean says which corners the level cuts off.
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

/** The grid's levels every so many, lowest first, each with its lines. */
export function levels(g: Grid, every: number): { value: number; lines: Where[][] }[] {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < g.values.length; k++) {
    const v = g.values[k];
    if (v !== undefined && v !== null && !Number.isNaN(v)) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  const out: { value: number; lines: Where[][] }[] = [];
  for (let k = Math.ceil(lo / every); k <= Math.floor(hi / every); k++) {
    const lines = contour(g, k * every);
    if (lines.length > 0) {
      out.push({ value: k * every, lines });
    }
  }
  return out;
}

/**
 * The grid's highs and lows: each point higher, or lower, than every other
 * within reach points of it, all within the lip, and by flat at the least.
 */
export function centres(g: Grid, reach = 3, flat = 0.3): Centre[] {
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
        out.push({ east, north, value: v, high });
      }
    }
  }
  return out;
}
