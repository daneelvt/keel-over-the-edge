// SPDX-License-Identifier: AGPL-3.0-only

// The rule of a lighthouse's fog signal on the page, as the server has it
// (internal/light): when its blasts sound, by its pattern and its light's
// phase, and which pattern each lighthouse is given. A pattern is its
// blasts and silences in turn, in milliseconds, beginning with a blast,
// written "in the same way as the phases of a light" (IHO S-12), so it
// keeps a light's schedule to the microsecond of world time. Its tests
// hold it to the server's golden schedule.

import { into, period } from './character';

/** A fog signal's pattern as the catalog gives it. */
export interface FogSignal {
  notation: string;
  device: string;
  steps: number[];
}

/** A blast: when it begins and ends, µs of world time. */
export interface Blast {
  start: number;
  end: number;
}

/**
 * Whether a fog signal of the steps and phase given is sounding a blast at
 * world time t, µs, and if so when that blast began: null for silence.
 */
export function blastAt(steps: readonly number[], phase: number, t: number): number | null {
  if (period(steps) <= 0) {
    return null;
  }
  let at = into(steps, phase, t);
  for (let i = 0; i < steps.length; i++) {
    const d = (steps[i] ?? 0) * 1000;
    if (at < d) {
      return i % 2 === 0 ? Math.floor(t) - at : null;
    }
    at -= d;
  }
  return null;
}

/** The blasts of a fog signal that begin from world time from up to to, µs, in order. */
export function blastsBetween(
  steps: readonly number[],
  phase: number,
  from: number,
  to: number,
): Blast[] {
  const p = period(steps);
  const out: Blast[] = [];
  if (p <= 0 || !(to > from)) {
    return out;
  }
  // The start of the period that from lies in.
  let base = Math.floor(from) - into(steps, phase, from);
  while (base < to) {
    let at = base;
    for (let i = 0; i < steps.length; i++) {
      const d = (steps[i] ?? 0) * 1000;
      if (i % 2 === 0 && at >= from && at < to) {
        out.push({ start: at, end: at + d });
      }
      at += d;
    }
    base += p;
  }
  return out;
}

/**
 * Gives each light, in the order given (their numbers'), a fog signal: the
 * first of the patterns of its device that no light before it within apart
 * metres has, or, where every one of them is had, the one whose nearest
 * holder is furthest. Returns each light's pattern by its index, −1 for a
 * device with none.
 */
export function assignFogSignals(
  places: readonly (readonly [number, number])[],
  devices: readonly string[],
  patterns: readonly string[],
  apart: number,
): number[] {
  const out: number[] = [];
  const apart2 = apart * apart;
  places.forEach((p, i) => {
    let best = -1;
    let bestNear = -1;
    for (let j = 0; j < patterns.length; j++) {
      if (patterns[j] !== devices[i]) {
        continue;
      }
      let near = Number.POSITIVE_INFINITY;
      for (let k = 0; k < i; k++) {
        if (out[k] !== j) {
          continue;
        }
        const q = places[k] as readonly [number, number];
        const dx = q[0] - p[0];
        const dy = q[1] - p[1];
        near = Math.min(near, dx * dx + dy * dy);
      }
      if (near > apart2) {
        best = j;
        break;
      }
      if (near > bestNear) {
        best = j;
        bestNear = near;
      }
    }
    out.push(best);
  });
  return out;
}

/** The catalog's fog signals' rule, as the assignment reads it. */
export interface FogSignalRule {
  apart: number;
  devices: { mainPort: string; port: string; edge: string; hazard: string };
}

/** The device of a light of a role (main, port, edge or hazard). */
export function deviceOf(rule: FogSignalRule, role: string): string {
  switch (role) {
    case 'main':
      return rule.devices.mainPort;
    case 'port':
      return rule.devices.port;
    case 'edge':
      return rule.devices.edge;
  }
  return rule.devices.hazard;
}
