// SPDX-License-Identifier: AGPL-3.0-only

// How the instruments write speeds, headings and winds, and what the
// autopilot holds.

import {
  PILOT_HEADING,
  PILOT_OFF,
  type PilotControl,
  TURN_STEPS,
  WAY_GYBE,
  WAY_TACK,
} from '../input/pilot';

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

/**
 * The wind, in knots, each Beaufort force begins at, 0 to 12 (Met Office,
 * Beaufort wind force scale).
 */
const FORCE_FROM = [0, 1, 4, 7, 11, 17, 22, 28, 34, 41, 48, 56, 64] as const;

/**
 * The Beaufort force of a mean wind in m/s, 0 to 12, by its whole knots as
 * the scale's table has them: 10 knots is force 3, 11 is force 4.
 */
export function beaufortForce(speed: number): number {
  const k = Math.round(Math.max(0, speed) / KNOT);
  let force = 0;
  for (let f = 1; f < FORCE_FROM.length; f++) {
    if (k >= (FORCE_FROM[f] as number)) {
      force = f;
    }
  }
  return force;
}

/**
 * "WSW 14 kn · F4" for a wind of speed (m/s) from a direction (radians)
 * whose mean, without its gusts, is mean (m/s): the Beaufort scale is of
 * the mean wind, so a gust raises the knots and leaves the force.
 */
export function windText(speed: number, from: number, mean: number): string {
  const k = Math.round(Math.max(0, speed) / KNOT);
  return `${compassPoint(wholeDegrees(from))} ${k} kn · F${beaufortForce(mean)}`;
}

/**
 * The autopilot's state: "Wind 45° S" holding an angle to the wind, with
 * the wind over starboard (S) or port (P); "Heading 270°"; "Tacking" or
 * "Gybing" while it turns; empty while it is off.
 */
export function pilotText(p: PilotControl, way: number): string {
  if (p.mode === PILOT_OFF) {
    return '';
  }
  if (way === WAY_TACK) {
    return 'Tacking';
  }
  if (way === WAY_GYBE) {
    return 'Gybing';
  }
  const d = Math.round((p.target / TURN_STEPS) * 360) % 360;
  if (p.mode === PILOT_HEADING) {
    return `Heading ${threeDigits(d)}°`;
  }
  const angle = d > 180 ? 360 - d : d;
  if (angle === 0 || angle === 180) {
    return `Wind ${angle}°`;
  }
  return `Wind ${angle}° ${d > 180 ? 'P' : 'S'}`;
}
