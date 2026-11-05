// SPDX-License-Identifier: AGPL-3.0-only

// A sailor's colour portrait in its look, wherever a sailor is named: the
// look's version's prepared pictures recoloured by the compositor
// (portrait.ts) into a canvas, scaled by CSS to the size asked for. Named
// in words for those who cannot see it, as the look's alternative text.
// The pictures are loaded when first shown, each pair once. And the inked
// portrait, the look and version's drawing as the log shows it.

import type { SailorArt } from '../catalog';
import { coloursOf, isMachine, type Look, type Looks, lookWords, partsOf } from '../catalog/looks';
import type { PortraitColours, PortraitFiles } from './portrait';
import { PortraitCanvas, type PortraitSize } from './portraitcanvas';

export type { PortraitSize } from './portraitcanvas';

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

/**
 * A look's portrait, size CSS pixels wide (the picture is 4:5), named by the
 * look in words, or decorative where the words are beside it. A look the
 * catalog does not have shows the frame alone.
 */
export function Portrait({
  looks,
  look,
  size,
  decorative = false,
  class: className,
}: {
  looks: Looks;
  look: Look;
  size: PortraitSize;
  decorative?: boolean;
  class?: string;
}) {
  const version = partsOf(looks, look).version;
  const c = coloursOf(looks, look);
  const colours: PortraitColours = isMachine(look) ? { main: c.main, skin: c.skin } : c;
  return (
    <PortraitCanvas
      files={version === undefined ? null : portraitFiles(version.art)}
      colours={colours}
      words={lookWords(looks, look)}
      size={size}
      decorative={decorative}
      {...(className === undefined ? {} : { class: className })}
    />
  );
}

/**
 * A look's inked portrait, as the log shows it, 128 CSS pixels wide, named
 * by the look in words and labelled In the log; nothing for a look the
 * catalog or the build has not.
 */
export function InkPortrait({ looks, look }: { looks: Looks; look: Look }) {
  const version = partsOf(looks, look).version;
  const src = version === undefined ? null : inkFile(version.art);
  return src === null ? null : (
    <figure class="portrait-ink">
      <img src={src} alt={lookWords(looks, look)} width={128} height={160} decoding="async" />
      <figcaption>In the log</figcaption>
    </figure>
  );
}
