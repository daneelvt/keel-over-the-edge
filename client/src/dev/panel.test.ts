// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { advance, type BoatState } from '../render/scene';
import { applyState, type PanelWorld, RIM, readState, toRim } from './panel';

function stub(): PanelWorld & { calls: string[] } {
  const calls: string[] = [];
  const w: PanelWorld & { calls: string[] } = {
    calls,
    testSea: 'flat',
    usePass: true,
    boatState: { east: 0, north: 0, heading: 0, speed: 0 },
    stage: {
      antialias: 'fxaa',
      scale: null,
      setAntialias(a) {
        calls.push(`aa ${a}`);
        this.antialias = a;
      },
      setScale(s) {
        calls.push(`scale ${s}`);
        this.scale = s;
      },
    },
    setTestSea(name) {
      calls.push(`sea ${name}`);
      w.testSea = name;
    },
    setUsePass(on) {
      calls.push(`pass ${on}`);
      w.usePass = on;
    },
    placeBoat(east, north) {
      calls.push(`boat ${east} ${north}`);
      w.boatState.east = east;
      w.boatState.north = north;
    },
  };
  return w;
}

describe('the panel', () => {
  test('reads headings in degrees and speeds in knots', () => {
    const w = stub();
    w.boatState.heading = -Math.PI / 2;
    w.boatState.speed = 1852 / 3600;
    const s = readState(w);
    expect(s.heading).toBeCloseTo(270, 9);
    expect(s.speed).toBeCloseTo(1, 9);
  });

  test('applies only what changed', () => {
    const w = stub();
    applyState(w, readState(w));
    expect(w.calls).toEqual([]);
    applyState(w, {
      ...readState(w),
      sea: 'gale',
      antialias: 'smaa',
      scale: 1,
      pass: false,
      east: 5,
    });
    expect(w.calls).toEqual(['sea gale', 'boat 5 0', 'aa smaa', 'scale 1', 'pass false']);
    applyState(w, { ...readState(w), heading: 90, speed: 2 });
    expect(w.boatState.heading).toBeCloseTo(Math.PI / 2, 12);
    expect(w.boatState.speed).toBeCloseTo((2 * 1852) / 3600, 12);
  });

  test('jumps to the rim along the boat’s bearing from the centre', () => {
    const w = stub();
    const s = toRim({ ...readState(w), east: 30, north: 40 });
    expect(Math.hypot(s.east, s.north)).toBeCloseTo(RIM, 9);
    expect(s.east / s.north).toBeCloseTo(0.75, 12);
    const fromCentre = toRim(readState(w));
    expect([fromCentre.east, fromCentre.north]).toEqual([RIM, 0]);
  });
});

describe('the boat on a straight line', () => {
  test('moves along its heading at its speed', () => {
    const b: BoatState = { east: 10, north: 20, heading: Math.PI / 2, speed: 3 };
    for (let i = 0; i < 60; i++) {
      advance(b, 1 / 60);
    }
    expect(b.east).toBeCloseTo(13, 9);
    expect(b.north).toBeCloseTo(20, 9);
    b.heading = Math.PI;
    advance(b, 2);
    expect(b.north).toBeCloseTo(14, 9);
  });
});
