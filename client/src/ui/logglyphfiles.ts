// SPDX-License-Identifier: AGPL-3.0-only

// Where the build serves the collection's inked glyphs. The glob is in a
// .ts file of its own: in a .tsx file Vite's dependency scan reads the JSX
// as React's and fails (as portraitfiles.ts found).

/** Every inked glyph, by its path under art/: one for each kind of the sea's life and each boat. */
const INKED = import.meta.glob<string>('../../../art/glyphs/*.webp', {
  query: '?url&no-inline',
  import: 'default',
  eager: true,
});

/** An inked glyph's URL by its kind's id, or undefined. */
export function inkedGlyph(id: string): string | undefined {
  return INKED[`../../../art/glyphs/${id}.webp`];
}
