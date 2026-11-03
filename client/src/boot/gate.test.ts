// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { CEILING, FRAMES, Gate, type GateParts, LAND_WAIT, SLOW_FRAME } from './gate';

/** Parts each false until set. */
function parts(): GateParts & Record<'e' | 'b' | 'v' | 'l' | 'a', boolean> {
  const p = {
    e: false,
    b: false,
    v: false,
    l: false,
    a: false,
    epoch: () => p.e,
    boat: () => p.b,
    view: () => p.v,
    land: () => p.l,
    abandoned: () => p.a,
  };
  return p;
}

describe('the gate before the world is shown', () => {
  test('no part alone lifts it; all of them, and the frames drawn, do', () => {
    for (const only of ['e', 'b', 'v', 'l'] as const) {
      const p = parts();
      p[only] = true;
      const g = new Gate(p, { start: 0, draws: true });
      expect(g.step(100)).not.toBe('ready');
    }
    const p = parts();
    const g = new Gate(p, { start: 0, draws: true });
    expect(g.step(10)).toBe('boat');
    p.b = true;
    expect(g.step(20)).toBe('boat');
    p.e = true;
    expect(g.step(30)).toBe('boat');
    p.v = true;
    expect(g.step(40)).toBe('land');
    p.l = true;
    expect(g.step(50)).toBe('sail');
    for (let i = 0; i < FRAMES - 1; i++) {
      g.drawn(12);
      expect(g.step(60 + i)).toBe('sail');
    }
    g.drawn(12);
    expect(g.step(80)).toBe('ready');
    expect(g.timedOut).toBe(false);
  });

  test('frames drawn before the frames are waited for do not count', () => {
    const p = parts();
    p.b = p.e = p.v = true;
    const g = new Gate(p, { start: 0, draws: true });
    for (let i = 0; i < FRAMES; i++) {
      g.drawn(5);
    }
    expect(g.step(10)).toBe('land');
    p.l = true;
    expect(g.step(20)).toBe('sail');
  });

  test('a slow last frame keeps it down until a quick one is drawn', () => {
    const p = parts();
    p.b = p.e = p.v = p.l = true;
    const g = new Gate(p, { start: 0, draws: true });
    expect(g.step(0)).toBe('sail');
    for (let i = 0; i < FRAMES + 2; i++) {
      g.drawn(SLOW_FRAME + 30);
    }
    expect(g.step(100)).toBe('sail');
    g.drawn(SLOW_FRAME - 1);
    expect(g.step(110)).toBe('ready');
  });

  test('the land is waited for three seconds after the boat is in, no longer', () => {
    const p = parts();
    p.e = p.v = true;
    const g = new Gate(p, { start: 0, draws: false });
    expect(g.step(2000)).toBe('boat');
    p.b = true;
    expect(g.step(2500)).toBe('land');
    expect(g.step(2500 + LAND_WAIT - 1)).toBe('land');
    expect(g.step(2500 + LAND_WAIT)).toBe('ready');
  });

  test('ten seconds after the tap it lifts on whatever has come, once there is a boat', () => {
    const p = parts();
    const g = new Gate(p, { start: 1000, draws: true });
    expect(g.step(1000 + CEILING + 5000)).toBe('boat');
    p.b = true;
    expect(g.step(1000 + CEILING + 5001)).toBe('ready');
    expect(g.timedOut).toBe(true);
  });

  test('a page that draws nothing is ready once the rest holds', () => {
    const p = parts();
    p.b = p.e = p.v = p.l = true;
    expect(new Gate(p, { start: 0, draws: false }).step(1)).toBe('ready');
  });

  test('a wait given up (a watch refused, a queue) lifts it at once', () => {
    const p = parts();
    const g = new Gate(p, { start: 0, draws: true });
    expect(g.step(1)).toBe('boat');
    p.a = true;
    expect(g.step(2)).toBe('ready');
  });
});
