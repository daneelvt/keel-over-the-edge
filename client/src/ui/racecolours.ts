// SPDX-License-Identifier: AGPL-3.0-only

// The race's boats' colours, the chart's tracks' and the standings' dots.

/** Eight colours told apart by every reader (Okabe and Ito), the paper's black last. */
export const TRACK_COLOURS = [
  '#e69f00',
  '#56b4e9',
  '#009e73',
  '#d55e00',
  '#0072b2',
  '#cc79a7',
  '#b8a400',
  '#1d1d1d',
] as const;

/** A boat's colour by its race number: past eight they repeat, the place tells them apart. */
export function trackColour(number: number): string {
  return TRACK_COLOURS[(Math.max(1, number) - 1) % TRACK_COLOURS.length] ?? TRACK_COLOURS[0];
}
