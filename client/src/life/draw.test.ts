// SPDX-License-Identifier: AGPL-3.0-only

// The sea's life drawn: each group about the boat it is with, or none
// where that boat is not drawn; half of it on a low tier; each bird at its
// kind's wingbeat, shrinking to nothing at the edge of its reach; the
// records past their end let go; and the towns' gulls by day only.

import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import type { BirdLook } from '../catalog/types.gen';
import type { LifeSeen } from '../net/messages';
import { Birds } from '../render/birds';
import { lifeScene } from '../sandbox/lifescene';
import { type BirdSink, type LifeBoat, LifeDraw, type LifeFrame } from './draw';
import { LifeStore } from './store';

interface Drawn {
  look: BirdLook;
  east: number;
  north: number;
  up: number;
  size: number;
}

function sink(): BirdSink & { drawn: Drawn[] } {
  const drawn: Drawn[] = [];
  return {
    drawn,
    add(look, east, north, up, _heading, _phase, size) {
      drawn.push({ look, east, north, up, size });
      return true;
    },
  };
}

const life = catalog.life;
const kinds = life.kinds;
const passing = kinds.findIndex((k) => k.path === 'pass' && k.binds === undefined);
const follows = kinds.findIndex((k) => k.binds === 'follow');

function frame(over: Partial<LifeFrame> = {}): LifeFrame {
  return {
    ticks: 0,
    cameraEast: 0,
    cameraNorth: 0,
    cameraUp: 5,
    seaHeight: 1,
    low: false,
    night: false,
    own: { east: 0, north: 0, heading: 0, speed: 3 },
    bowOf: () => 3,
    aboardOf: () => ({ perch: [0, 0.4, -1.9], deck: [0.3, 0.1, -0.3], cog: 0.3 }),
    windFrom: 0,
    skyDark: () => 0,
    ownKind: 0,
    dt: 0,
    fleet: [],
    count: 0,
    ...over,
  };
}

/** A group of a kind about the origin, its middle there now. */
function raised(kind: number, n = 1): LifeSeen {
  return lifeScene(life, kind, 100_000, { east: 0, north: 0, heading: 0 }, n, 0, {
    east: 0,
    north: 0,
  }) as LifeSeen;
}

describe('the sea’s life drawn', () => {
  test('every bird of a group near, at its kind’s look and wingbeat', () => {
    const store = new LifeStore();
    const e = raised(passing);
    store.set([e], []);
    const s = sink();
    const d = new LifeDraw(life, catalog.world.towns.buildings);
    d.frame(store, frame({ ticks: 100_000 }), s, null);
    expect(s.drawn).toHaveLength(e.count);
    expect(d.stats.birds).toBe(e.count);
    for (const b of s.drawn) {
      expect(b.look).toBe(kinds[passing]?.look);
      expect(b.size).toBe(1);
    }
  });

  test('half a group, rounded up, on a low tier', () => {
    const store = new LifeStore();
    const e = { ...raised(passing), count: 5 };
    store.set([e], []);
    const s = sink();
    new LifeDraw(life, catalog.world.towns.buildings).frame(
      store,
      frame({ ticks: 100_000, low: true }),
      s,
      null,
    );
    expect(s.drawn).toHaveLength(3);
  });

  test('shrinking to nothing at the edge of its reach, and none beyond', () => {
    const store = new LifeStore();
    const e = raised(passing);
    store.set([e], []);
    const reach = kinds[passing]?.reach ?? 1000;
    const d = new LifeDraw(life, catalog.world.towns.buildings);
    const near = sink();
    d.frame(store, frame({ ticks: 100_000, cameraEast: reach * 0.9 }), near, null);
    expect(near.drawn.some((b) => b.size < 1 && b.size > 0)).toBe(true);
    const far = sink();
    d.frame(store, frame({ ticks: 100_000, cameraEast: reach + 400 }), far, null);
    expect(far.drawn).toHaveLength(0);
  });

  test('a group with a boat about that boat; none where it is not drawn', () => {
    const d = new LifeDraw(life, catalog.world.towns.buildings);
    const e = raised(follows);
    const t = e.end - Math.floor((e.end - e.start) / 2);
    const boat: LifeBoat = {
      slot: 4,
      kind: 0,
      east: 50,
      north: 60,
      heading: 1,
      speed: 2,
      opacity: 1,
      heave: 0,
      heel: 0,
      pitch: 0,
    };
    const cases: [number, number][] = [
      [1, e.count],
      [2 + 4, e.count],
      [2 + 5, 0],
      [255, 0],
    ];
    for (const [w, n] of cases) {
      const store = new LifeStore();
      store.set([{ ...e, with: w }], []);
      const s = sink();
      d.frame(store, frame({ ticks: t, fleet: [boat], count: 1 }), s, null);
      expect(s.drawn, `with ${w}`).toHaveLength(n);
    }
  });

  test('a record past its end is let go', () => {
    const store = new LifeStore();
    const e = raised(passing);
    store.set([e], []);
    const s = sink();
    new LifeDraw(life, catalog.world.towns.buildings).frame(
      store,
      frame({ ticks: e.end }),
      s,
      null,
    );
    expect(store.size).toBe(0);
    expect(s.drawn).toHaveLength(0);
  });

  test('the birds the tests compare are those drawn', () => {
    const store = new LifeStore();
    store.set([raised(passing, 1), raised(follows, 2)], []);
    const d = new LifeDraw(life, catalog.world.towns.buildings);
    const f = frame({ ticks: 100_000 });
    const s = sink();
    d.frame(store, f, s, null);
    const at = d.birdsAt(store, f, 100_000);
    expect(at.map((b) => [b.east, b.north, b.up])).toEqual(
      s.drawn.map((b) => [b.east, b.north, b.up]),
    );
  });

  test('the towns’ gulls by day, over a town near, of the town gulls’ kind', () => {
    const gull = kinds.find((k) => k.id === life.towns.kind);
    const square = catalog.world.towns.buildings.findIndex(
      (b) => b.stands === 'square' && b.prop !== true,
    );
    expect(gull?.look).toBeDefined();
    expect(square).toBeGreaterThanOrEqual(0);
    const towns = {
      version: 1,
      buildings: () => [{ kind: square, east: 100, north: 0, seed: 3, town: 0, level: 2 }],
    };
    const d = new LifeDraw(life, catalog.world.towns.buildings);
    const day = sink();
    d.frame(new LifeStore(), frame(), day, towns);
    expect(day.drawn.length).toBeGreaterThanOrEqual(life.towns.count[0] ?? 1);
    expect(day.drawn.every((b) => b.look === gull?.look)).toBe(true);
    expect(d.stats.gulls).toBe(day.drawn.length);
    const night = sink();
    d.frame(new LifeStore(), frame({ night: true }), night, towns);
    expect(night.drawn).toHaveLength(0);
  });
});

describe('the birds’ one draw', () => {
  test('each bird written at its look’s wingbeat, glide and span', () => {
    const birds = new Birds();
    const look = kinds[passing]?.look as BirdLook;
    birds.begin({ x: 100, y: 200 }, 10, 1);
    birds.add(look, 150, 260, 12, 0, 0.5, 0.5, 0.2, 0.1, false);
    birds.add(look, 150, 260, 12, 0, 0.5, 1, 1.2, 0, true);
    birds.end();
    expect(birds.stats).toEqual({ birds: 2, draws: 1 });
    const a = birds.written(0);
    expect([a[0], a[1], a[2]]).toEqual([50, 12, -60]);
    expect(a[4]).toBeCloseTo(look.flap, 6);
    expect(a[5]).toBeCloseTo(look.glide, 6);
    expect(a[7]).toBeCloseTo(look.span * 0.5, 6);
    expect(a[11]).toBeCloseTo(0.2, 6);
    expect(a[16]).toBeCloseTo(0.1, 6);
    // In a plunge, its wings held: the same wingbeat, no beating.
    const b = birds.written(1);
    expect(b[4]).toBeCloseTo(look.flap, 6);
    expect(b[5]).toBe(1);
  });
});
