// SPDX-License-Identifier: AGPL-3.0-only

/** A face's letters, as worker/build/glyphs.ts cuts them from the game's fonts. */
export interface Face {
  upem: number;
  ascender: number;
  descender: number;
  /** Each letter's advance and outline, an SVG path in the font's units, y up. */
  glyphs: Record<string, [number, string]>;
  /** Each pair's kerning, font units added to the first's advance. */
  kern: Record<string, number>;
}
