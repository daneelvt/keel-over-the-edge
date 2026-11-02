// SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
// Art: all rights reserved, not covered by the AGPL. See art/README.md.

// The game's icon: the Jolly boat under her cream flax sail, on the sea's
// dark slate, in the brass ring the instruments wear. Drawn as shapes in
// the ring's own measure (its outer radius 1, its centre the origin, y
// down), and rasterised here, sixteen samples a pixel, into the PNGs a
// phone asks for: the same pixels on every machine, as no renderer of SVG
// promises.

import { crc32, deflateSync, inflateSync } from 'node:zlib';

type Point = readonly [number, number];

/** A shape: its outlines, filled by the even-odd rule, and its colour. */
interface Shape {
  contours: readonly (readonly Point[])[];
  fill: string;
}

/** The slate behind the ring. */
export const SLATE = '#1a242c';
const SEA = '#22394a';
const BRASS = '#c9a24c';
const BRASS_LIGHT = '#f3dfa0';
const BRASS_DARK = '#8a6524';
const FLAX = '#efe6d2';
const SPAR = '#cc9957';
const TIMBER = '#7b4a27';
const PENNANT = '#b81f1a';

function circle(r: number, n = 256): Point[] {
  return Array.from({ length: n }, (_, i): Point => {
    const a = (2 * Math.PI * i) / n;
    return [r * Math.cos(a), r * Math.sin(a)];
  });
}

function rect(x0: number, y0: number, x1: number, y1: number): Point[] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

const ring = (r0: number, r1: number, fill: string): Shape => ({
  contours: [circle(r1), circle(r0)],
  fill,
});

/** The sail's chord at fraction v up the luff: a straight leech, bellied by its roach. */
const chord = (v: number) => 0.62 * (1 - v) + 0.13 * Math.sin(Math.PI * v) * (1 - v) ** 0.3;

const LUFF_X = -0.215;
const TACK_Y = 0.3;
const HEAD_Y = -0.64;

function sail(): Point[] {
  const leech = Array.from({ length: 33 }, (_, i): Point => {
    const v = i / 32;
    return [LUFF_X + chord(v), TACK_Y + v * (HEAD_Y - TACK_Y)];
  });
  return [[LUFF_X, TACK_Y], ...leech];
}

/** The hull side on: her transom aft under the boom's end, her stem rising forward of the mast. */
function hull(): Point[] {
  const bottom = Array.from({ length: 33 }, (_, i): Point => {
    const t = i / 32;
    return [0.46 - t * 1.04, 0.535 + 0.035 * Math.sin(Math.PI * t) - 0.145 * t ** 3];
  });
  return [[0.5, 0.42], ...bottom, [-0.6, 0.385]];
}

/** The drawing, back to front, the ring's outer radius 1. */
export const DRAWING: readonly Shape[] = [
  { contours: [circle(0.87)], fill: SEA },
  ring(0.87, 1, BRASS),
  ring(0.87, 0.905, BRASS_LIGHT),
  ring(0.965, 1, BRASS_DARK),
  { contours: [sail()], fill: FLAX },
  { contours: [rect(-0.255, -0.7, -0.215, 0.4)], fill: SPAR },
  { contours: [rect(-0.255, 0.3, 0.44, 0.34)], fill: SPAR },
  {
    contours: [
      [
        [-0.235, -0.7],
        [-0.06, -0.665],
        [-0.235, -0.63],
      ],
    ],
    fill: PENNANT,
  },
  { contours: [hull()], fill: TIMBER },
];

/** One of the icons: its size in pixels, the ring's outer radius as a fraction of it, and its corners. */
export interface Frame {
  file: string;
  size: number;
  ring: number;
  /** The slate's corners' radius as a fraction of the size: 0 for slate to the edges. */
  corner: number;
}

/**
 * The icons: Chrome's two, a corner left clear about a rounded square of
 * slate; the maskable one, slate to the edges and the ring within the
 * middle 80% that any mask keeps; and the iPhone's, slate to the edges for
 * it rounds the corners itself.
 */
export const FRAMES: readonly Frame[] = [
  { file: 'icon-192.png', size: 192, ring: 0.44, corner: 0.2 },
  { file: 'icon-512.png', size: 512, ring: 0.44, corner: 0.2 },
  { file: 'icon-maskable-512.png', size: 512, ring: 0.39, corner: 0 },
  { file: 'apple-touch-icon.png', size: 180, ring: 0.43, corner: 0 },
];

/** A square of slate with rounded corners, in pixels. */
function slate(size: number, corner: number): Point[] {
  if (corner === 0) {
    return rect(0, 0, size, size);
  }
  const r = corner * size;
  const out: Point[] = [];
  const centres: Point[] = [
    [size - r, r],
    [size - r, size - r],
    [r, size - r],
    [r, r],
  ];
  centres.forEach(([cx, cy], k) => {
    for (let i = 0; i <= 16; i++) {
      const a = ((k - 1 + i / 16) * Math.PI) / 2;
      out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  });
  return out;
}

const SAMPLES = 4;

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The frame's pixels, RGBA, row by row. */
export function rasterise(frame: Frame): Uint8Array {
  const { size } = frame;
  const scale = frame.ring * size;
  const shapes: Shape[] = [
    { contours: [slate(size, frame.corner)], fill: SLATE },
    ...DRAWING.map((s) => ({
      fill: s.fill,
      contours: s.contours.map((c) =>
        c.map(([x, y]): Point => [size / 2 + x * scale, size / 2 + y * scale]),
      ),
    })),
  ];
  // Each sample's shape, the topmost: 0 for none, then 1 on.
  const n = size * SAMPLES;
  const top = new Uint8Array(n * n);
  shapes.forEach((shape, k) => {
    const edges = shape.contours.flatMap((c) =>
      c.map((a, i) => [a, c[(i + 1) % c.length] as Point] as const),
    );
    for (let row = 0; row < n; row++) {
      const y = (row + 0.5) / SAMPLES;
      const xs: number[] = [];
      for (const [a, b] of edges) {
        if (a[1] <= y !== b[1] <= y) {
          xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
        }
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const from = Math.max(0, Math.ceil((xs[i] as number) * SAMPLES - 0.5));
        const to = Math.min(n, Math.ceil((xs[i + 1] as number) * SAMPLES - 0.5));
        top.fill(k + 1, row * n + from, row * n + to);
      }
    }
  });
  const fills = shapes.map((s) => rgb(s.fill));
  const out = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const k = top[(py * SAMPLES + sy) * n + px * SAMPLES + sx] as number;
          if (k > 0) {
            const c = fills[k - 1] as [number, number, number];
            r += c[0];
            g += c[1];
            b += c[2];
            a++;
          }
        }
      }
      const o = (py * size + px) * 4;
      if (a > 0) {
        // The colour of what covers the pixel, its coverage the alpha.
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round((255 * a) / (SAMPLES * SAMPLES));
      }
    }
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG of RGBA pixels, each row unfiltered. */
export function png(size: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rows.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', new Uint8Array()),
  ]);
}

/** A PNG's size and RGBA pixels, as png writes them: unfiltered rows. */
export function readPng(file: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const b = Buffer.from(file);
  if (!b.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('not a PNG');
  }
  let width = 0;
  let height = 0;
  const data: Buffer[] = [];
  for (let at = 8; at < b.length; ) {
    const length = b.readUInt32BE(at);
    const type = b.toString('latin1', at + 4, at + 8);
    const body = b.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 6) {
        throw new Error('not 8-bit RGBA');
      }
    } else if (type === 'IDAT') {
      data.push(body);
    }
    at += 12 + length;
  }
  const rows = inflateSync(Buffer.concat(data));
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const at = y * (width * 4 + 1);
    if (rows[at] !== 0) {
      throw new Error('a filtered row: not written by png');
    }
    rgba.set(rows.subarray(at + 1, at + 1 + width * 4), y * width * 4);
  }
  return { width, height, rgba };
}
