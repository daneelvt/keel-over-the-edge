// SPDX-License-Identifier: AGPL-3.0-only

// The developer panel's check of the sea in this browser, as the browser
// tests make it: each sea of internal/physics/testdata/sea.json, which Go
// wrote, is given to the page, and the boat band the GPU sums at the file's
// points is compared with Go's numbers. On a desktop the tests do this; on a
// phone, whose GPU and driver no test runs on, this does. Loaded only when
// asked for: it brings the tests' hooks and the file.

import sea from '../../../internal/physics/testdata/sea.json';
import type { Game } from '../game/game';
import { fromHex } from '../predict/golden';
import type { SeaFile } from '../predict/seacheck';
import type { SeaScene } from '../render/scene';
import type { Sandbox } from '../sandbox/sandbox';
import { makeHooks } from './hooks';

/** One sea's result: how far the GPU's height and slope are from the server's, and what the GPU is good for. */
export interface SeaCheck {
  name: string;
  height: number;
  slope: number;
  tolerance: { height: number; slope: number };
  ok: boolean;
}

/** Runs every sea of the file; the sandbox is left back at its start. */
export async function checkSeaOnGPU(
  world: SeaScene,
  game: Game,
  sandbox: Sandbox,
): Promise<SeaCheck[]> {
  const k = makeHooks(world, game, { sandbox });
  const out: SeaCheck[] = [];
  try {
    for (const c of (sea as SeaFile).cases) {
      const [east = 0, north = 0] = c.origin;
      k.placeBoat(east, north);
      k.freezeTick(c.sea.tick);
      k.setSeaWindow(c.sea.col, c.sea.row, c.sea.size, c.sea.areas as number[][]);
      k.render();
      const o = k.info().origin;
      const scene = c.points.flatMap((p) => [
        east + (p[0] ?? 0) - o.east,
        -(north + (p[1] ?? 0) - o.north),
      ]);
      const got = await k.band(scene);
      const tolerance = k.tolerance();
      let height = 0;
      let slope = 0;
      for (const [i, v] of c.values.entries()) {
        const at = (j: number, want: number): number =>
          Math.abs((got.gpu[i * 4 + j] ?? Number.NaN) - want);
        height = Math.max(height, at(0, fromHex(v[0] ?? '')));
        // The scene's z runs south.
        slope = Math.max(slope, at(1, fromHex(v[1] ?? '')), at(2, -fromHex(v[2] ?? '')));
      }
      const ok = height < tolerance.height && slope < tolerance.slope;
      out.push({ name: c.name, height, slope, tolerance, ok });
    }
  } finally {
    k.thaw();
    sandbox.reset();
  }
  return out;
}

/** The results as lines, in millimetres. */
export function seaCheckLines(results: SeaCheck[]): string {
  return results
    .map(
      (r) =>
        `${r.ok ? 'ok ' : 'OFF'} ${r.name}: ${(r.height * 1000).toFixed(2)} mm of ${(r.tolerance.height * 1000).toFixed(2)}, slope ${r.slope.toExponential(1)} of ${r.tolerance.slope.toExponential(1)}`,
    )
    .join('\n');
}
