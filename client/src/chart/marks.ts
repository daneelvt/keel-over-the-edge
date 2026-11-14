// SPDX-License-Identifier: AGPL-3.0-only

// The chart's marks for the kinds of place and of feature: lettered on
// the chart beside each one's name, and the log's collection's glyphs for
// them.

/** The marks of the kinds of place on the chart, by their sites. */
export const PLACE_MARKS: Record<string, string> = {
  harbour: '■',
  village: '•',
  anchorage: '⚓',
  reef: '✳',
  bar: '∴',
  wreck: '⋕',
  beacon: '‡',
};

/** The marks of the kinds of feature, by the chart's symbol for each. */
export const FEATURE_MARKS: Record<string, string> = {
  cave: '◖',
  arch: '⌒',
  blowhole: '⊙',
  fall: '≋',
  spring: '◦',
  crater: '◎',
  smoke: '♨',
  ruin: '⌂',
  birds: '⋎',
};
