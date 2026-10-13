// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { writeSkyParams } from '../predict/params.gen';
import { BODY, loadPhysics, type Physics, SKY } from '../predict/physics';
import { SkyTime, skyEpochUs } from '../sky/skytime';
import { setSky, skyLines } from './skypanel';

const wasm = new URL('../predict/physics.wasm', import.meta.url);
let physics: Physics;

beforeAll(async () => {
  if (!existsSync(wasm)) {
    throw new Error('client/src/predict/physics.wasm is missing: run go run ./tools/physics');
  }
  physics = await loadPhysics(readFileSync(wasm));
  writeSkyParams(physics.skyParams, catalog.sky);
  physics.prepareSky();
});

describe('the panel’s sky', () => {
  test('its hour sets the sun’s height the readout shows', () => {
    const sky = new SkyTime((e, w) => physics.skyTime(e, w), skyEpochUs(catalog.sky) + 7e12);
    const ticks = 3000;
    for (const [hour, height] of [
      [12, '90.0°'],
      [18, '0.0°'],
      [0, '-90.0°'],
      [8, '30.0°'],
    ] as const) {
      setSky(sky, { hour, moon: null }, ticks);
      const t = sky.at(ticks);
      expect(physics.skyAt(t, 0, 0)[SKY.sun + BODY.altitude]).toBeCloseTo(
        (Number.parseFloat(height) * Math.PI) / 180,
        6,
      );
      expect(skyLines(physics, t, 0, 0)[1]).toContain(`sun     ${height} up`);
      // The world's own sky is untouched: nothing of this is the server's.
      expect(sky.world(ticks)).toBe(7e12 + ticks * (1e6 / 30));
    }
  });

  test('the readout gives the Hub Star’s height beside 90° less ten for each mile', () => {
    const lines = skyLines(physics, 0, 0, 1852 * 2.25);
    const hub = lines.find((l) => l.startsWith('The Hub Star'));
    expect(hub).toBe('The Hub Star67.5° up; 90° − 10° × 2.250 NM = 67.5°');
  });
});
