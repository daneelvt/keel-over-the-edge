// SPDX-License-Identifier: AGPL-3.0-only

import { Vector3 } from 'three';
import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { raceColour } from '../ui/prize';
import { flagAtlas } from './flags';
import {
  apparentWind,
  BURGEE,
  burgeeOf,
  cockadeOf,
  committeeOf,
  PrizesAfloat,
  pennantOf,
  pennantsOf,
  prizeCode,
  prizeRig,
  spoonsOf,
} from './prizes';
import { cockadePlace, onDisc } from './sailors/cockade';

const C = catalog.world.committee;

describe('a prize code', () => {
  test('carries the pennants newest first, the burgee, the spoons and the committee flag', () => {
    const code = prizeCode({
      pennants: [2, 5, 0],
      burgee: BURGEE.gilded,
      spoons: 3,
      committee: true,
    });
    expect(pennantsOf(code)).toBe(3);
    expect([0, 1, 2].map((i) => pennantOf(code, i))).toEqual([2, 5, 0]);
    expect(burgeeOf(code)).toBe(BURGEE.gilded);
    expect(spoonsOf(code)).toBe(3);
    expect(committeeOf(code)).toBe(true);
    expect(cockadeOf(code)).toBe(true);
    // The server's layout: one pennant of the third colour and the racing burgee.
    expect(prizeCode({ pennants: [2], burgee: BURGEE.racing })).toBe(1 | (2 << 3) | (1 << 18));
  });

  test('none at all: nothing flown, nothing worn; a spoon alone wears no cockade', () => {
    expect(pennantsOf(0) + burgeeOf(0) + spoonsOf(0)).toBe(0);
    expect(committeeOf(0) || cockadeOf(0)).toBe(false);
    expect(cockadeOf(prizeCode({ spoons: 1, burgee: BURGEE.racing }))).toBe(false);
    expect(pennantsOf(prizeCode({ pennants: [0, 1, 2, 3, 4, 5, 0] }))).toBe(5);
  });
});

describe('the prize flags', () => {
  test("the winner's pennants are swallowtails in the races' colours, the ribbons' own, in their order", () => {
    const pennants = C.flags.filter((f) => f.signal === 'victory');
    const dye = new Map(C.dyes.map((d) => [d.letter, d.colour]));
    const colours = pennants.map((f) => dye.get(f.rows[0]?.[0] ?? '') ?? '');
    // raceColour picks a code's colour from the same list: every code's pennant matches its ribbon.
    for (const code of ['abcdefghij', 'k2m3n4p5q6', 'zzzzzzzzzz', 'a2a2a2a2a2']) {
      let h = 0;
      for (const ch of code) {
        h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      }
      expect(colours[h % colours.length]).toBe(raceColour(code));
    }
    const { designs } = flagAtlas(C.flags, C.dyes);
    const i = C.flags.findIndex((f) => f.signal === 'victory');
    expect(designs[i]?.fork ?? 0).toBeGreaterThan(0);
    expect(designs[C.flags.findIndex((f) => f.signal === 'burgee')]?.fork).toBe(0);
  });

  test('a rig from the model: the masthead, the stay to the stem and the stern, sized by the mast', () => {
    const nodes = new Map([
      ['pennant', new Vector3(0, 9.76, -1.14)],
      ['jib', new Vector3(0, 0.75, -3.76)],
    ]);
    const hull = {
      solid: {
        stations: [
          [3.05, 0.8, 0.702, -0.08],
          [-3.81, 0, 0.712, -0.712],
        ],
      },
    };
    const rig = prizeRig(nodes, hull);
    expect(rig.masthead.y).toBeCloseTo(9.76);
    expect(rig.stay.z).toBeCloseTo(-3.76);
    expect(rig.stern.z).toBeGreaterThan(2.9);
    expect(rig.stern.y).toBeCloseTo(0.702);
    expect(rig.scale).toBeCloseTo(1, 1);
    // No stay: to the stem; a tall mast: bigger flags.
    const tall = prizeRig(new Map([['pennant', new Vector3(0, 31, 0)]]), hull);
    expect(tall.stay.z).toBeCloseTo(-3.81);
    expect(tall.scale).toBeGreaterThan(2);
  });

  test('a boat under way feels the wind she makes', () => {
    const w = apparentWind(0, 5, 0, 5, { from: 0, speed: 0 });
    // A north wind and a boat sailing north at its speed: twice the wind, from ahead.
    expect(w.speed).toBeCloseTo(10);
    expect(w.from).toBeCloseTo(0);
    const beam = apparentWind(Math.PI / 2, 4, 0, 3, { from: 0, speed: 0 });
    expect(beam.speed).toBeCloseTo(5);
  });

  test('each boat flies its own, in two draws however many boats', () => {
    const p = new PrizesAfloat(C, catalog.world.towns.flags);
    const rig = prizeRig(new Map([['pennant', new Vector3(0, 9, 0)]]), undefined);
    const place = (v: Vector3, out: Vector3): Vector3 => out.copy(v).add(new Vector3(100, 0, -50));
    const wind = { from: 0, speed: 6 };
    p.begin();
    p.add(prizeCode({ pennants: [0, 1, 2], burgee: BURGEE.racing }), rig, place, wind, 1, 0, {
      x: 0,
      y: 0,
    });
    p.add(prizeCode({ spoons: 2, committee: true }), rig, place, wind, 2, 0, { x: 0, y: 0 });
    p.add(0, rig, place, wind, 3, 0, { x: 0, y: 0 });
    p.end({ x: 0, y: 0 }, 0);
    expect(p.stats).toMatchObject({
      boats: 2,
      pennants: 3,
      burgees: 1,
      committees: 1,
      spoons: 2,
      flags: 5,
    });
    expect(p.flags.mesh.count).toBe(5);
    expect(p.spoons.count).toBe(2);
    // The burgee above the masthead, the pennants down from it.
    const heads = p.shown.slice(0, 5).map((f) => f.top);
    expect(heads[0]).toBeGreaterThan(9);
    expect(heads[1]).toBeLessThan(9);
    expect(heads[2]).toBeLessThan(heads[1] ?? 0);
    // A frame with none draws none.
    p.begin();
    p.end({ x: 0, y: 0 }, 1);
    expect(p.flags.mesh.visible || p.spoons.visible).toBe(false);
  });
});

describe('the cockade', () => {
  test('every look has a place for it, on its figure as bound', () => {
    const versions = [...catalog.sailors.flatMap((l) => l.versions), ...catalog.machine.versions];
    for (const v of versions) {
      const c = cockadePlace(v.art.cockade, C.prizes.cockade.across);
      // Above the waist, on the figure's left (+x), facing out from it.
      expect(c.at.y, v.art.model).toBeGreaterThan(1.1);
      expect(c.at.x, v.art.model).toBeGreaterThan(0);
      expect(c.facing.length()).toBeCloseTo(1);
      // Its middle is on its disc; a point a radius across is at its edge.
      const out = new Vector3();
      expect(onDisc(c.at, c, out).length()).toBeCloseTo(0);
      const edge = c.at.clone().addScaledVector(c.across, c.radius);
      expect(onDisc(edge, c, out).x).toBeCloseTo(1);
      expect(v.art.cockade.inked.every((u) => u > 0 && u < 1)).toBe(true);
    }
  });
});
