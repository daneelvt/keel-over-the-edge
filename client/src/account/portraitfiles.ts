// SPDX-License-Identifier: AGPL-3.0-only

// Where the build serves each look and version's portrait pictures: the
// colour portrait, its fallback and its mask, and the inked portrait. The
// globs are in a .ts file of their own: in a .tsx file Vite's dependency
// scan read the JSX as React's and failed, and every dev server then
// rebuilt its dependencies at once, one into another's.

import type { SailorArt } from '../catalog';
import type { PortraitFiles } from './portrait';

/** Every look and version's portrait pictures, by their path under art/, as the build serves them. */
const FILES = import.meta.glob<string>(
  ['../../../art/sailors/*/*.portrait.{avif,webp}', '../../../art/sailors/*/*.portrait-mask.webp'],
  { query: '?url&no-inline', import: 'default', eager: true },
);

/** Every look and version's inked portrait, by its path under art/. */
const INKS = import.meta.glob<string>('../../../art/sailors/*/*.ink.webp', {
  query: '?url&no-inline',
  import: 'default',
  eager: true,
});

/** A version's portrait pictures, by URL; null for one the build has not. */
export function portraitFiles(art: SailorArt): PortraitFiles | null {
  const at = (path: string) => FILES[`../../../art/${path}`];
  const base = at(art.portrait);
  const fallback = at(art.portraitFallback);
  const mask = at(art.portraitMask);
  return base === undefined || fallback === undefined || mask === undefined
    ? null
    : { base, fallback, mask };
}

/** A version's inked portrait, by URL; null for one the build has not. */
export function inkFile(art: SailorArt): string | null {
  return INKS[`../../../art/${art.ink}`] ?? null;
}
