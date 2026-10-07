// SPDX-License-Identifier: AGPL-3.0-only

// The developer page's check of the physics module in this browser: that it
// loads, that it computes the same bits as the server for every golden
// scenario and function value, and how long a step takes. Loaded only when
// the page asks, so the golden files stay out of the page's first download.

import golden from '../../../internal/physics/testdata/golden.json';
import scenarios from '../../../internal/physics/testdata/scenarios.json';
import { catalog } from '../catalog';
import { checkGolden, type GoldenFile, type ScenarioFile } from '../predict/golden';
import { LAYOUT_VERSION, RECORDS } from '../predict/layout.gen';
import { writeParams } from '../predict/params.gen';
import { loadPhysics, type Physics } from '../predict/physics';
import wasmUrl from '../predict/physics.wasm?url';

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

  rows.push({ name: 'Step time', ok: null, detail: `${stepMicroseconds(physics).toFixed(2)} µs` });
  return rows;
}

// stepMicroseconds times the step of the catalog's first boat on a beam
// reach, over at least 200 ms, since a page that is not cross-origin
// isolated gets a coarse clock.
function stepMicroseconds(physics: Physics): number {
  const r = physics.records;
  for (const v of Object.values(r)) {
    v.fill(0);
  }
  writeParams(r.params, catalog.boats[0].physics);
  physics.prepare();
  r.state[RECORDS.state.surge] = 3;
  r.control[RECORDS.control.sheet] = 0.35;
  r.env[RECORDS.env.windSpeed] = 7;
  r.env[RECORDS.env.windFrom] = Math.PI / 2;
  let steps = 0;
  const start = performance.now();
  let elapsed = 0;
  while (elapsed < 200) {
    for (let i = 0; i < 1000; i++) {
      physics.step();
    }
    steps += 1000;
    elapsed = performance.now() - start;
  }
  return (elapsed * 1000) / steps;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
