// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox's looks against the server's, on seed 1: the chart file go
// run ./tools/dev -world 1 writes holds the server's sight table and what
// it sees along eight runs out from the main port, in calm air; and in a
// fog bank held off the main port, which the module's weather gives the
// sandbox's look as the server's gives its own.

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { catalog } from '../catalog';
import { setRecord, spellOf } from '../predict/golden';
import { SIZES } from '../predict/layout.gen';
import { loadPhysics, type Physics } from '../predict/physics';
import { preparePhysics } from '../predict/predictor';
import { type Air, look, type SightExport } from './sight';

const file = new URL('../../../.dev/worlds/1.chart', import.meta.url);
const wasm = new URL('../predict/physics.wasm', import.meta.url);

interface Check {
  X: number;
  Y: number;
  Seen: number[];
}

interface ChartFile {
  sight: SightExport;
  checks: Check[];
  fog: {
    spell: Record<string, number>;
    record: Record<string, number>;
    tick: number;
    checks: Check[];
  };
}

let physics: Physics;

beforeAll(async () => {
  physics = await loadPhysics(readFileSync(wasm));
  preparePhysics(physics, catalog.boats[0].physics, catalog.weather, catalog.world);
});

/** The module's air at a tick. */
function airAt(tick: number): Air {
  physics.windDrawAt(tick);
  return {
    depth: (x0, y0, h0, x1, y1, h1) => physics.opticalDepth(x0, y0, h0, x1, y1, h1),
    contrast: catalog.weather.visibility.contrast,
  };
}

function sees(c: ChartFile, checks: Check[], air: Air): number {
  let seen = 0;
  for (const k of checks) {
    const got = look(c.sight, k.X, k.Y, 2, new Set(), air).sort((a, b) => a - b);
    expect(got, `at ${k.X.toFixed(0)}, ${k.Y.toFixed(0)}`).toEqual(
      [...k.Seen].sort((a, b) => a - b),
    );
    seen += got.length;
  }
  return seen;
}

describe('the sandbox’s lookout', () => {
  it.skipIf(!existsSync(file))('sees what the server’s does along seed 1’s runs', () => {
    const c = JSON.parse(readFileSync(file, 'utf8')) as ChartFile;
    expect(c.checks.length).toBeGreaterThan(1000);
    physics.setSpells([]);
    physics.setRecords([]);
    expect(sees(c, c.checks, airAt(0))).toBeGreaterThan(0);
  });

  it.skipIf(!existsSync(file))('sees what the server’s does in a fog bank', () => {
    const c = JSON.parse(readFileSync(file, 'utf8')) as ChartFile;
    expect(c.fog.checks.length).toBeGreaterThan(100);
    physics.setSpells([spellOf(c.fog.spell)]);
    const r = new Float64Array(SIZES.systemRecord);
    setRecord(r, 'systemRecord', c.fog.record);
    physics.setRecords([r]);
    const foggy = sees(c, c.fog.checks, airAt(c.fog.tick));
    physics.setRecords([]);
    physics.setSpells([]);
    const clear = sees(c, c.checks, airAt(0));
    expect(foggy).toBeGreaterThan(0);
    expect(foggy).toBeLessThan(clear);
  });
});
