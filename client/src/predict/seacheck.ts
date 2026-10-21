// SPDX-License-Identifier: AGPL-3.0-only

// Checks the sea in the physics module against the server's: the waves, and
// for each sea of internal/physics/testdata/sea.json the surface at its
// points and the sea under its hulls, which Go wrote and the module must
// give bit for bit. The tests run it under Node; the developer page runs it
// on a phone.

import { type ScenarioSea, toHex } from './golden';
import { ARRAYS, RECORDS } from './layout.gen';
import type { Physics } from './physics';

/** One sea of the file: where and when, and what Go computed there. */
export interface SeaCase {
  name: string;
  sea: ScenarioSea;
  /** The place the points lie about, metres east and north of the world's centre. */
  origin: number[];
  /** Points, metres east and north of the origin; and at each the surface's height, its slope eastward and northward, and the sea's significant height, as bits. */
  points: number[][];
  values: string[][];
  /** Hulls at the origin: heading, waterplane length and beam; and the sea under each: height, slope ahead, slope across, as bits. */
  hulls: number[][];
  waves: string[][];
}

export interface SeaFile {
  /** The sea's waves, each field's values as bits. */
  components: Record<string, string[]>;
  cases: SeaCase[];
}

export interface SeaReport {
  /** Values compared. */
  values: number;
  problems: string[];
}

/** Puts a case's sea in one of the module's windows, at its tick, for drawing. */
export function loadCase(physics: Physics, slot: number, c: SeaCase): void {
  physics.seaWindow(slot, c.sea.col, c.sea.row, c.sea.size);
  for (const [i, a] of c.sea.areas.entries()) {
    physics.seaArea(
      slot,
      i,
      a[0] ?? 0,
      a[1] ?? 0,
      a[2] ?? 0,
      a[3] ?? 0,
      a[4] ?? 0,
      a[5] ?? 0,
      a[6] ?? 0,
      a[7] ?? 0,
    );
  }
  physics.seaSeal(slot);
  physics.seaDrawAt(c.sea.tick);
}

/**
 * Compares the module's sea with the file's. The module must be prepared
 * with the catalog's sea; its second window is used and left changed.
 */
export function checkSea(physics: Physics, file: SeaFile): SeaReport {
  const report: SeaReport = { values: 0, problems: [] };
  const differ = (what: string, got: string, want: string | undefined): void => {
    report.values++;
    if (got !== want && report.problems.length < 20) {
      report.problems.push(`${what}: ${got}, the server has ${want}`);
    }
  };
  const c = physics.records.components;
  const lengths: Record<string, number> = ARRAYS.components;
  for (const [name, index] of Object.entries(RECORDS.components)) {
    const want = file.components[name] ?? [];
    for (let i = 0; i < (lengths[name] ?? 0); i++) {
      differ(`wave ${i}'s ${name}`, toHex(c[index + i] ?? Number.NaN), want[i]);
    }
  }
  for (const k of file.cases) {
    loadCase(physics, 1, k);
    const [east = 0, north = 0] = k.origin;
    const got = physics.seaSample(
      1,
      k.points.flatMap((p) => [east + (p[0] ?? 0), north + (p[1] ?? 0)]),
    );
    for (const [i, want] of k.values.entries()) {
      for (let j = 0; j < 4; j++) {
        differ(`${k.name}, point ${i}, value ${j}`, toHex(got[i * 4 + j] ?? Number.NaN), want[j]);
      }
    }
    for (const [i, hull] of k.hulls.entries()) {
      const w = physics.waveUnder(1, east, north, hull[0] ?? 0, hull[1] ?? 0, hull[2] ?? 0);
      const fields = [RECORDS.wave.height, RECORDS.wave.ahead, RECORDS.wave.across];
      for (const [j, f] of fields.entries()) {
        differ(`${k.name}, hull ${i}, value ${j}`, toHex(w[f] ?? Number.NaN), k.waves[i]?.[j]);
      }
    }
  }
  return report;
}
