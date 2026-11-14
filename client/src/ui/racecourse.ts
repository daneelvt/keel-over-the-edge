// SPDX-License-Identifier: AGPL-3.0-only

// A course drawn small, in a box of its own, north up: a buoy course as
// its shape, laid square to a wind from the top of the box (the windward
// mark at the top, the start line across the foot, a triangle's wing mark
// to one side, a windward–leeward's gate above the line) with the wind's
// arrow beside it; an island course as its way, fitted to the box with
// its proportions kept. The same shape is drawn in the panels' pictures
// and on the picture shared with a race's link.

import type { CourseTold } from './raceapi';

export interface Pt {
  x: number;
  y: number;
}

/** A course's shape in a box: its legs, in order; its marks; the start line; the wind's arrow, from where it blows. */
export interface CourseShape {
  legs: Pt[];
  marks: Pt[];
  line: [Pt, Pt] | null;
  wind: [Pt, Pt] | null;
}

/** A buoy course's shape in a unit square, the wind from its top. */
function buoyUnit(shape: CourseTold['shape'], long: boolean): CourseShape {
  const windward = { x: 0.5, y: 0.1 };
  const start = { x: 0.5, y: 0.9 };
  const line: [Pt, Pt] = [
    { x: 0.36, y: 0.9 },
    { x: 0.64, y: 0.9 },
  ];
  const wind: [Pt, Pt] = [
    { x: 0.88, y: 0.08 },
    { x: 0.88, y: 0.34 },
  ];
  if (shape === 'windward-leeward') {
    const gate = { x: 0.5, y: 0.72 };
    const legs = [start, windward, gate, windward, gate];
    if (long) {
      legs.push(windward, gate);
    }
    legs.push(start);
    return {
      legs,
      marks: [windward, { x: 0.43, y: 0.72 }, { x: 0.57, y: 0.72 }],
      line,
      wind,
    };
  }
  // A triangle: up to windward, a reach out to the wing mark, a reach back
  // to the leeward mark above the line; the long one beats and runs again.
  const wing = { x: 0.12, y: 0.48 };
  const leeward = { x: 0.5, y: 0.76 };
  const legs = [start, windward, wing, leeward];
  if (long) {
    legs.push(windward, leeward);
  }
  legs.push(start);
  return { legs, marks: [windward, wing, leeward], line, wind };
}

/** An island course's way as points, north up, in its own metres; [] for none. */
function wayPoints(way: readonly number[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i + 1 < way.length; i += 2) {
    const x = way[i];
    const y = way[i + 1];
    if (x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y)) {
      out.push({ x, y: -y });
    }
  }
  return out;
}

/** Fits points into a w × h box with pad on every side, their proportions kept, centred. */
export function fitBox(points: readonly Pt[], w: number, h: number, pad: number): Pt[] {
  if (points.length === 0) {
    return [];
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const iw = Math.max(1, w - 2 * pad);
  const ih = Math.max(1, h - 2 * pad);
  const sw = maxX - minX;
  const sh = maxY - minY;
  const s =
    sw === 0 && sh === 0
      ? 0
      : Math.min(sw === 0 ? Infinity : iw / sw, sh === 0 ? Infinity : ih / sh);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return points.map((p) => ({ x: w / 2 + (p.x - cx) * s, y: h / 2 + (p.y - cy) * s }));
}

/** A course's shape in a w × h box, pad clear on every side. */
export function courseShape(course: CourseTold, w: number, h: number, pad = 6): CourseShape {
  if (course.kind === 'island') {
    const pts = fitBox(wayPoints(course.way ?? []), w, h, pad);
    const first = pts[0];
    return { legs: pts, marks: first === undefined ? [] : [first], line: null, wind: null };
  }
  const u = buoyUnit(course.shape, course.long === true);
  // The unit square, as large as the box allows, centred.
  const side = Math.max(1, Math.min(w, h) - 2 * pad);
  const ox = (w - side) / 2;
  const oy = (h - side) / 2;
  const at = (p: Pt): Pt => ({ x: ox + p.x * side, y: oy + p.y * side });
  return {
    legs: u.legs.map(at),
    marks: u.marks.map(at),
    line: u.line === null ? null : [at(u.line[0]), at(u.line[1])],
    wind: u.wind === null ? null : [at(u.wind[0]), at(u.wind[1])],
  };
}

/** The legs as an SVG path's data. */
export function pathData(points: readonly Pt[]): string {
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ');
}

/** A buoy course's shape in words, for a screen reader and the picture's line. */
export function shapeText(course: CourseTold): string {
  if (course.kind === 'island') {
    return 'Island course';
  }
  const shape = course.shape === 'windward-leeward' ? 'Windward–leeward' : 'Triangle';
  return `${shape}, ${course.long === true ? 'long' : 'short'}`;
}
