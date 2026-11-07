// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import type { LifeKind } from '../catalog/types.gen';
import { type FlockPlace, flockAt } from '../life/flock';
import type { LifeSeen } from '../net/messages';
import { panOf } from './harbour';
import { LIFE_RECIPES, type LifeInput, lifeEvents } from './life';

const R = LIFE_RECIPES;

/** The first kind of a call, by its index. */
function kindOf(call: string): number {
  const i = catalog.life.kinds.findIndex((k) => k.look?.call === call);
  expect(i).toBeGreaterThanOrEqual(0);
  return i;
}

const record = (kind: number, change: Partial<LifeSeen> = {}): LifeSeen => ({
  id: '1',
  rev: 0,
  kind,
  start: 30 * 900,
  end: 30 * 1500,
  east: 80,
  north: -60,
  heading: 1,
  speed: 10,
  count: 3,
  seed: 987654,
  with: 0,
  ...change,
});

const input = (records: LifeSeen[], change: Partial<LifeInput> = {}): LifeInput => ({
  seconds: 1200,
  day: true,
  listener: { east: 0, north: 0 },
  look: 0,
  groups: records.map((r) => ({
    record: r,
    kind: catalog.life.kinds[r.kind] as LifeKind,
    pose: null,
  })),
  ...change,
});

describe('the sea’s life’s calls', () => {
  test('are heard by day only, from the kinds that call', () => {
    const laugh = record(kindOf('laugh'));
    const day = lifeEvents(R, input([laugh]), 1000, 1300);
    expect(day.length).toBeGreaterThan(5);
    expect(day.every((e) => e.kind === 'laugh')).toBe(true);
    expect(lifeEvents(R, input([laugh], { day: false }), 1000, 1300)).toEqual([]);
    expect(lifeEvents(R, input([record(kindOf('silent'))]), 1000, 1300)).toEqual([]);
  });

  test('come from a group that is there, from its middle as it calls', () => {
    const tern = record(kindOf('tern'));
    const x = input([tern]);
    const g = x.groups[0];
    const at: FlockPlace = { east: 0, north: 0, up: 0 };
    for (const e of lifeEvents(R, x, 800, 1700)) {
      expect(e.at * 30).toBeGreaterThanOrEqual(tern.start);
      expect(e.at * 30).toBeLessThan(tern.end);
      expect(flockAt(tern, g?.kind as LifeKind, e.at * 30, null, at)).toBe(true);
      expect(e.pan).toBeCloseTo(panOf(x.listener, at, 0), 12);
    }
    // A group with a boat is nowhere without its pose.
    expect(lifeEvents(R, input([{ ...tern, with: 1 }]), 1000, 1300)).toEqual([]);
  });

  test('come at most once a slot from a group, alike on every phone', () => {
    const k = kindOf('whistle');
    const boobies = record(k, { speed: 0.5 });
    const all = lifeEvents(R, input([boobies]), 900, 1500);
    const slot = 60 / R.whistle.perMinute;
    const slots = all.map((e) => Math.floor(e.at / slot));
    expect(new Set(slots).size).toBe(slots.length);
    // The same calls asked for in two halves.
    const halves = [
      ...lifeEvents(R, input([boobies]), 900, 1200),
      ...lifeEvents(R, input([boobies]), 1200, 1500),
    ];
    expect(halves).toEqual(all);
    // Another group's calls come at other times.
    const other = lifeEvents(R, input([{ ...boobies, seed: 5 }]), 900, 1500);
    expect(other.map((e) => e.at)).not.toEqual(all.map((e) => e.at));
  });

  test('are fainter further off, and none past their reach', () => {
    const k = kindOf('laugh');
    const near = lifeEvents(R, input([record(k, { speed: 0.01, east: 30, north: 0 })]), 1000, 1300);
    const far = lifeEvents(R, input([record(k, { speed: 0.01, east: 120, north: 0 })]), 1000, 1300);
    expect((far[0]?.level ?? 0) / (near[0]?.level ?? 1)).toBeCloseTo(0.25, 1);
    expect(near.every((e) => e.level <= R.level)).toBe(true);
    const gone = lifeEvents(
      R,
      input([record(k, { speed: 0.01, east: 400, north: 0 })]),
      1000,
      1300,
    );
    expect(gone.every((e) => e.level === 0)).toBe(true);
  });
});
