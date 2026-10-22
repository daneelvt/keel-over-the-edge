// SPDX-License-Identifier: AGPL-3.0-only

// The rule of a lighthouse's light on the page, as the server has it
// (internal/light): whether it shows at a moment of world time, by its
// character and phase; how bright it is at a distance, by Allard's law;
// and how charts write it. A character is its light and dark in turn, in
// milliseconds, beginning with light (IALA Recommendation E-110). A light
// shows its character's step at (t + phase) mod period, in whole
// microseconds of world time: whole numbers well inside 2^53, so the page
// agrees with the server to the microsecond, and every player sees the
// same flash at the same moment. Its tests hold it to the server's golden
// schedule.

/** A character as the catalog gives it. */
export interface Character {
  notation: string;
  class: string;
  group: string;
  colour: string;
  steps: number[];
}

/** A character's period, µs. */
export function period(steps: readonly number[]): number {
  let p = 0;
  for (const s of steps) {
    p += s;
  }
  return p * 1000;
}

/** Where in its period a light of the steps and phase given is at world time t, µs. */
export function into(steps: readonly number[], phase: number, t: number): number {
  const p = period(steps);
  if (p <= 0) {
    return 0;
  }
  return (((Math.floor(t) + phase) % p) + p) % p;
}

/** Whether a light of the steps and phase given shows at world time t, µs. */
export function lightOn(steps: readonly number[], phase: number, t: number): boolean {
  if (period(steps) <= 0) {
    return false;
  }
  let at = into(steps, phase, t);
  for (let i = 0; i < steps.length; i++) {
    const d = (steps[i] ?? 0) * 1000;
    if (at < d) {
      return i % 2 === 0;
    }
    at -= d;
  }
  return false;
}

/**
 * How much a light shows at world time t, 0 to 1. A flashing light's flash
 * (flashing, long flashing, Morse) rises and falls over rise of its length,
 * rounded as a turning lens's beam sweeps past (IALA Guideline G1116); an
 * occulting or isophase light is cut sharply by its screen.
 */
export function level(ch: Character, phase: number, t: number, rise: number): number {
  const steps = ch.steps;
  if (period(steps) <= 0) {
    return 0;
  }
  let at = into(steps, phase, t);
  for (let i = 0; i < steps.length; i++) {
    const d = (steps[i] ?? 0) * 1000;
    if (at < d) {
      if (i % 2 === 1) {
        return 0;
      }
      if (ch.class === 'Oc' || ch.class === 'Iso' || rise <= 0) {
        return 1;
      }
      const edge = rise * d;
      const u = Math.min(at / edge, (d - at) / edge, 1);
      return u * u * (3 - 2 * u);
    }
    at -= d;
  }
  return 0;
}

/**
 * The share of the way from the start of a light's latest flash to its next
 * one, 0 to 1, at world time t: what turns its beams, so that a beam faces
 * the viewer as each flash begins.
 */
export function sweep(steps: readonly number[], phase: number, t: number): number {
  const at = into(steps, phase, t);
  const starts: number[] = [];
  let s = 0;
  for (let i = 0; i < steps.length; i += 2) {
    starts.push(s);
    s += ((steps[i] ?? 0) + (steps[i + 1] ?? 0)) * 1000;
  }
  const p = period(steps);
  for (let k = starts.length - 1; k >= 0; k--) {
    const a = starts[k] ?? 0;
    if (at >= a) {
      const next = k + 1 < starts.length ? (starts[k + 1] ?? p) : p;
      return (at - a) / Math.max(next - a, 1);
    }
  }
  return 0;
}

/** A nautical mile, m. */
export const NAUTICAL_MILE = 1852;

/**
 * The air's transmissivity over a nautical mile for a visibility of v
 * nautical miles: e^(−σ × 1 mile) in air of extinction σ (IALA R0202),
 * the visibility Koschmieder's 3.912 / σ, contrast falling to 2% at it.
 */
export function transmissivity(v: number): number {
  return Math.exp(-3.912 / v);
}

/** The illuminance d m from a light of intensity i cd, in air of transmissivity t a mile: Allard's law, lux. */
export function illuminance(i: number, d: number, t: number): number {
  return d <= 0 ? Number.POSITIVE_INFINITY : (i * t ** (d / NAUTICAL_MILE)) / (d * d);
}

/** The intensity, cd, of a light whose illuminance falls to the threshold at its range r m. */
export function intensity(r: number, t: number, threshold: number): number {
  return (threshold * r * r) / t ** (r / NAUTICAL_MILE);
}

/** A light as charts write it: Fl(3) W 15s 85m 4.5M. */
export function notation(character: string, focal: number, range: number): string {
  const r = (range / NAUTICAL_MILE).toFixed(1).replace(/\.0$/, '');
  return `${character} ${Math.round(focal)}m ${r}M`;
}
