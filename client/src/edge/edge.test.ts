// SPDX-License-Identifier: AGPL-3.0-only

import { DataTexture, type Node, Vector4 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { catalog } from '../catalog';
import { type Hex, hexAt, hexCentre, type Point, TILE_ACROSS, TILE_RADIUS } from '../ocean/hex';
import { SeaBand } from '../ocean/phases';
import { bandUniforms } from '../ocean/wave';
import { newPose } from '../predict/blend';
import { look } from '../render/sky';
import {
  CURTAIN_COLUMNS,
  CURTAIN_ROWS,
  type CurtainPoint,
  cellsBeyondLip,
  curtainAt,
  curtainColumns,
  curtainRows,
  Falls,
  hash01,
  MAX_SLABS,
  SLAB_REACH,
  slabAt,
} from './falls';
import { type Drain, drainSpeed, LINES_PERIOD, travelTime } from './lines';
import { edgeLook } from './mist';
import { ApproachWatch, closestLine, fadeOver, fallPose, overhang } from './over';

const NM = 1852;
const KNOT = NM / 3600;
const LIP = catalog.world.disk.radius;
const current = catalog.weather.current;
const DRAIN: Drain = {
  at: current.drainAt.map((x) => x * NM) as [number, number, number],
  speed: current.drain.map((x) => x * KNOT) as [number, number, number],
};
const FROM = catalog.world.edge.look.lines.from * KNOT;
const EDGE = catalog.world.edge.look;
const CURTAIN = EDGE.curtain;
/** The drain at the lip, m/s, as the falls take it. */
const AT_LIP = DRAIN.speed[2];

describe('the foam lines', () => {
  it('show nowhere the drain is slower than their start', () => {
    for (const r of [0, 3000, DRAIN.at[0], DRAIN.at[0] + 100]) {
      expect(drainSpeed(DRAIN, r) <= FROM).toBe(true);
      expect(travelTime(DRAIN, FROM, r)).toBe(Number.NEGATIVE_INFINITY);
    }
  });

  it('are carried at the drain’s speed: their travel time grows as 1 / u', () => {
    for (const r of [7200, 7900, 8300]) {
      const h = 0.01;
      const slope = (travelTime(DRAIN, FROM, r + h) - travelTime(DRAIN, FROM, r - h)) / (2 * h);
      expect(slope * drainSpeed(DRAIN, r), `${r} m`).toBeCloseTo(1, 4);
    }
  });

  it('a pattern of the travel time less world time moves out at the drain’s speed', () => {
    // A dash's edge, where τ(r) − t is constant, two frames apart.
    for (const r0 of [7200, 7900, 8300]) {
      const t0 = 1000;
      const dt = 1 / 60;
      const phase = travelTime(DRAIN, FROM, r0) - t0;
      // Where the same phase is a frame later, by bisection.
      let lo = r0;
      let hi = r0 + 1;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (travelTime(DRAIN, FROM, mid) - (t0 + dt) < phase) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      const speed = (lo - r0) / dt;
      expect(speed / drainSpeed(DRAIN, r0), `${r0} m`).toBeCloseTo(1, 2);
    }
  });

  it('repeat with the period world time is reduced by, so 2³¹ ticks on is the same', () => {
    // The pattern's dash index changes by whole periods of dashes.
    expect(LINES_PERIOD % 8).toBe(0);
    const t = 2 ** 31 / 30;
    const reduced = t - LINES_PERIOD * Math.floor(t / LINES_PERIOD);
    expect(reduced).toBeGreaterThanOrEqual(0);
    expect(reduced).toBeLessThan(LINES_PERIOD);
    expect(
      Math.abs((t - reduced) / LINES_PERIOD - Math.round((t - reduced) / LINES_PERIOD)),
    ).toBeLessThan(1e-9);
  });
});

describe('the slabs', () => {
  const look = catalog.world.edge.look.slabs;

  it('are drawn alike on every page: by the cell and world time alone', () => {
    const a = { age: 0, release: 0, spin: 0, gone: 0 };
    const b = { age: 0, release: 0, spin: 0, gone: 0 };
    for (const t of [0, 12.25, 3600.5, 2 ** 31 / 30]) {
      slabAt(look, 1500, -3, 1, t, a);
      slabAt(look, 1500, -3, 1, t, b);
      expect(a).toEqual(b);
    }
  });

  it('let go within the catalog’s release, once a cycle, falling until gone within its depths', () => {
    const s = { age: 0, release: 0, spin: 0, gone: 0 };
    for (let q = 1400; q < 1420; q++) {
      for (let t = 0; t < 60; t += 0.37) {
        slabAt(look, q, 2, 0, t, s);
        expect(s.release).toBeGreaterThanOrEqual(look.release[0] ?? 0);
        expect(s.release).toBeLessThanOrEqual(look.release[1] ?? 1);
        expect(s.gone).toBeGreaterThanOrEqual(look.gone[0] ?? 0);
        expect(s.gone).toBeLessThanOrEqual(look.gone[1] ?? 0);
        expect(Math.abs(s.spin)).toBeLessThanOrEqual(look.spin);
        expect(s.age).toBeGreaterThanOrEqual(0);
        expect(s.age).toBeLessThan(2 * (look.cycle[1] ?? 7));
      }
    }
    expect(hash01(3, 4)).toBe(hash01(3, 4));
  });

  it('come from the cells of the ring just beyond the lip, within reach of the camera', () => {
    const cells = cellsBeyondLip(LIP, 0.4, SLAB_REACH, []);
    expect(cells.length).toBeGreaterThan(100);
    expect(2 * cells.length).toBeLessThanOrEqual(MAX_SLABS);
    for (const c of cells) {
      const x = 1.5 * (4 / Math.sqrt(3)) * c.q;
      const y = 4 * (c.r + c.q / 2);
      const r = Math.hypot(x, y);
      expect(r).toBeGreaterThanOrEqual(LIP);
      expect(r).toBeLessThan(LIP + 4);
      const along = LIP * Math.abs(Math.atan2(x, y) - 0.4);
      expect(along).toBeLessThan(SLAB_REACH + 4);
    }
  });
});

describe('going over, drawn', () => {
  const shape = { lip: LIP, drain: 1.03, gravity: 3, tip: [0.3, 1.9] as [number, number] };

  it('a hull hanging over the lip pitches over the brink, bow first', () => {
    const p = newPose();
    p.north = LIP - 1;
    p.heading = 0;
    overhang(p, 2, LIP);
    expect(p.pitch).toBeLessThan(0);
    const inside = newPose();
    inside.north = LIP - 50;
    overhang(inside, 2, LIP);
    expect(inside.pitch).toBe(0);
    expect(inside.heel).toBe(0);
    // Lying along the lip, its port side to it: heeled to port.
    const along = newPose();
    along.north = LIP - 0.5;
    along.heading = Math.PI / 2;
    overhang(along, 2, LIP);
    expect(along.heel).toBeLessThan(0);
  });

  it('falls out and down as a slab, tipping', () => {
    const p = newPose();
    p.north = LIP + 0.01;
    fallPose(p, 2, shape);
    expect(p.north).toBeCloseTo(LIP + 0.01 + 2 * 1.03, 6);
    expect(p.heave).toBeCloseTo(-6, 6);
    expect(p.pitch).toBeCloseTo(-(0.3 + 1.9 * 2), 6);
  });

  it('fades to the mist over the third second, at once with reduced motion', () => {
    expect(fadeOver(1, false)).toBe(0);
    expect(fadeOver(2.5, false)).toBeCloseTo(0.5, 9);
    expect(fadeOver(4, false)).toBe(1);
    expect(fadeOver(0.1, true)).toBe(1);
  });
});

describe('an approach to the lip', () => {
  const band = catalog.world.disk.mist * NM;
  const clear = catalog.world.edge.clear;

  it('begins in the band and is survived clear of it, with its least distance', () => {
    const w = new ApproachWatch(LIP, band, clear);
    expect(w.follow(0, band - 10)).toBeNull();
    expect(w.approaching).toBe(false);
    expect(w.follow(0, LIP - 100)).toBeNull();
    expect(w.follow(0, LIP - 34.4)).toBeNull();
    expect(w.follow(0, band - 5)).toBeNull();
    expect(w.follow(0, band - clear - 1)).toBeCloseTo(34.4, 9);
    expect(w.approaching).toBe(false);
  });

  it('that ends over the lip is not survived', () => {
    const w = new ApproachWatch(LIP, band, clear);
    w.follow(0, LIP - 10);
    w.over();
    expect(w.follow(0, band - clear - 1)).toBeNull();
  });

  it('is told in whole metres, or under a metre', () => {
    expect(closestLine(34.4)).toBe('Closest to the edge: 34 m');
    expect(closestLine(0.3)).toBe('Closest to the edge: under a metre');
  });
});

/**
 * The top of the tile drawn over a point (east, north) of a flat sea near
 * the lip, m, as lip.ts tips and sags it, or null where no tile is drawn:
 * its centre is at or beyond the lip.
 */
function tileTop(east: number, north: number): number | null {
  const h: Hex = { q: 0, r: 0 };
  const c: Point = { x: 0, y: 0 };
  hexAt(east, north, h);
  hexCentre(h.q, h.r, c);
  const r = Math.hypot(c.x, c.y);
  if (r >= LIP) {
    return null;
  }
  const lean = Math.min(Math.max((r - (LIP - TILE_ACROSS)) / TILE_ACROSS, 0), 1);
  const outward = ((east - c.x) * c.x + (north - c.y) * c.y) / r;
  return -EDGE.lip.sag * lean - Math.tan(EDGE.lip.tip * lean) * outward;
}

describe('the falls’ curtain', () => {
  const p: CurtainPoint = { out: 0, height: 0, dOut: 0, dHeight: 0 };

  it('shows nothing of itself over the last tiles: inside the lip it runs under them', () => {
    // Along 200 m of the lip, every point of the curtain short of the brink
    // lies below the top of any tile drawn over it.
    let under = 0;
    for (let s = -100; s <= 100; s += 0.37) {
      const a = s / LIP;
      for (let t = CURTAIN.from; t <= 0; t += 0.05) {
        curtainAt(CURTAIN, AT_LIP, 0, EDGE.lip.sag, t, p);
        const r = LIP + p.out;
        const top = tileTop(r * Math.sin(a), r * Math.cos(a));
        if (top !== null) {
          expect(p.height, `${s.toFixed(2)} m along, ${t.toFixed(2)} s`).toBeLessThan(top - 0.1);
          under++;
        }
      }
    }
    expect(under).toBeGreaterThan(10_000);
  });

  it('begins far enough in that no step of the last tiles shows through to nothing', () => {
    // A tile not drawn has its centre at or beyond the lip: its corners
    // reach in no further than a tile's radius.
    curtainAt(CURTAIN, AT_LIP, 0, EDGE.lip.sag, CURTAIN.from, p);
    expect(p.out).toBeLessThanOrEqual(-TILE_RADIUS);
  });

  it('pours over from the brink: its rows from there on, and falling ever faster', () => {
    const rows = curtainRows(CURTAIN);
    expect(rows).toHaveLength(CURTAIN_ROWS);
    expect(rows[0]).toBe(CURTAIN.from);
    expect(rows[1]).toBe(0);
    expect(rows.at(-1)).toBeCloseTo(CURTAIN.to, 9);
    for (let j = 1; j < rows.length; j++) {
      expect(rows[j] ?? 0).toBeGreaterThan(rows[j - 1] ?? 0);
    }
    // Only one row is spent before the brink: it lies flat under the tiles.
    let before = Number.NaN;
    for (const t of rows.slice(1)) {
      curtainAt(CURTAIN, AT_LIP, 0.5, EDGE.lip.sag, t, p);
      if (t > 0) {
        expect(p.height).toBeLessThan(before);
        expect(p.dHeight).toBeLessThan(0);
      }
      before = p.height;
    }
  });

  it('is lit across its path: its rates are the path’s own', () => {
    const q: CurtainPoint = { out: 0, height: 0, dOut: 0, dHeight: 0 };
    const h = 1e-4;
    for (const wave of [-1.5, 0, 2]) {
      for (const t of [-3, -1, 0.3, 1, 2.5, 6, 9.5]) {
        curtainAt(CURTAIN, AT_LIP, wave, EDGE.lip.sag, t + h, q);
        const up = { ...q };
        curtainAt(CURTAIN, AT_LIP, wave, EDGE.lip.sag, t - h, q);
        curtainAt(CURTAIN, AT_LIP, wave, EDGE.lip.sag, t, p);
        expect(p.dOut, `${wave} m, ${t} s`).toBeCloseTo((up.out - q.out) / (2 * h), 4);
        expect(p.dHeight, `${wave} m, ${t} s`).toBeCloseTo((up.height - q.height) / (2 * h), 4);
      }
    }
    // Facing up at the brink, out over the drop a second after.
    curtainAt(CURTAIN, AT_LIP, 0, EDGE.lip.sag, 0, p);
    expect(Math.abs(p.dHeight)).toBeLessThan(0.1 * p.dOut);
    curtainAt(CURTAIN, AT_LIP, 0, EDGE.lip.sag, 1, p);
    expect(-p.dHeight).toBeGreaterThan(2 * p.dOut);
  });

  it('has its columns close by the eye and spans the reach', () => {
    const cols = curtainColumns(CURTAIN.reach);
    expect(cols).toHaveLength(CURTAIN_COLUMNS);
    expect(cols[0]).toBeCloseTo(-CURTAIN.reach, 6);
    expect(cols.at(-1)).toBeCloseTo(CURTAIN.reach, 6);
    const middle = Math.floor(CURTAIN_COLUMNS / 2);
    const near = (cols[middle] ?? 0) - (cols[middle - 1] ?? 0);
    const far = (cols[1] ?? 0) - (cols[0] ?? 0);
    expect(near).toBeLessThan(2);
    expect(far).toBeGreaterThan(5 * near);
  });

  it('takes the hour’s light and the mist, as the sea does', () => {
    const band = bandUniforms(new SeaBand(), [new Vector4()]);
    const falls = new Falls(band, LIP, AT_LIP, EDGE, new DataTexture());
    const material = falls.curtain.material as unknown as { colorNode: Node };
    const seen = new Set<unknown>();
    material.colorNode.traverse((n: Node) => {
      seen.add(n);
    });
    for (const [name, u] of Object.entries({
      'the main light': look.light,
      'its colour': look.lightColour,
      'the deep water': look.deep,
      'the foam’s white': look.cloud,
      'the mist': edgeLook.colour,
    })) {
      expect(seen.has(u), name).toBe(true);
    }
  });
});
