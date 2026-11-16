// SPDX-License-Identifier: AGPL-3.0-only

// The pictures the page shows are those pictures.ts names, encoded as the
// manifest says: every pick a take the script can take again, every file
// there at its size, the opening within its budgets for each hour at sea,
// and the game's art it names in the repository.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { contrast, LICENCE, luminance } from './encode.ts';
import { DEFAULT_HOUR, pictures } from './pictures.ts';
import { takes } from './takes.ts';

const root = join(import.meta.dirname, '..', '..');
const out = join(root, 'art', 'website');

interface Encoded {
  width: number;
  height: number;
  file: string;
  bytes: number;
}
interface Manifest {
  licence: string;
  pictures: Record<
    string,
    {
      alt: string;
      take: string;
      width: number;
      height: number;
      hour?: string;
      frame?: string;
      files: { avif: Encoded[]; jpeg: Encoded[] };
      titleContrast?: { median: number; brightest: number; veil: number };
    }
  >;
  opening: { hours: Record<string, { wide: string; upright: string }>; default: string };
  groups: Record<string, string[]>;
  art: {
    watch: string[];
    machine: string[];
    medals: string[];
    boats: { name: string; aboard: number; glyph: string }[];
  };
}
const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as Manifest;

describe('the takes', () => {
  test('each has an id of its own', () => {
    const ids = takes.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  test('every picture is one of them, so it can be taken again', () => {
    const ids = new Set(takes.map((t) => t.id));
    expect(pictures.filter((p) => !ids.has(p.take)).map((p) => p.name)).toEqual([]);
  });
});

describe('the manifest', () => {
  test('carries the art’s licence first', () => {
    expect(Object.keys(manifest)[0]).toBe('licence');
    expect(manifest.licence).toBe(LICENCE);
  });
  test('is the pictures named, each its pick and words', () => {
    expect(Object.keys(manifest.pictures)).toEqual(pictures.map((p) => p.name));
    for (const p of pictures) {
      expect(manifest.pictures[p.name]?.take, p.name).toBe(p.take);
      expect(manifest.pictures[p.name]?.alt, p.name).toBe(p.alt);
      expect(p.alt.length, p.name).toBeGreaterThan(20);
    }
  });
  test('names every file in its folder, each there at its size', () => {
    const listed = Object.values(manifest.pictures).flatMap((p) => [
      ...p.files.avif,
      ...p.files.jpeg,
    ]);
    for (const f of listed) {
      expect(statSync(join(out, f.file)).size, f.file).toBe(f.bytes);
    }
    const files = readdirSync(out).filter((f) => f !== 'manifest.json');
    expect(files.sort()).toEqual(listed.map((f) => f.file).sort());
  });
  test('has each picture at its widths, AVIF and a JPEG fallback', () => {
    for (const p of pictures) {
      const m = manifest.pictures[p.name];
      expect(
        m?.files.avif.map((f) => f.width),
        p.name,
      ).toEqual(p.widths.filter((w) => w <= (m?.width ?? 0)));
      expect(m?.files.jpeg.length, p.name).toBeGreaterThan(0);
    }
  });
});

describe('the opening picture', () => {
  test('has a wide and an upright frame for each hour at sea, and a default hour', () => {
    expect(Object.keys(manifest.opening.hours).sort()).toEqual(['dawn', 'day', 'dusk', 'night']);
    for (const [hour, { wide, upright }] of Object.entries(manifest.opening.hours)) {
      expect(manifest.pictures[wide]?.hour).toBe(hour);
      expect(manifest.pictures[wide]?.frame).toBe('wide');
      expect(manifest.pictures[upright]?.frame).toBe('upright');
      const u = manifest.pictures[upright];
      // Upright: 4:5.
      expect((u?.width ?? 0) / (u?.height ?? 1)).toBeCloseTo(0.8, 2);
    }
    expect(manifest.opening.default).toBe(DEFAULT_HOUR);
  });
  test('is within its budgets: 120 KB on a phone, 250 KB on a desktop (AVIF)', () => {
    for (const { wide, upright } of Object.values(manifest.opening.hours)) {
      for (const f of manifest.pictures[upright]?.files.avif ?? []) {
        expect(f.bytes, f.file).toBeLessThanOrEqual(120_000);
      }
      for (const f of manifest.pictures[wide]?.files.avif ?? []) {
        expect(f.bytes, f.file).toBeLessThanOrEqual(250_000);
      }
    }
  });
  test('says how its title reads over each wide frame’s lower left', () => {
    for (const { wide } of Object.values(manifest.opening.hours)) {
      const c = manifest.pictures[wide]?.titleContrast;
      expect(c, wide).toBeDefined();
      // A veil that brings the brightest tenth to 4.5:1 is always found.
      expect(c?.veil ?? 1, wide).toBeLessThan(0.95);
    }
  });
});

describe('the contrast measured', () => {
  test('is WCAG’s: white on black 21:1, a grey of 0.18 against white about 4.5:1', () => {
    expect(contrast(luminance(255, 255, 255), luminance(0, 0, 0))).toBeCloseTo(21, 5);
    expect(contrast(luminance(255, 255, 255), luminance(118, 118, 118))).toBeCloseTo(4.54, 2);
  });
});

describe('the game’s own art', () => {
  test('is in the repository, every boat’s glyph among it, as many aboard as the catalog says', () => {
    const catalog = JSON.parse(
      readFileSync(join(root, 'client', 'src', 'catalog', 'catalog.gen.json'), 'utf8'),
    ) as { boats: { name: string; capacity: number }[] };
    const a = manifest.art;
    for (const path of [...a.watch, ...a.machine, ...a.medals, ...a.boats.map((b) => b.glyph)]) {
      expect(existsSync(join(root, path)), path).toBe(true);
    }
    expect(a.boats.map((b) => `${b.name} ${b.aboard}`).sort()).toEqual(
      catalog.boats.map((b) => `${b.name} ${b.capacity}`).sort(),
    );
  });
});
