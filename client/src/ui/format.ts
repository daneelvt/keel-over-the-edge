// SPDX-License-Identifier: AGPL-3.0-only

// How the instruments write speeds, headings and winds.

/** One knot, in m/s. */
export const KNOT = 1852 / 3600;

const POINTS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
] as const;

/** A speed in m/s as knots to a tenth: "5.0". */
export function knots(ms: number): string {
  const k = Math.round((Math.max(0, ms) / KNOT) * 10) / 10;
  return k.toFixed(1);
}

/** Whole degrees clockwise from north, 0 to 359, for an angle in radians. */
export function wholeDegrees(rad: number): number {
  const d = Math.round((rad * 180) / Math.PI) % 360;
  return d < 0 ? d + 360 : d;
}

/** Three digits: "090". */
export function threeDigits(deg: number): string {
  return String(deg).padStart(3, '0');
}

/** The nearest of the 16 compass points to a direction in whole degrees: 11.25° either side of N is N. */
export function compassPoint(deg: number): string {
  const d = ((deg % 360) + 360) % 360;
  return POINTS[Math.floor((d + 11.25) / 22.5) % 16] ?? 'N';
}

/** "090° E" for a heading in radians. */
export function headingText(rad: number): string {
  const d = wholeDegrees(rad);
  return `${threeDigits(d)}° ${compassPoint(d)}`;
}

/** "10 kn N" for a wind of speed (m/s) from a direction (radians). */
export function windText(speed: number, from: number): string {
  const k = Math.round(Math.max(0, speed) / KNOT);
  return `${k} kn ${compassPoint(wholeDegrees(from))}`;
}
