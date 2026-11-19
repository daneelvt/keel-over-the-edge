// SPDX-License-Identifier: AGPL-3.0-only

// The Worker's letters, cut from the game's own fonts (client/src/fonts,
// each under the SIL Open Font License 1.1, no Reserved Font Name): IM Fell
// English, roman and italic, as the chart letters its names and its
// weather; IM Fell English SC and Alegreya Sans for the share picture's
// title and numbers. Each letter is kept as its outline, an SVG path in the
// font's units, with its advance, and each pair's kerning, so the map
// prints its words as shapes: an SVG shown by <img> loads no font, resvg
// is handed none, and both draw the same letters. Written to worker/gen,
// which git ignores: npm run glyphs.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as hb from 'harfbuzzjs';
import subsetFont from 'subset-font';
import type { Face } from '../src/map/letters';

const fonts = new URL('../../../client/src/fonts/', import.meta.url);
const out = new URL('../gen/', import.meta.url);

/** Every printable letter of ASCII, Latin-1's letters, and the typographer's quotes, dashes and the middle dot. */
const LETTERS = (() => {
  let s = '‘’“”–—·°′';
  for (let c = 0x20; c < 0x7f; c++) {
    s += String.fromCharCode(c);
  }
  for (let c = 0xc0; c <= 0xff; c++) {
    if (c !== 0xd7 && c !== 0xf7) {
      s += String.fromCharCode(c);
    }
  }
  return [...new Set(s)].join('');
})();

const FACES = [
  { name: 'fell', file: 'IMFellEnglish-Regular.woff2' },
  { name: 'fellItalic', file: 'IMFellEnglish-Italic.woff2' },
  { name: 'fellCaps', file: 'IMFellEnglishSC-Regular.woff2' },
  { name: 'sans', file: 'AlegreyaSans-Regular.woff2' },
  { name: 'sansMedium', file: 'AlegreyaSans-Medium.woff2' },
] as const;

/** The units an em the outlines are kept in: a 13 px letter's outline to a twentieth of a pixel. */
const EM = 256;

/** How far a simplified outline may stray from the font's, EM units: a fortieth of a pixel in a 13 px letter. */
const TOLERANCE = 0.8;

type Point = [number, number];

/** Douglas and Peucker's simplification of a closed ring: the fewest of its points within the tolerance of it. */
function simplify(ring: Point[]): Point[] {
  if (ring.length < 4) {
    return ring;
  }
  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop() as [number, number];
    const [ax, ay] = ring[a] as Point;
    const [bx, by] = ring[b] as Point;
    const len = Math.hypot(bx - ax, by - ay);
    let far = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = ring[i] as Point;
      const d =
        len === 0
          ? Math.hypot(px - ax, py - ay)
          : Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
      if (d > far) {
        far = d;
        at = i;
      }
    }
    if (far > TOLERANCE) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return ring.filter((_, i) => keep[i] === 1);
}

/**
 * An outline as harfbuzz writes it (absolute M, L, Q, C and Z in the
 * font's units) brought to EM units an em, each curve laid out in short
 * straight pieces and the whole simplified within the tolerance, then
 * written relative, each point from the last, whole units, with no space
 * a sign makes needless: a tenth of the bytes, the same letter to the eye.
 */
function compact(path: string, upem: number): string {
  const k = EM / upem;
  const rings: Point[][] = [];
  let ring: Point[] = [];
  let x = 0;
  let y = 0;
  for (const m of path.matchAll(/([MLQCZ])([^MLQCZ]*)/g)) {
    const op = m[1] ?? '';
    const v = (m[2] ?? '')
      .trim()
      .split(/[ ,]+/)
      .filter((t) => t !== '')
      .map((t) => Number(t) * k);
    if (op === 'M') {
      if (ring.length > 0) {
        rings.push(ring);
      }
      x = v[0] ?? 0;
      y = v[1] ?? 0;
      ring = [[x, y]];
    } else if (op === 'L') {
      x = v[0] ?? 0;
      y = v[1] ?? 0;
      ring.push([x, y]);
    } else if (op === 'Q' || op === 'C') {
      const pts: Point[] = [[x, y]];
      for (let i = 0; i < v.length; i += 2) {
        pts.push([v[i] ?? 0, v[i + 1] ?? 0]);
      }
      for (let s = 1; s <= 8; s++) {
        const t = s / 8;
        // De Casteljau's construction, the curve's point at t.
        let q = pts.map((p): Point => [p[0], p[1]]);
        while (q.length > 1) {
          q = q.slice(1).map((p, i): Point => {
            const o = q[i] as Point;
            return [o[0] + (p[0] - o[0]) * t, o[1] + (p[1] - o[1]) * t];
          });
        }
        ring.push(q[0] as Point);
      }
      const end = pts[pts.length - 1] as Point;
      x = end[0];
      y = end[1];
    } else if (op === 'Z') {
      rings.push(ring);
      ring = [];
    }
  }
  if (ring.length > 0) {
    rings.push(ring);
  }
  let out = '';
  let px = 0;
  let py = 0;
  const num = (n: number, first: boolean) => (first || n < 0 ? String(n) : ` ${n}`);
  for (const r of rings) {
    const pts = simplify(r).map((p): Point => [Math.round(p[0]), Math.round(p[1])]);
    pts.forEach(([qx, qy], i) => {
      if (i > 0 && qx === px && qy === py) {
        return;
      }
      out +=
        (i === 0 ? 'm' : i === 1 ? 'l' : '') +
        num(qx - px, i === 0 || i === 1) +
        num(qy - py, false);
      px = qx;
      py = qy;
    });
    out += 'z';
    // A closed ring's pen is back at its first point.
    const first = pts[0];
    if (first !== undefined) {
      px = first[0];
      py = first[1];
    }
  }
  return out;
}

mkdirSync(out, { recursive: true });
const lines = [
  '// SPDX-License-Identifier: AGPL-3.0-only',
  '// Written by worker/build/glyphs.ts from client/src/fonts (SIL Open Font License 1.1): never edit.',
  '',
  "import type { Face } from '../src/map/letters';",
  '',
];
for (const f of FACES) {
  const sfnt = await subsetFont(readFileSync(new URL(f.file, fonts)), LETTERS, {
    targetFormat: 'sfnt',
  });
  const face = new hb.Face(new hb.Blob(sfnt));
  const font = new hb.Font(face);
  const glyphs: Record<string, [number, string]> = {};
  const ids = new Map<string, number>();
  for (const ch of LETTERS) {
    const gid = font.glyph(ch.codePointAt(0) ?? 0);
    if (gid === undefined || gid === 0) {
      continue;
    }
    ids.set(ch, gid);
    glyphs[ch] = [
      Math.round((font.glyphHAdvance(gid) * EM * 10) / face.upem) / 10,
      compact(font.glyphToPath(gid), face.upem),
    ];
  }
  // Each pair's kerning: what shaping the two together takes from the first's advance.
  const kern: Record<string, number> = {};
  for (const [a, ga] of ids) {
    for (const b of ids.keys()) {
      const buffer = new hb.Buffer();
      buffer.addText(a + b);
      buffer.guessSegmentProperties();
      hb.shape(font, buffer, [new hb.Feature('liga', 0)]);
      const first = buffer.getGlyphPositions()[0];
      const k = first === undefined ? 0 : first.xAdvance - font.glyphHAdvance(ga);
      if (k !== 0) {
        kern[a + b] = Math.round((k * EM * 10) / face.upem) / 10;
      }
    }
  }
  const e = font.hExtents();
  const value: Face = {
    upem: EM,
    ascender: Math.round((e.ascender * EM) / face.upem),
    descender: Math.round((e.descender * EM) / face.upem),
    glyphs,
    kern,
  };
  lines.push(`export const ${f.name}: Face = ${JSON.stringify(value)};`);
  console.warn(
    `glyphs: ${f.name}, ${Object.keys(glyphs).length} letters, ${Object.keys(kern).length} kerned pairs`,
  );
}
writeFileSync(new URL('glyphs.gen.ts', out), `${lines.join('\n')}\n`);
