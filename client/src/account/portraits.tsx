// SPDX-License-Identifier: AGPL-3.0-only

// A sailor's colour portrait in its look, wherever a sailor is named: the
// look's version's prepared pictures recoloured by the compositor
// (portrait.ts) into a canvas, scaled by CSS to the size asked for. Named
// in words for those who cannot see it, as the look's alternative text.
// The pictures are loaded when first shown, each pair once. And the inked
// portrait, the look and version's drawing as the log shows it.

import { coloursOf, isMachine, type Look, type Looks, lookWords, partsOf } from '../catalog/looks';
import type { PortraitColours } from './portrait';
import { PortraitCanvas, type PortraitSize } from './portraitcanvas';
import { inkFile, portraitFiles } from './portraitfiles';

export type { PortraitSize } from './portraitcanvas';
export { inkFile, portraitFiles } from './portraitfiles';

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
