// SPDX-License-Identifier: AGPL-3.0-only

// The other boats' interpolation, with a world clock the tests move: the
// blend between samples; the bands' delays, and how they grow with TCP's
// stalls (the arrival times of the Go client's lossy trace) and shrink
// back; carrying a boat on, holding it, and easing the difference away;
// the render tick, which never runs back; and the fades.

import { describe, expect, test } from 'vitest';
import lossy from '../../../shared/protocol/testdata/trace-lossy.json';
import { TICKS_PER_SECOND } from '../net/clock';
import { CHANGE, FLEET_META, SLOT, SLOT_FIELDS, slotAt, VIEW_SLOTS } from '../net/view';
import {
  BAND_CHANGE,
  EXTRAPOLATE,
  FADE,
  FAR_DELAY,
  Fleet,
  MOTION,
  NEAR_DELAY,
  SLEW,
} from './fleet';

const TICK_US = 1e6 / TICKS_PER_SECOND;
const FRAME = 1 / 60;

interface SlotIn {
  slot: number;
  change?: number;
  x?: number;
  y?: number;
  heading?: number;
  far?: boolean;
  sampled?: boolean;
  kind?: number;
}

/** A snapshot record's fleet: the slots given present, the rest empty. */
function record(tick: number, slots: SlotIn[]): Float64Array {
  const f = new Float64Array(5 + VIEW_SLOTS * SLOT_FIELDS);
  f[FLEET_META.tick] = tick;
  for (const s of slots) {
    const o = slotAt(s.slot);
    f[o + SLOT.present] = s.change === CHANGE.left ? 0 : 1;
    f[o + SLOT.change] = s.change ?? CHANGE.none;
    f[o + SLOT.sampled] = s.sampled === false ? 0 : 1;
    f[o + SLOT.kind] = s.kind ?? 0;
    f[o + SLOT.far] = s.far ? 1 : 0;
    f[o + SLOT.x] = s.x ?? 0;
    f[o + SLOT.y] = s.y ?? 0;
    f[o + SLOT.heading] = s.heading ?? 0;
  }
  return f;
}

/**
 * A fleet fed a snapshot every two ticks, each arriving `late` µs after its
 * tick, with boat 0 sailing east at 3 m/s, its heading turning; frames 60
 * a second. world() is world time.
 */
function sailing(late = 100_000, far = false) {
  const fleet = new Fleet();
  let world = 0;
  let tick = 0;
  const feed = (t: number, change: number = CHANGE.none) =>
    fleet.add(
      record(t, [{ slot: 0, change, x: (3 * t) / TICKS_PER_SECOND, heading: 3 + t * 0.01, far }]),
      t * TICK_US + late,
    );
  /** Runs frames to world time `until`, feeding each snapshot as it arrives. */
  const run = (until: number, stopFeeding = Number.POSITIVE_INFINITY) => {
    while (world < until) {
      world += FRAME * 1e6;
      while ((tick + 2) * TICK_US + late <= world && tick + 2 <= stopFeeding) {
        tick += 2;
        feed(tick, tick === 2 ? CHANGE.entered : CHANGE.none);
      }
      fleet.update(world, FRAME);
    }
  };
  return { fleet, run, world: () => world, newest: () => tick };
}

describe('the fleet', () => {
  test('between two samples: their blend at the render tick, angles the shorter way', () => {
    const fleet = new Fleet();
    fleet.add(
      record(10, [{ slot: 3, change: CHANGE.entered, x: 0, heading: Math.PI - 0.1 }]),
      10 * TICK_US,
    );
    fleet.add(record(12, [{ slot: 3, x: 2, heading: -Math.PI + 0.1 }]), 12 * TICK_US);
    // The near band at tick 11: 4 ticks behind data of tick 15.
    fleet.update(15 * TICK_US, 0);
    const b = fleet.drawn[0];
    expect(fleet.count).toBe(1);
    expect(b?.tick).toBeCloseTo(11, 9);
    expect(b?.east).toBeCloseTo(1, 9);
    // Across ±π, not the long way round through 0.
    expect(Math.abs(Math.cos(b?.heading ?? 0) + 1)).toBeLessThan(1e-9);
    expect(b?.motion).toBe(MOTION.interpolated);
  });

  test('near boats are drawn 133 ms behind the newest data, far ones 400 ms', () => {
    for (const far of [false, true]) {
      const s = sailing(100_000, far);
      s.run(5e6);
      const b = s.fleet.drawn[0];
      // The newest data, at world time now, is of tick (world − 100 ms).
      const data = (s.world() - 100_000) / TICK_US;
      expect(data - (b?.tick ?? 0)).toBeCloseTo(far ? FAR_DELAY : NEAR_DELAY, 1);
      expect(b?.motion).toBe(MOTION.interpolated);
      expect(b?.east).toBeCloseTo((3 * (b?.tick ?? 0)) / TICKS_PER_SECOND, 6);
    }
  });

  test('a boat changing band moves between the delays over a second, without a jump', () => {
    const fleet = new Fleet();
    let world = 0;
    const ticks: number[] = [];
    for (let t = 2; t < 600; t += 2) {
      fleet.add(
        record(t, [{ slot: 0, change: t === 2 ? CHANGE.entered : CHANGE.none, far: t > 300 }]),
        t * TICK_US,
      );
      for (let k = 0; k < 4; k++) {
        world = t * TICK_US + k * (TICK_US / 2);
        fleet.update(world, FRAME);
        if (fleet.count > 0) {
          ticks.push(fleet.drawn[0]?.tick ?? 0);
        }
      }
    }
    for (let i = 1; i < ticks.length; i++) {
      const step = (ticks[i] ?? 0) - (ticks[i - 1] ?? 0);
      expect(step).toBeGreaterThanOrEqual(0);
      // Never more than real time and the slew, and the band change's share.
      expect(step).toBeLessThan(
        FRAME * TICKS_PER_SECOND * (1 + SLEW) +
          ((FAR_DELAY - NEAR_DELAY) * FRAME * TICKS_PER_SECOND) / BAND_CHANGE +
          1e-9,
      );
    }
    const data = world / TICK_US;
    expect(data - (fleet.drawn[0]?.tick ?? 0)).toBeCloseTo(FAR_DELAY, 0);
  });

  test('data late: carried on for 250 ms, then held; the difference eased away when it comes', () => {
    const s = sailing();
    s.run(3e6);
    // The snapshots stop.
    const last = s.newest();
    s.run(3e6 + 200_000, last);
    const motions = new Set<number>();
    let heldAt = 0;
    while (s.world() < 3e6 + 900_000) {
      s.run(s.world() + FRAME * 1e6, last);
      motions.add(s.fleet.drawn[0]?.motion ?? -1);
      if (heldAt === 0 && s.fleet.drawn[0]?.motion === MOTION.held) {
        heldAt = s.fleet.drawn[0]?.tick ?? 0;
      }
    }
    expect(motions.has(MOTION.extrapolated)).toBe(true);
    expect(heldAt - last).toBeGreaterThan(EXTRAPOLATE);
    const held = s.fleet.drawn[0]?.east ?? 0;
    // Carried on at 3 m/s for 250 ms past the last sample, then held.
    expect(held).toBeCloseTo((3 * (last + EXTRAPOLATE)) / TICKS_PER_SECOND, 6);
    expect(s.fleet.stats.held).toBe(1);
    // The snapshots come again: no jump, and the difference gone in 100 ms.
    const before = s.fleet.drawn[0]?.east ?? 0;
    s.run(s.world() + FRAME * 1e6);
    expect(Math.abs((s.fleet.drawn[0]?.east ?? 0) - before)).toBeLessThan(0.2);
    s.run(s.world() + 150_000);
    const b = s.fleet.drawn[0];
    expect(b?.east).toBeCloseTo((3 * (b?.tick ?? 0)) / TICKS_PER_SECOND, 6);
  });

  test('with TCP’s stalls the delay grows toward double; steady arrivals shrink it back', () => {
    // The Go client's lossy trace: each snapshot's tick and when it came.
    const arrivals: [number, number][] = [];
    for (const e of (lossy as { events: { t: number; in?: string }[] }).events) {
      if (e.in?.startsWith('02') && e.in.length > 20) {
        const b = e.in;
        let tick = 0;
        for (let k = 7; k >= 0; k--) {
          tick = tick * 256 + Number.parseInt(b.slice(4 + 2 * k, 6 + 2 * k), 16);
        }
        arrivals.push([tick, e.t]);
      }
    }
    expect(arrivals.length).toBeGreaterThan(200);
    const fleet = new Fleet();
    const offset = (arrivals[0]?.[0] ?? 0) * TICK_US - (arrivals[0]?.[1] ?? 0);
    let world = (arrivals[0]?.[1] ?? 0) + offset;
    let grew = 0;
    const ticks: number[] = [];
    arrivals.forEach(([tick, t], i) => {
      while (world < t + offset) {
        world += FRAME * 1e6;
        fleet.update(world, FRAME);
        if (fleet.count > 0) {
          ticks.push(fleet.drawn[0]?.tick ?? 0);
        }
      }
      fleet.add(
        record(tick, [{ slot: 0, change: i === 0 ? CHANGE.entered : CHANGE.none }]),
        t + offset,
      );
      grew = Math.max(grew, fleet.near.delay);
    });
    expect(grew).toBeGreaterThan(NEAR_DELAY * 1.5);
    expect(grew).toBeLessThanOrEqual(2 * NEAR_DELAY);
    for (let i = 1; i < ticks.length; i++) {
      expect((ticks[i] ?? 0) - (ticks[i - 1] ?? 0)).toBeGreaterThanOrEqual(0);
    }
    // Then 20 s of steady arrivals.
    const last = arrivals.at(-1)?.[0] ?? 0;
    for (let k = 1; k <= 300; k++) {
      const tick = last + 2 * k;
      world = tick * TICK_US + 100_000;
      fleet.add(record(tick, [{ slot: 0 }]), world);
      fleet.update(world, (2 * TICK_US) / 1e6);
    }
    expect(fleet.near.delay).toBeCloseTo(NEAR_DELAY, 1);
  });

  test('the render tick never runs back, even when the data jumps', () => {
    const s = sailing();
    let prev = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < 600; i++) {
      s.run(s.world() + FRAME * 1e6);
      const t = s.fleet.near.tick;
      if (!Number.isNaN(t)) {
        expect(t).toBeGreaterThanOrEqual(prev);
        prev = t;
      }
    }
  });

  test('boats fade in and out over half a second; a boat replaced fades from where it was', () => {
    const fleet = new Fleet();
    let world = 0;
    const step = (until: number, feed: (tick: number) => void) => {
      while (world < until) {
        world += FRAME * 1e6;
        const tick = Math.floor(world / TICK_US);
        if (tick % 2 === 0) {
          feed(tick);
        }
        fleet.update(world + 200_000, FRAME);
      }
    };
    let entered = false;
    step(2e6, (t) => {
      fleet.add(
        record(t, [{ slot: 5, change: entered ? CHANGE.none : CHANGE.entered, x: 7 }]),
        world,
      );
      entered = true;
    });
    expect(fleet.drawn[0]?.opacity).toBe(1);
    // Replaced by another boat, far off.
    let replaced = false;
    const opacities: number[] = [];
    step(2e6 + (FADE / TICKS_PER_SECOND) * 0.5e6, (t) => {
      fleet.add(
        record(t, [{ slot: 5, change: replaced ? CHANGE.none : CHANGE.entered, x: 500, kind: 1 }]),
        world,
      );
      replaced = true;
      const ghost = fleet.drawn.slice(0, fleet.count).find((b) => b.slot === -1);
      opacities.push(ghost?.opacity ?? 0);
      if (ghost !== undefined) {
        expect(ghost.east).toBeCloseTo(7, 9);
        expect(ghost.kind).toBe(0);
      }
    });
    expect(Math.max(...opacities)).toBeGreaterThan(0.8);
    expect(Math.min(...opacities.filter((o) => o > 0))).toBeLessThan(0.65);
    const fresh = fleet.drawn.find((b) => b.slot === 5);
    expect(fresh?.opacity).toBeGreaterThan(0.3);
    expect(fresh?.opacity).toBeLessThan(0.7);
    // Leaves: gone in half a second.
    step(world + 600_000, (t) => fleet.add(record(t, [{ slot: 5, change: CHANGE.left }]), world));
    expect(fleet.count).toBe(0);
  });
});
