// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { STEPS_PER_SECOND } from '../game/clock';
import { applied, type ClockState, SLEW_RATE, worldUs } from '../net/clock';
import {
  hourAt,
  moonAgeAt,
  SkyTime,
  type SkyTimeRule,
  skyFromQuery,
  skyPeriods,
  skyTimeFor,
} from './skytime';

const SKY_EPOCH = catalog.sky.epoch * 1e6;
/** The module's rule, as internal/sky has it: whole microseconds since the sky's epoch. */
const rule: SkyTimeRule = (epoch, world) => Math.floor(epoch - SKY_EPOCH) + Math.floor(world);
const periods = skyPeriods(catalog.sky);
const TICK = 1e6 / STEPS_PER_SECOND;

describe('sky time', () => {
  test('is the world’s epoch and its time, counted from the sky’s epoch', () => {
    const first = new SkyTime(rule, SKY_EPOCH);
    expect(first.at(0)).toBe(0);
    expect(first.at(30)).toBe(1e6);
    // A world made later has the same sky at the same moment.
    const weekUs = 7 * 86400e6;
    const later = new SkyTime(rule, SKY_EPOCH + weekUs);
    expect(later.at(300)).toBe(first.at(300 + weekUs / TICK));
    // Whole microseconds, whatever the fraction of a tick.
    expect(Number.isInteger(first.at(1234.567))).toBe(true);
  });

  test('a clock that slews moves the sky by no more than it moves the sea', () => {
    // The clock is 100 ms behind its estimate and moves toward it.
    const clock: ClockState = {
      have: true,
      rough: false,
      offset: 1e12,
      target: 1e12 + 100_000,
      at: 0,
      rtt: 40_000,
    };
    const sky = new SkyTime(rule, SKY_EPOCH);
    let lastWorld = worldUs(clock, 0);
    let lastSky = sky.frame(lastWorld / TICK);
    for (let now = 16_667; now < 12e6; now += 16_667) {
      const world = worldUs(clock, now);
      const t = sky.frame(world / TICK);
      // The sea is drawn at the world's time: the sky moved as far, to the microsecond.
      expect(Math.abs(t - lastSky - (world - lastWorld))).toBeLessThanOrEqual(1);
      // And neither jumped: real time, and the slew's share at most.
      expect(world - lastWorld).toBeLessThanOrEqual(16_667 * (1 + SLEW_RATE) + 1);
      lastWorld = world;
      lastSky = t;
    }
    expect(applied(clock, 12e6)).toBe(clock.target);
  });

  test('the developer’s offset and speed move the drawn sky, not the world’s', () => {
    const sky = new SkyTime(rule, SKY_EPOCH + 5e9);
    sky.set(periods.day * 3, 600);
    expect(sky.at(600)).toBe(periods.day * 3);
    expect(sky.world(600)).toBe(5e9 + 600 * TICK);
    // Sixty times faster: a second of the world is a minute of the sky.
    sky.speed = 60;
    sky.frame(600);
    expect(sky.frame(630) - periods.day * 3).toBe(60e6);
    // Held: the sky stands while the world runs.
    sky.speed = 0;
    const held = sky.frame(630);
    expect(sky.frame(660)).toBe(held);
    expect(sky.frame(690)).toBe(held);
    // A jump of the world's clock is not sixty jumps of the sky.
    sky.speed = 60;
    const before = sky.frame(690);
    // An hour of the world, and the extra of one second of it at most.
    expect(sky.frame(690 + 30 * 3600) - before).toBe(3600e6 + 59e6);
    expect(sky.world(690)).toBe(5e9 + 690 * TICK);
  });
});

describe('choosing an hour', () => {
  test('?sky names an hour and the moon’s age', () => {
    const q = (s: string) => skyFromQuery(new URLSearchParams(s));
    expect(q('')).toBeNull();
    expect(q('sky=noon')).toEqual({ hour: 12, moon: null });
    expect(q('sky=midnight,0.5')).toEqual({ hour: 0, moon: 0.5 });
    expect(q('sky=19.5,0')).toEqual({ hour: 19.5, moon: 0 });
    expect(q('sky=dusk')).toEqual({ hour: 18, moon: null });
    for (const bad of ['sky=', 'sky=teatime', 'sky=25', 'sky=-1', 'sky=noon,2', 'sky=noon,x']) {
      expect(q(bad)).toBeNull();
    }
  });

  test('a time is found for an hour and a moon', () => {
    expect(periods.day).toBe(118 * 60e6);
    expect(skyTimeFor({ hour: 12, moon: null }, periods)).toBe(0);
    expect(skyTimeFor({ hour: 18, moon: null }, periods)).toBe(periods.day / 4);
    expect(skyTimeFor({ hour: 6, moon: null }, periods)).toBe((3 * periods.day) / 4);
    expect(skyTimeFor({ hour: 12, moon: null }, periods, 1)).toBe(periods.day);
    for (const hour of [0, 3, 6, 8, 12, 17.25, 18, 23]) {
      for (const moon of [0, 0.25, 0.5, 0.75]) {
        const t = skyTimeFor({ hour, moon }, periods, 7e12);
        expect(t).toBeGreaterThanOrEqual(7e12);
        expect(Number.isInteger(t)).toBe(true);
        expect(hourAt(t, periods)).toBeCloseTo(hour, 6);
        const off = Math.abs(((moonAgeAt(t, periods) - moon + 1.5) % 1) - 0.5);
        // Within half a day of the month's 29.5.
        expect(off).toBeLessThanOrEqual(0.5 / catalog.sky.month + 1e-9);
      }
    }
  });
});
