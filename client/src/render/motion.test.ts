// SPDX-License-Identifier: AGPL-3.0-only

// The boat as drawn follows the physics: it heels about its centre of
// gravity; its tiller turns the way a tiller does; its telltales read each
// strip's flow; its pennant streams downwind of the apparent wind; the
// stand-in sits where the sailor is; the overlays' arrows point the right
// way at the right length.

import { existsSync, readFileSync } from 'node:fs';
import { Group, Object3D, Vector3 } from 'three';
import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { newPose } from '../predict/blend';
import { RECORDS, SIZES } from '../predict/layout.gen';
import { startSandbox } from '../sandbox/sandbox';
import { placeBoatNodes } from './boat';
import { type Arrow, FORCE_SCALE, Overlays, UPWIND, WIND_SCALE } from './overlays';
import { type PennantPose, pennantPose } from './pennant';
import { CLIMBING, IN_WATER, ON_BOARD, placeSailor, SAILING, type SailorPlace } from './sailor';
import {
  FLOW_ABACK,
  FLOW_ATTACHED,
  FLOW_LUFFING,
  FLOW_STALLED,
  ribbonIndex,
  telltalePoses,
} from './telltales';

const kind = catalog.boats[0];
const cg = kind.physics.hull.centreOfGravity;
const DEG = Math.PI / 180;

/** The boat's root, heel and model groups, as Boat builds them. */
function boatNodes() {
  const root = new Group();
  const heel = new Group();
  const model = new Group();
  heel.position.y = cg;
  model.position.y = -cg;
  root.add(heel);
  heel.add(model);
  return { root, heel, model };
}

describe('the boat in motion', () => {
  test('heels about its centre of gravity, starboard down for positive heel', () => {
    const { root, heel, model } = boatNodes();
    const cog = new Object3D();
    cog.position.set(0, cg, 0);
    const starboard = new Object3D();
    starboard.position.set(0.6, cg, 0);
    model.add(cog, starboard);
    for (const h of [0, 0.35, -1.2, Math.PI / 2]) {
      placeBoatNodes(root, heel, { x: 12, y: 0, z: -40 }, 1.1, h);
      root.updateMatrixWorld(true);
      const p = cog.getWorldPosition(new Vector3());
      expect(p.x).toBeCloseTo(12, 12);
      expect(p.y).toBeCloseTo(cg, 12);
      expect(p.z).toBeCloseTo(-40, 12);
      const s = starboard.getWorldPosition(new Vector3());
      expect(s.y - cg).toBeCloseTo(-0.6 * Math.sin(h), 12);
    }
  });

  test('its tiller swings opposite to the way the rudder turns the bow', async () => {
    // A positive rudder turns the bow to starboard, in the physics.
    const wasm = new URL('../predict/physics.wasm', import.meta.url);
    if (!existsSync(wasm)) {
      throw new Error('client/src/predict/physics.wasm is missing: run go run ./tools/physics');
    }
    const s = await startSandbox(readFileSync(wasm), kind.physics);
    s.setState({ surge: 3, sheetLimit: 0.5 });
    for (let i = 0; i < 30; i++) {
      s.step(1, 0.4);
    }
    const rudder = s.states.current[RECORDS.state.rudder] ?? 0;
    expect(rudder).toBeGreaterThan(0);
    expect(s.states.current[RECORDS.state.yawRate]).toBeGreaterThan(0);
    // Drawn: the rudder node turns by the rudder's angle, and the tiller,
    // ahead of the stock, goes to port (−x) while the blade goes to starboard.
    const node = new Object3D();
    const tiller = new Object3D();
    tiller.position.set(0, 0.3, -1);
    const blade = new Object3D();
    blade.position.set(0, -0.5, 0.2);
    node.add(tiller, blade);
    node.rotation.y = rudder;
    node.updateMatrixWorld(true);
    expect(tiller.getWorldPosition(new Vector3()).x).toBeLessThan(0);
    expect(blade.getWorldPosition(new Vector3()).x).toBeGreaterThan(0);
  });
});

describe('the telltales', () => {
  const poses = (foot: number, head: number, boomSide: number) => {
    const out = new Float32Array(16);
    telltalePoses(foot, head, boomSide, out);
    const at = (strip: number, starboard: boolean) =>
      Array.from(
        out.subarray(ribbonIndex(strip, starboard) * 4, ribbonIndex(strip, starboard) * 4 + 4),
      );
    return at;
  };

  for (const [tack, boomSide] of [
    ['port tack (boom to starboard)', 1],
    ['starboard tack (boom to port)', -1],
  ] as const) {
    describe(tack, () => {
      // The windward face is the one away from the boom.
      const windwardStarboard = boomSide < 0;
      test('attached: both stream aft', () => {
        const at = poses(FLOW_ATTACHED, FLOW_ATTACHED, boomSide);
        for (const strip of [0, 1]) {
          for (const sb of [false, true]) {
            const [aft, lift, droop] = at(strip, sb) as [number, number, number];
            expect(aft).toBeGreaterThan(0.9);
            expect(lift).toBeLessThan(0.1);
            expect(droop).toBeLessThan(0.1);
          }
        }
      });

      test('luffing: the windward one lifts and flutters, the leeward one streams', () => {
        const at = poses(FLOW_LUFFING, FLOW_ATTACHED, boomSide);
        const [, wl, , wf] = at(0, windwardStarboard) as number[];
        const [la, ll] = at(0, !windwardStarboard) as number[];
        expect(wl).toBeGreaterThan(0.5);
        expect(wf).toBeGreaterThan(0.5);
        expect(la).toBeGreaterThan(0.9);
        expect(ll).toBeLessThan(0.1);
        // The head, drawing, is not lifted: a twisted sail can luff at the foot alone.
        expect((at(1, windwardStarboard) as number[])[1]).toBeLessThan(0.1);
      });

      test('stalled: the leeward one droops, the windward one streams', () => {
        const at = poses(FLOW_ATTACHED, FLOW_STALLED, boomSide);
        expect((at(1, !windwardStarboard) as number[])[2]).toBeGreaterThan(0.5);
        expect((at(1, windwardStarboard) as number[])[2]).toBeLessThan(0.1);
        expect((at(1, windwardStarboard) as number[])[0]).toBeGreaterThan(0.9);
      });

      test('aback: both stream forward', () => {
        const at = poses(FLOW_ABACK, FLOW_ABACK, boomSide);
        for (const sb of [false, true]) {
          expect((at(0, sb) as number[])[0]).toBeLessThan(0);
        }
      });
    });
  }

  test('the two tacks mirror each other', () => {
    for (const flow of [FLOW_LUFFING, FLOW_ATTACHED, FLOW_STALLED, FLOW_ABACK]) {
      const a = poses(flow, flow, 1);
      const b = poses(flow, flow, -1);
      for (const strip of [0, 1]) {
        expect(a(strip, true)).toEqual(b(strip, false));
        expect(a(strip, false)).toEqual(b(strip, true));
      }
    }
  });
});

describe('the pennant', () => {
  test('streams downwind of the apparent wind, in the boat’s frame', () => {
    const p: PennantPose = { yaw: 0, droop: 0, rate: 0, flutter: 0 };
    for (const awa of [0, 30, 90, 150, 180, -45, -120].map((d) => d * DEG)) {
      pennantPose(awa, 6, p);
      // Its tip, at rest along +z (aft), turned by yaw about y.
      const tip = new Vector3(0, 0, 1).applyAxisAngle(new Vector3(0, 1, 0), p.yaw);
      // The wind comes from awa off the bow (−z), to starboard (+x) positive.
      const from = new Vector3(Math.sin(awa), 0, -Math.cos(awa));
      expect(tip.dot(from)).toBeCloseTo(-1, 9);
    }
  });

  test('flies level in a breeze and hangs in a calm', () => {
    const p: PennantPose = { yaw: 0, droop: 0, rate: 0, flutter: 0 };
    expect(pennantPose(0, 6, p).droop).toBe(0);
    expect(pennantPose(0, 0.5, p).droop).toBeGreaterThan(1);
    const slow = pennantPose(0, 2, p).rate;
    expect(pennantPose(0, 10, p).rate).toBeGreaterThan(slow);
  });
});

describe('the stand-in', () => {
  const frame = { seatZ: 0.35, centreOfGravity: cg, boardZ: -0.45, boardDepth: 0.6 };
  const place = (): SailorPlace => ({ x: 0, y: 0, z: 0, facing: 0, tilt: 0 });

  test('moves across with the sailor and leans out as it hikes', () => {
    const inboard = placeSailor(-0.2, SAILING, 0, frame, -1, place());
    const hiking = placeSailor(-0.95, SAILING, 0, frame, -1, place());
    expect(inboard.x).toBeCloseTo(-0.2, 12);
    expect(hiking.x).toBeLessThan(inboard.x);
    expect(inboard.tilt).toBe(0);
    // Leaning to port: a turn about z that takes up (+y) toward −x.
    expect(hiking.tilt).toBeGreaterThan(0.5);
    const starboard = placeSailor(0.95, SAILING, 0, frame, 1, place());
    expect(starboard.tilt).toBeCloseTo(-hiking.tilt, 12);
    expect(starboard.facing).toBe(Math.PI);
  });

  test('floats beside the hull, stands on the board and climbs in by mode', () => {
    const heel = 85 * DEG;
    const water = placeSailor(0, IN_WATER, heel, frame, -1, place());
    // Level in the world: the heeled frame's turn undone.
    expect(water.tilt).toBeCloseTo(heel, 12);
    const level = new Vector3(water.x, water.y - cg, 0).applyAxisAngle(new Vector3(0, 0, 1), -heel);
    expect(level.y + cg).toBeLessThan(0);
    expect(level.x).toBeLessThan(-1);
    const board = placeSailor(0, ON_BOARD, heel, frame, -1, place());
    expect(board.y).toBeLessThan(0);
    expect(board.z).toBeCloseTo(frame.boardZ + 0.1, 12);
    const climbing = placeSailor(0, CLIMBING, 30 * DEG, frame, -1, place());
    expect(climbing.x).toBeLessThan(0);
  });
});

describe('the overlays', () => {
  const out = new Float64Array(SIZES.out);

  /** The arrow's direction and length in the scene. */
  const direction = (a: Arrow): Vector3 => {
    a.group.updateMatrixWorld(true);
    const tail = a.group.getWorldPosition(new Vector3());
    const tip = a.group.localToWorld(new Vector3(0, 0, -a.length));
    return tip.sub(tail);
  };

  test('the true wind blows toward the boat from upwind, for winds round the compass', () => {
    const o = new Overlays(kind);
    o.set(true, false);
    for (const from of [0, 45, 90, 180, 270, 330].map((d) => d * DEG)) {
      for (const speed of [3, 8]) {
        o.update(10, 20, newPose(), { speed, from }, out);
        const d = direction(o.trueWind);
        // Blowing toward from + 180°: east is +x, north −z.
        expect(d.x / d.length()).toBeCloseTo(-Math.sin(from), 9);
        expect(d.z / d.length()).toBeCloseTo(Math.cos(from), 9);
        expect(d.length()).toBeCloseTo(speed * WIND_SCALE, 9);
        // Its tip lies UPWIND metres upwind of the boat.
        const tip = o.trueWind.group.localToWorld(new Vector3(0, 0, -o.trueWind.length));
        expect(Math.hypot(tip.x - 10, tip.z - 20)).toBeCloseTo(UPWIND, 9);
      }
    }
  });

  test('the apparent wind blows across the boat from its angle, whatever the heading', () => {
    const o = new Overlays(kind);
    o.set(true, false);
    const boat = new Group();
    boat.add(o.onBoat);
    for (const heading of [0, 1, 3]) {
      boat.rotation.y = -heading;
      for (const awa of [0, 40, 90, -90, 170].map((d) => d * DEG)) {
        out[RECORDS.out.apparentWindAngle] = awa;
        out[RECORDS.out.apparentWindSpeed] = 6;
        o.update(0, 0, newPose(), { speed: 5, from: 0 }, out);
        boat.updateMatrixWorld(true);
        const d = direction(o.apparentWind).normalize();
        // In the world: from heading + awa, so toward heading + awa + 180°.
        const toward = heading + awa + Math.PI;
        expect(d.x).toBeCloseTo(Math.sin(toward), 9);
        expect(d.z).toBeCloseTo(-Math.cos(toward), 9);
      }
    }
  });

  test('the drive points ahead when positive, the side force across, in proportion', () => {
    const o = new Overlays(kind);
    o.set(false, true);
    out[RECORDS.out.drive] = 200;
    out[RECORDS.out.sideForce] = -350;
    o.update(0, 0, newPose(), { speed: 5, from: 0 }, out);
    const drive = direction(o.drive);
    expect(drive.z).toBeLessThan(0);
    expect(Math.abs(drive.x)).toBeLessThan(1e-9);
    expect(drive.length()).toBeCloseTo(200 * FORCE_SCALE, 9);
    const side = direction(o.side);
    expect(side.x).toBeLessThan(0);
    expect(side.length()).toBeCloseTo(350 * FORCE_SCALE, 9);
    out[RECORDS.out.drive] = -50;
    o.update(0, 0, newPose(), { speed: 5, from: 0 }, out);
    expect(direction(o.drive).z).toBeGreaterThan(0);
  });

  test('are drawn only when switched on', () => {
    const o = new Overlays(kind);
    expect(o.trueWind.group.visible).toBe(false);
    expect(o.drive.group.visible).toBe(false);
    o.set(true, false);
    expect(o.trueWind.group.visible).toBe(true);
    expect(o.apparentWind.group.visible).toBe(true);
    expect(o.drive.group.visible).toBe(false);
  });
});
