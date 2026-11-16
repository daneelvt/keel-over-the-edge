// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { drawMapOf, markResting, RESTING } from '../src/map/draw';
import { seed1 } from './seed';

/** The status's island names a whole-disk view letters: rank 3 and up. */
function lettered(s: ReturnType<typeof seed1>): string[] {
  return s.map.islands.name.filter((_, i) => (s.map.islands.rank[i] ?? 0) >= 3);
}

describe('the map holds only what the status holds', () => {
  test('every charted island it is given, and nothing else', () => {
    const s = seed1();
    const { drawn } = drawMapOf({ status: s, resting: false });
    const coasts = s.map.islands.name.filter((_, i) => (s.map.islands.coast[i]?.length ?? 0) > 0);
    const rocks = s.map.islands.name.filter((_, i) => (s.map.islands.coast[i]?.length ?? 0) === 0);
    expect(drawn.coasts).toEqual(coasts);
    expect(drawn.rocks).toEqual(rocks);
    for (const n of drawn.names) {
      expect(lettered(s)).toContain(n);
    }
    expect(drawn.names.length).toBeGreaterThan(5);
    expect(drawn.boats).toBe(s.map.boats.length);
    expect(drawn.systems).toBe(s.map.weather.systems.length);
    expect(drawn.fronts).toBe(s.map.weather.fronts.length);
  });

  test('an island left uncharted leaves no shape, name or trace', () => {
    const s = seed1();
    const full = drawMapOf({ status: s, resting: false });
    // Take the great island lettered first after the main port's out of every table.
    const gone = full.drawn.names[1] ?? '';
    const i = s.map.islands.name.indexOf(gone);
    expect(i).toBeGreaterThan(0);
    for (const k of ['name', 'east', 'north', 'rank', 'coast'] as const) {
      s.map.islands[k].splice(i, 1);
    }
    const less = drawMapOf({ status: s, resting: false });
    expect(less.drawn.names).not.toContain(gone);
    expect(less.drawn.coasts).not.toContain(gone);
    expect(less.drawn.coasts.length).toBe(full.drawn.coasts.length - 1);
    expect(less.svg.length).toBeLessThan(full.svg.length);
  });

  test('a world charted by no one shows sea and weather alone', () => {
    const s = seed1();
    s.map.islands = { name: [], east: [], north: [], rank: [], coast: [] };
    s.map.places = { name: [], kind: [], east: [], north: [], rank: [] };
    s.map.features = { kind: [], east: [], north: [] };
    s.map.boats = [];
    const { svg, drawn } = drawMapOf({ status: s, resting: false });
    expect(drawn).toMatchObject({ coasts: [], rocks: [], names: [], boats: 0 });
    expect(drawn.systems).toBeGreaterThan(0);
    expect(svg).toContain('<svg');
  });

  test('with no status, a resting map with no world', () => {
    const { svg, drawn } = drawMapOf({ status: null, resting: true });
    expect(drawn).toMatchObject({ coasts: [], rocks: [], names: [], boats: 0, systems: 0, fronts: 0 });
    expect(svg).toContain(`<title>The world’s chart: ${RESTING.toLowerCase()}</title>`);
  });
});

describe('the map as a picture', () => {
  test('an SVG an <img> shows whole: no script, no font or file fetched, nothing to tap', () => {
    const { svg } = drawMapOf({ status: seed1(), resting: false });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="')).toBe(true);
    for (const banned of ['<script', '<a ', '<style', '@font-face', 'url(http', 'href="http', '<image', '<foreignObject']) {
      expect(svg).not.toContain(banned);
    }
    // Its letters are its own shapes, each used where printed.
    expect(svg).toMatch(/<use href="#g[0-9a-z]+"/);
    expect(svg).toContain("<title>The world’s chart now</title>");
  });

  test('a last good map marked resting keeps its picture and says so', () => {
    const { svg } = drawMapOf({ status: seed1(), resting: false });
    const marked = markResting(svg);
    expect(marked.startsWith(svg.slice(0, svg.indexOf('<title>')))).toBe(true);
    expect(marked).toContain(`<title>The world’s chart: ${RESTING.toLowerCase()}</title>`);
    expect(marked.length).toBeGreaterThan(svg.length);
    expect(marked.endsWith('</svg>')).toBe(true);
  });

  test('of a size a page can carry', () => {
    const { svg } = drawMapOf({ status: seed1(), resting: false });
    expect(svg.length).toBeLessThan(400_000);
  });
});
