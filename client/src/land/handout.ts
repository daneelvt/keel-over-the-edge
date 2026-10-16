// SPDX-License-Identifier: AGPL-3.0-only

// The server's rule for which chunks a boat could see something in
// (internal/edge/chunks.go), for the sandbox, which has no server to hand
// them: a chunk whose outline is within near of the boat; or one with a
// cell of land H high within the dome's sight of it from the highest the
// camera goes, √(2 R h) + √(2 R H), plus the margin; or a cell of sea bed
// shallower than shallows within the far sea's reach from there, plus the
// margin. Cells are the shelter's, 8 by 8 hexagons.

import type { WorldHandout } from '../catalog/types.gen';
import { GROUND } from '../predict/layout.gen';
import { cellHex, chunkCorner, hexCentre } from '../workers/mesh/build';

const SHELTER_CELL = 8;
const SHELTER_COLUMNS = GROUND.chunkColumns / SHELTER_CELL;
const SHELTER_ROWS = GROUND.chunkRows / SHELTER_CELL;
const HEX_RADIUS = 4 / Math.sqrt(3);
const HEX_STEP = 1.5 * HEX_RADIUS;
const COLUMN_ZERO = (GROUND.chunkSide * GROUND.chunkColumns) / 2;
const ROW_ZERO = (GROUND.chunkSide * GROUND.chunkRows) / 2;

/** What the rule knows of a chunk: its outline, the furthest it is seen from, and its cells seen from afar. */
interface Seen {
  minE: number;
  maxE: number;
  minN: number;
  maxN: number;
  reach: number;
  /** Each cell's centre and the square of its reach, three numbers a cell. */
  cells: Float64Array;
}

export class Handout {
  readonly #near: number;
  readonly #chunks = new Map<number, Seen>();

  /** The rule's numbers, and each chunk's elevations by number (null for none). */
  constructor(rule: WorldHandout, elevations: ReadonlyMap<number, Int16Array | null>) {
    this.#near = rule.near;
    const sight = Math.sqrt(2 * rule.dome * rule.camera);
    const shallows =
      Math.max(rule.farSeaLeast, rule.farSeaHorizon * Math.sqrt(2 * rule.dome * rule.camera)) +
      rule.margin;
    const shallow = Math.floor(rule.shallows * 10 + 0.5);
    for (let n = 0; n < GROUND.chunkSide * GROUND.chunkSide; n++) {
      const [c0, j0] = chunkCorner(n);
      const [qa, ra] = cellHex(c0, j0);
      const [qb, rb] = cellHex(c0 + 1, j0);
      const [qc, rc] = cellHex(c0, j0 + GROUND.chunkRows - 1);
      const [qd, rd] = cellHex(c0 + 1, j0 + GROUND.chunkRows - 1);
      const [qe, re] = cellHex(c0 + GROUND.chunkColumns - 1, j0);
      const [x0, ya] = hexCentre(qa, ra);
      const [, yb] = hexCentre(qb, rb);
      const [, yc] = hexCentre(qc, rc);
      const [, yd] = hexCentre(qd, rd);
      const [x1] = hexCentre(qe, re);
      const cells: number[] = [];
      let reach = 0;
      const e = elevations.get(n);
      if (e !== undefined && e !== null) {
        const high = new Int16Array(SHELTER_COLUMNS * SHELTER_ROWS);
        const low = new Int16Array(SHELTER_COLUMNS * SHELTER_ROWS).fill(0x7fff);
        for (let i = 0; i < GROUND.chunkHexes; i++) {
          const c = Math.floor(i / GROUND.chunkRows);
          const j = i % GROUND.chunkRows;
          const k = Math.floor(c / SHELTER_CELL) * SHELTER_ROWS + Math.floor(j / SHELTER_CELL);
          const v = e[i] ?? 0;
          high[k] = Math.max(high[k] ?? 0, v);
          if (v <= 0) {
            low[k] = Math.min(low[k] ?? 0x7fff, -v);
          }
        }
        for (let k = 0; k < high.length; k++) {
          let r = -1;
          const h = high[k] ?? 0;
          if (h > 0) {
            r = sight + Math.sqrt(2 * rule.dome * h * 0.1) + rule.margin;
          }
          if ((low[k] ?? 0x7fff) < shallow) {
            r = Math.max(r, shallows);
          }
          if (r < 0) {
            continue;
          }
          const a = c0 / SHELTER_CELL + Math.floor(k / SHELTER_ROWS);
          const b = j0 / SHELTER_CELL + (k % SHELTER_ROWS);
          // The cell's centre, as the physics lays it (ShelterCellCentre).
          const u = a * SHELTER_CELL + (SHELTER_CELL - 1) / 2 - COLUMN_ZERO;
          const v = b * SHELTER_CELL + (SHELTER_CELL - 1) / 2 - ROW_ZERO;
          cells.push(u * HEX_STEP, v * 4 + 1, r * r);
          reach = Math.max(reach, r);
        }
      }
      this.#chunks.set(n, {
        minE: x0 - HEX_RADIUS,
        maxE: x1 + HEX_RADIUS,
        minN: Math.min(ya, yb) - 2,
        maxN: Math.max(yc, yd) + 2,
        reach,
        cells: Float64Array.from(cells),
      });
    }
  }

  /** Whether a boat at (east, north) could see something in chunk n. */
  sees(n: number, east: number, north: number): boolean {
    const c = this.#chunks.get(n);
    if (c === undefined) {
      return false;
    }
    const d = Math.hypot(
      Math.max(c.minE - east, 0, east - c.maxE),
      Math.max(c.minN - north, 0, north - c.maxN),
    );
    if (d <= this.#near) {
      return true;
    }
    if (d > c.reach) {
      return false;
    }
    for (let i = 0; i < c.cells.length; i += 3) {
      const dx = (c.cells[i] ?? 0) - east;
      const dy = (c.cells[i + 1] ?? 0) - north;
      if (dx * dx + dy * dy <= (c.cells[i + 2] ?? 0)) {
        return true;
      }
    }
    return false;
  }

  /** The chunks a boat at (east, north) could see something in, nearest first by number. */
  seen(east: number, north: number): number[] {
    const out: number[] = [];
    for (const n of this.#chunks.keys()) {
      if (this.sees(n, east, north)) {
        out.push(n);
      }
    }
    return out;
  }
}
