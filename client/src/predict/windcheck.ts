// SPDX-License-Identifier: AGPL-3.0-only

// Checks the wind in the physics module against the server's: for each
// weather of internal/physics/testdata/wind.json, the wind in full at its
// points, the gust field's frame and the wave wind at its place, which Go
// wrote and the module must give bit for bit. The tests run it under Node;
// the developer page runs it on a phone.

import { type RecordValues, spellOf, toHex } from './golden';
import { ARRAYS, RECORDS } from './layout.gen';
import { type Physics, WIND_VALUES } from './physics';

/** One weather of the file: the spells, where and when, and what Go computed there. */
export interface WindCase {
  name: string;
  /** The spells in play, each by its fields' names, and the tick asked about, which need not be whole. */
  spells: RecordValues[];
  tick: number;
  /** The place the points lie about, metres east and north of the world's centre. */
  origin: number[];
  /**
   * Points, metres east and north of the origin; and at each the wind's
   * speed and direction, the mean wind's speed and direction, the gust
   * field and the gust factor, as bits.
   */
  points: number[][];
  values: string[][];
  /** The gust field's frame, each field's values as bits. */
  frame: Record<string, string[]>;
  /** The wave wind at the origin: its speed and direction, as bits. */
  wave: string[];
}

export interface WindFile {
  cases: WindCase[];
}

export interface WindReport {
  /** Values compared. */
  values: number;
  problems: string[];
}

/** Puts a case's spells in play in the module, and its tick for drawing. */
export function loadWindCase(physics: Physics, c: WindCase): void {
  physics.setSpells(c.spells.map(spellOf));
  physics.windDrawAt(c.tick);
}

/**
 * Compares the module's wind with the file's. The module must be prepared
 * with the catalog's weather; its spells in play are left changed.
 */
export function checkWind(physics: Physics, file: WindFile): WindReport {
  const report: WindReport = { values: 0, problems: [] };
  const differ = (what: string, got: string, want: string | undefined): void => {
    report.values++;
    if (got !== want && report.problems.length < 20) {
      report.problems.push(`${what}: ${got}, the server has ${want}`);
    }
  };
  const lengths: Record<string, number> = ARRAYS.gustFrame;
  for (const c of file.cases) {
    loadWindCase(physics, c);
    const [east = 0, north = 0] = c.origin;
    const at = c.points.flatMap((p) => [east + (p[0] ?? 0), north + (p[1] ?? 0)]);
    const got = physics.windSample(at, new Float64Array(c.points.length * WIND_VALUES));
    for (const [i, want] of c.values.entries()) {
      for (let j = 0; j < WIND_VALUES; j++) {
        differ(
          `${c.name}, point ${i}, value ${j}`,
          toHex(got[i * WIND_VALUES + j] ?? Number.NaN),
          want[j],
        );
      }
    }
    const frame = physics.gustFrame();
    for (const [name, index] of Object.entries(RECORDS.gustFrame)) {
      const want = c.frame[name] ?? [];
      for (let i = 0; i < (lengths[name] ?? 1); i++) {
        differ(
          `${c.name}, the frame's ${name} ${i}`,
          toHex(frame[index + i] ?? Number.NaN),
          want[i],
        );
      }
    }
    const wave = physics.waveWind(east, north, c.tick, [0, 0]);
    differ(`${c.name}, the wave wind's speed`, toHex(wave[0] ?? Number.NaN), c.wave[0]);
    differ(`${c.name}, the wave wind's direction`, toHex(wave[1] ?? Number.NaN), c.wave[1]);
  }
  return report;
}
