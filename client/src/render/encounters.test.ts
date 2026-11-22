// SPDX-License-Identifier: AGPL-3.0-only

// A bump on the screen and the right-of-way overlay: the verdict's words
// for each Article and part, the shake a third as large under reduced
// motion, the knock louder and brighter the harder the hulls closed, and
// the overlay's choice of the boats that will come closest.

import { describe, expect, test } from 'vitest';
import { KNOCK, knockOf } from '../audio/knock';
import { catalog } from '../catalog';
import { ARTICLES, articleName, bumpLine, tackText } from '../ui/verdict';
import { ChaseCamera, SHAKE_TIME } from './camera';
import { STREAKS, streaksGeometry, wedgeOutline } from './dirtyair';
import { type Approach, approaching, type Seen } from './rightofway';

describe('a bump’s verdict', () => {
  test('names the Article and whose fault, for each Article and part', () => {
    for (const article of ['10', '11', '12', '13', '15', '16.1', '22']) {
      const rule = ARTICLES[article];
      expect(rule).toBeDefined();
      expect(bumpLine(article, 'yours')).toBe(`Bump · ${rule} (Article ${article}) · yours`);
      expect(bumpLine(article, 'theirs')).toBe(`Bump · ${rule} (Article ${article}) · theirs`);
    }
    expect(bumpLine('22', 'none')).toBe('Bump · no fault');
    expect(bumpLine('10', 'yours')).toBe(
      'Bump · port tack keeps clear of starboard (Article 10) · yours',
    );
  });

  test('numbers the Articles as the rulebook does', () => {
    expect([10, 11, 12, 13, 15, 16, 22, 0].map(articleName)).toEqual([
      '10',
      '11',
      '12',
      '13',
      '15',
      '16.1',
      '22',
      '',
    ]);
    expect(tackText(1, false)).toBe('Starboard tack');
    expect(tackText(-1, false)).toBe('Port tack');
    expect(tackText(1, true)).toBe('Tacking');
  });
});

describe('the shake', () => {
  const largest = (c: ChaseCamera): number => {
    let most = 0;
    for (let t = 0; t <= 1000 * SHAKE_TIME; t += 1) {
      most = Math.max(most, Math.abs(c.shakeAt(t)));
    }
    return most;
  };

  test('is none at all under reduced motion, and gone after its time', () => {
    const full = new ChaseCamera();
    full.shake(3, 0);
    const reduced = new ChaseCamera();
    reduced.reducedMotion = true;
    reduced.shake(3, 0);
    expect(largest(full)).toBeGreaterThan(0.05);
    expect(largest(reduced)).toBe(0);
    expect(full.shakeAt(1000 * SHAKE_TIME + 1)).toBe(0);
  });

  test('grows with the closing speed, up to its most', () => {
    const at = (closing: number): number => {
      const c = new ChaseCamera();
      c.shake(closing, 0);
      return largest(c);
    };
    expect(at(0.5)).toBeLessThan(at(2));
    expect(at(20)).toBeCloseTo(at(40), 9);
  });
});

describe('the knock', () => {
  test('is louder and brighter the harder the hulls closed, and fainter further off', () => {
    const soft = knockOf(KNOCK, 0.3, 0, 0);
    const hard = knockOf(KNOCK, 3, 0, 0);
    expect(hard.level).toBeGreaterThan(soft.level);
    expect(hard.crack).toBeGreaterThan(soft.crack);
    expect(knockOf(KNOCK, 3, 50, 0).level).toBeLessThan(hard.level);
    expect(knockOf(KNOCK, 3, 10, Math.PI / 2).pan).toBeCloseTo(1, 9);
    expect(knockOf(KNOCK, 3, 10, -Math.PI / 2).pan).toBeCloseTo(-1, 9);
  });
});

describe('the right-of-way overlay', () => {
  const o = catalog.encounters.overlay;
  const close = o.close * catalog.boats[0].lengthOverall;
  const at = (east: number, north: number, vEast = 0, vNorth = 0): Seen => ({
    east,
    north,
    heading: 0,
    heel: 0,
    boom: 0,
    mode: 0,
    vEast,
    vNorth,
  });

  test('marks the three boats that will come closest', () => {
    const own = at(0, 0, 0, 2);
    // Closest approaches, by their present motions: 10 m (not within 10 s),
    // 4.5 m, 2.7 m, 3.1 m, 10 m (following), 4.1 m, and 0 m head on.
    const others = [
      at(30, 20, -2, 0),
      at(10, 10, -1, 0),
      at(-6, 6, 1, 0),
      at(5, 3, -1, 0),
      at(0, -10, 0, 2),
      at(8, 8, -0.8, 0.2),
      at(0, 39, 0, -2),
    ];
    const out: Approach[] = [];
    approaching(own, others, others.length, o.range, o.ahead, close, o.marks, out);
    expect(out.length).toBe(o.marks);
    expect(out.map((a) => a.index)).toEqual([6, 2, 3]);
  });

  test('marks none when all pass wider than two hull lengths', () => {
    const own = at(0, 0, 0, 2);
    const others = [at(20, 0, 0, 2), at(-15, 5, 0, 1), at(0, -30, 0, 0)];
    expect(approaching(own, others, others.length, o.range, o.ahead, close, o.marks, [])).toEqual(
      [],
    );
  });
});

describe('dirty air', () => {
  test('is widest a little behind the sail and gone at the reach', () => {
    const n = catalog.encounters.shadow;
    const w = wedgeOutline(n, catalog.encounters.overlay.wedgeDeficit);
    expect(w.c[0]).toBe(0);
    expect(w.c.at(-1)).toBe(0);
    const widest = Math.max(...w.c);
    expect(widest).toBeGreaterThan(0.3);
    expect(widest).toBeLessThan(2);
  });

  test('is drawn as streaks that keep the wedge’s shape, from its sides to its middle', () => {
    const n = catalog.encounters.shadow;
    const w = wedgeOutline(n, catalog.encounters.overlay.wedgeDeficit);
    const g = streaksGeometry(w);
    const p = g.getAttribute('position');
    expect(p.count).toBeGreaterThan(STREAKS.across * 2 * (STREAKS.steps + 1));
    const slack = STREAKS.waver + STREAKS.width;
    let widest = 0;
    let left = 0;
    let right = 0;
    for (let i = 0; i < p.count; i++) {
      const s = -p.getZ(i);
      const x = p.getX(i);
      // Flat on the water, within the wedge's reach.
      expect(p.getY(i)).toBe(0);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(n.reach);
      // Within the outline, but for its wavering: the station either side of s.
      const at = (s / n.reach) * (w.s.length - 1);
      const c = Math.max(w.c[Math.floor(at)] ?? 0, w.c[Math.ceil(at)] ?? 0);
      expect(Math.abs(x)).toBeLessThanOrEqual(c + slack);
      widest = Math.max(widest, Math.abs(x));
      left = Math.min(left, x);
      right = Math.max(right, x);
    }
    // As wide as the wedge is, to both sides alike.
    expect(widest).toBeGreaterThan(Math.max(...w.c) - slack);
    expect(right + left).toBeCloseTo(0, 1);
    // Streaks, not a patch: they cover a small share of the wedge.
    const index = g.getIndex();
    let area = 0;
    for (let i = 0; index !== null && i < index.count; i += 3) {
      const [a, b, c] = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
      area +=
        0.5 *
        Math.abs(
          (p.getX(b) - p.getX(a)) * (p.getZ(c) - p.getZ(a)) -
            (p.getX(c) - p.getX(a)) * (p.getZ(b) - p.getZ(a)),
        );
    }
    let wedge = 0;
    for (let i = 0; i + 1 < w.s.length; i++) {
      wedge += ((w.c[i] ?? 0) + (w.c[i + 1] ?? 0)) * ((w.s[i + 1] ?? 0) - (w.s[i] ?? 0));
    }
    expect(area).toBeGreaterThan(0);
    expect(area / wedge).toBeLessThan(0.1);
  });
});
