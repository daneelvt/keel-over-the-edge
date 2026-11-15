// SPDX-License-Identifier: AGPL-3.0-only

// The words of a course set on the chart: its keys, its boxes, its names
// on the chart and in the sea, the compass's window, and the line read out
// for a reader who cannot see the compass. A course is a sailor's word, set
// and cleared; a point on open water is a pin.

import type { CourseOpen } from '../net/messages';
import { bearingText, distanceText } from './store';

/** The keys. */
export const SET_COURSE = 'Set course';
export const CLEAR_COURSE = 'Clear course';
export const PIN_HERE = 'Pin here';

/** A pin's name on the chart, and the head of its box. */
export const PIN = 'Pin';

/** A pin as an arrival says it: "You've reached your pin". */
export const YOUR_PIN = 'your pin';

/** A tap past the rim, in the falls. */
export const BEYOND_THE_EDGE = 'Beyond the edge.';

/** A race course's start, as its box names its kind. */
export const START_KIND = 'The start of a course';

/** A race course's start as the chart and the sea name it: "Start of Round Gull Rock". */
export function startName(c: Pick<CourseOpen, 'name'>): string {
  return `Start of ${c.name}`;
}

/** A race course's start as an arrival says it: "the start of Round Gull Rock". */
export function startReached(c: Pick<CourseOpen, 'name'>): string {
  return `the start of ${c.name}`;
}

/**
 * The compass's window: a distance's figures and its unit, apart, so the
 * unit can be set smaller: "1.2 NM" as "1.2" and "NM", "90 m" as "90" and "m".
 */
export function windowParts(text: string): { figures: string; unit: string } {
  const at = text.lastIndexOf(' ');
  return { figures: text.slice(0, at), unit: text.slice(at + 1) };
}

/** The course's tag in the sea: its name and how far, "Gull Rock · 120 m". */
export function tagText(name: string, m: number): string {
  return `${name} · ${distanceText(m)}`;
}

/** The course as read out beside the compass: "Course to Gull Rock: 045°, 1.2 NM". */
export function courseLine(name: string, bearing: number, m: number): string {
  return `Course to ${name}: ${bearingText(bearing)}, ${distanceText(m)}`;
}
