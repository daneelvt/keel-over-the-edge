// SPDX-License-Identifier: AGPL-3.0-only

// The developer page's check of the physics module in this browser: that it
// loads, that it computes the same bits as the server for every golden
// scenario and function value and for the sea, and how long a step takes in
// flat water, in a breeze's sea and in a gale's. Loaded only when
// the page asks, so the golden files stay out of the page's first download.

import golden from '../../../internal/physics/testdata/golden.json';
import scenarios from '../../../internal/physics/testdata/scenarios.json';
import sea from '../../../internal/physics/testdata/sea.json';
import { catalog } from '../catalog';
import { checkGolden, type GoldenFile, type ScenarioFile } from '../predict/golden';
import { LAYOUT_VERSION, RECORDS, SEA } from '../predict/layout.gen';
import { loadPhysics, type Physics } from '../predict/physics';
import wasmUrl from '../predict/physics.wasm?url';
import { preparePhysics } from '../predict/predictor';
import { checkSea, type SeaFile } from '../predict/seacheck';

export interface PhysicsRow {
  name: string;
  ok: boolean | null;
  detail: string;
}

export async function checkPhysics(): Promise<PhysicsRow[]> {
  let physics: Physics;
  let bytes: number;
  try {
    const res = await fetch(wasmUrl);
    const data = await res.arrayBuffer();
    bytes = data.byteLength;
    physics = await loadPhysics(data);
  } catch (err) {
    return [{ name: 'Physics module', ok: false, detail: message(err) }];
  }
  const rows: PhysicsRow[] = [
    {
      name: 'Physics module',
      ok: true,
      detail: `${(bytes / 1024).toFixed(1)} KB, layout 0x${LAYOUT_VERSION.toString(16)}`,
    },
  ];

  try {
    const report = await checkGolden(physics, scenarios as ScenarioFile, golden as GoldenFile);
    const ok = report.problems.length === 0;
    rows.push({
      name: 'Same bits as the server',
      ok,
      detail: ok
        ? `${report.scenarios} scenarios, ${report.values} function values`
        : `${report.problems.length} differ; first: ${report.problems[0]}`,
    });
  } catch (err) {
    rows.push({ name: 'Same bits as the server', ok: false, detail: message(err) });
  }

  try {
    preparePhysics(physics, catalog.boats[0].physics, catalog.weather.sea);
    const report = checkSea(physics, sea as SeaFile);
    const ok = report.problems.length === 0;
    rows.push({
      name: 'The sea, same bits as the server',
      ok,
      detail: ok
        ? `${report.values} values`
        : `${report.problems.length} differ; first: ${report.problems[0]}`,
    });
  } catch (err) {
    rows.push({ name: 'The sea, same bits as the server', ok: false, detail: message(err) });
  }

  for (const [name, knots] of [
    ['Step time, flat water', 0],
    ['Step time, a breeze’s sea', 12],
    ['Step time, a gale’s sea', 34],
  ] as const) {
    const t = stepMicroseconds(physics, knots);
    rows.push({ name, ok: null, detail: `${t.micros.toFixed(2)} µs${t.waves}` });
  }
  return rows;
}

// stepMicroseconds times the step of the catalog's first boat on a beam
// reach in the sea a wind of knots raises over open water (flat water for
// none), with the sea's time set for each step as a prediction sets it,
// over at least 200 ms, since a page that is not cross-origin isolated gets
// a coarse clock.
function stepMicroseconds(physics: Physics, knots: number): { micros: number; waves: string } {
  preparePhysics(physics, catalog.boats[0].physics, catalog.weather.sea);
  let waves = '';
  if (knots > 0) {
    const input = physics.seaInputOf((knots * 1852) / 3600, 0, -1, []);
    physics.seaWindow(0, 16, 16, SEA.window);
    for (let i = 0; i < SEA.window * SEA.window; i++) {
      physics.seaArea(0, i, input[0] ?? 0, input[1] ?? 0, input[2] ?? 0);
    }
    physics.seaSeal(0);
    waves = `, ${physics.seaActive(0).length} waves`;
  }
  physics.seaUse(knots > 0 ? 0 : -1);
  const r = physics.records;
  r.state[RECORDS.state.surge] = 3;
  r.control[RECORDS.control.sheet] = 0.35;
  r.env[RECORDS.env.windSpeed] = 7;
  r.env[RECORDS.env.windFrom] = Math.PI / 2;
  let steps = 0;
  const start = performance.now();
  let elapsed = 0;
  let tick = 740_000_000;
  while (elapsed < 200) {
    for (let i = 0; i < 1000; i++) {
      if (knots > 0) {
        physics.seaAt(tick++);
      }
      physics.step();
    }
    steps += 1000;
    elapsed = performance.now() - start;
  }
  return { micros: (elapsed * 1000) / steps, waves };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
