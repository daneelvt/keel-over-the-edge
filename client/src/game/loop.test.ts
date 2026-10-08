// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { lerpAngle, newPose, StatePair } from '../predict/blend';
import { RECORDS, SIZES } from '../predict/layout.gen';
import { divisorFor, FrameCap } from './cap';
import { STEP, WorldClock } from './clock';
import { MAX_STEPS, StepLoop } from './loop';

/**
 * Runs animation frames at hz for seconds through the cap and the loop, as
 * the stage does: a frame the cap skips does nothing; a drawn one advances
 * the loop by the time since the last drawn one.
 */
function run(hz: number, seconds: number, limit = 60, cap = new FrameCap()) {
  cap.limit = limit;
  const clock = new WorldClock();
  let steps = 0;
  const loop = new StepLoop(clock, () => steps++);
  let drawn = 0;
  let lastDrawn = -1;
  const alphas: number[] = [];
  const frames = Math.round(hz * seconds);
  for (let i = 0; i <= frames; i++) {
    const now = (i * 1000) / hz;
    if (!cap.tick(now)) {
      continue;
    }
    drawn++;
    if (lastDrawn >= 0) {
      loop.advance((now - lastDrawn) / 1000);
      alphas.push(clock.alpha);
    }
    lastDrawn = now;
  }
  return { steps, drawn, alphas, clock, cap };
}

describe('the frame cap', () => {
  test.each([
    [60, 60, 1],
    [120, 60, 2],
    [90, 60, 2],
    [144, 60, 3],
    [30, 60, 1],
    [120, 30, 4],
    [60, 30, 2],
    [90, 30, 3],
    [144, 30, 5],
    [30, 30, 1],
    // Within 5% of the cap is the cap.
    [62, 60, 1],
  ])('a %d Hz display capped at %d draws every frame in %d', (hz, cap, n) => {
    expect(divisorFor(hz, cap)).toBe(n);
  });

  test.each([
    [60, 60],
    [120, 60],
    [90, 45],
    [144, 48],
    [30, 30],
  ])('at %d Hz, 10 s take exactly 300 steps and draw at %d Hz', (hz, rate) => {
    const r = run(hz, 10);
    expect(r.steps).toBe(300);
    // The first frames are drawn before the rate is known.
    expect(Math.abs(r.drawn - rate * 10)).toBeLessThanOrEqual(3);
    expect(r.cap.rate).toBeCloseTo(hz, 6);
  });

  test.each([
    [120, 30],
    [60, 30],
    [90, 30],
  ])('with the battery option a %d Hz display draws at %d Hz', (hz, rate) => {
    const r = run(hz, 10, 30);
    expect(r.steps).toBe(300);
    expect(Math.abs(r.drawn - rate * 10)).toBeLessThanOrEqual(3);
  });

  test('follows a change from 120 Hz to 30 Hz within a second', () => {
    const cap = new FrameCap();
    for (let i = 0; i < 240; i++) {
      cap.tick((i * 1000) / 120);
    }
    expect(cap.divisor).toBe(2);
    const start = 2000;
    let followed = -1;
    for (let i = 1; i <= 60; i++) {
      const now = start + (i * 1000) / 30;
      cap.tick(now);
      if (followed < 0 && cap.divisor === 1) {
        followed = now - start;
      }
    }
    expect(followed).toBeGreaterThan(0);
    expect(followed).toBeLessThan(1000);
  });

  test('a forced divisor overrides the measured one', () => {
    const cap = new FrameCap();
    cap.forced = 3;
    const drawn = [0, 1, 2, 3, 4, 5, 6].map((i) => cap.tick(i * 16));
    expect(drawn).toEqual([false, false, true, false, false, true, false]);
  });
});

describe('the step loop', () => {
  test('a 2-second stall takes 4 steps, not 60', () => {
    const clock = new WorldClock();
    let steps = 0;
    const loop = new StepLoop(clock, () => steps++);
    loop.advance(2);
    expect(steps).toBe(MAX_STEPS);
    expect(clock.steps).toBe(MAX_STEPS);
    expect(loop.accumulator).toBeLessThan(STEP);
  });

  test('alpha stays in [0, 1) at every rate', () => {
    for (const hz of [30, 60, 90, 120, 144, 47.3]) {
      for (const a of run(hz, 3).alphas) {
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThan(1);
      }
    }
  });

  test('world time is steps and alpha over 30', () => {
    const clock = new WorldClock();
    const loop = new StepLoop(clock, () => {});
    loop.advance(0.05);
    expect(clock.steps).toBe(1);
    expect(clock.time).toBeCloseTo(0.05, 12);
    clock.set(101.5);
    expect(clock.steps).toBe(3045);
    expect(clock.time).toBe(101.5);
  });

  test('pauses, steps once and runs slow', () => {
    const clock = new WorldClock();
    let steps = 0;
    const loop = new StepLoop(clock, () => steps++);
    loop.paused = true;
    loop.advance(1);
    expect(steps).toBe(0);
    loop.stepOnce();
    expect(steps).toBe(1);
    loop.paused = false;
    loop.speed = 0.25;
    for (let i = 0; i < 120; i++) {
      loop.advance(1 / 60);
    }
    // Two seconds of real time at a quarter speed: 15 steps.
    expect(steps).toBe(1 + 15);
  });
});

describe('the blend', () => {
  test('takes the short way between headings either side of ±π', () => {
    expect(lerpAngle(3.1, -3.1, 0.5)).toBeCloseTo(Math.PI, 9);
    expect(lerpAngle(-3.1, 3.1, 0.25)).toBeCloseTo(-3.1 - (2 * Math.PI - 6.2) / 4, 9);
    expect(lerpAngle(0.1, 0.3, 0.5)).toBeCloseTo(0.2, 12);
  });

  test('draws the boat between its two states', () => {
    const pair = new StatePair();
    const s = new Float64Array(SIZES.state);
    s[RECORDS.state.x] = 10;
    s[RECORDS.state.heading] = 3.1;
    s[RECORDS.state.boom] = 0.4;
    pair.hold(s);
    s[RECORDS.state.x] = 12;
    s[RECORDS.state.heading] = -3.1;
    s[RECORDS.state.boom] = 0.6;
    s[RECORDS.state.sailorMode] = 1;
    pair.push(s);
    const pose = pair.blend(0.5, newPose());
    expect(pose.east).toBe(11);
    expect(Math.abs(pose.heading)).toBeCloseTo(Math.PI, 9);
    expect(pose.boom).toBeCloseTo(0.5, 12);
    expect(pose.sailorMode).toBe(1);
    expect(pair.blend(0, pose).east).toBe(10);
  });
});
