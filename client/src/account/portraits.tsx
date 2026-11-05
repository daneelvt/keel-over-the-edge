// SPDX-License-Identifier: AGPL-3.0-only

// A sailor's colour portrait in its look, wherever a sailor is named: the
// look's version's prepared pictures recoloured by the compositor
// (portrait.ts) into a canvas, scaled by CSS to the size asked for. Named
// in words for those who cannot see it, as the look's alternative text.
// The pictures are loaded when first shown, each pair once.

import './portraits.css';
import { useEffect, useRef } from 'preact/hooks';
import type { SailorArt } from '../catalog';
import { coloursOf, isMachine, type Look, type Looks, lookWords, partsOf } from '../catalog/looks';
import { loadPortrait, type PortraitColours, type PortraitFiles, paintPortrait } from './portrait';

/** Every look and version's portrait pictures, by their path under art/, as the build serves them. */
const FILES = import.meta.glob<string>(
  ['../../../art/sailors/*/*.portrait.{avif,webp}', '../../../art/sailors/*/*.portrait-mask.webp'],
  { query: '?url', import: 'default', eager: true },
);

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

/** The sizes a portrait is shown at, its width in CSS pixels: a row's, Your sailor's and the card's, the account page's. */
export type PortraitSize = 40 | 72 | 96 | 160;

/**
 * A look's portrait, size CSS pixels wide (the picture is 4:5), named by the
 * look in words. A look the catalog does not have shows nothing.
 */
export function Portrait({
  looks,
  look,
  size,
  class: className,
}: {
  looks: Looks;
  look: Look;
  size: PortraitSize;
  class?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const parts = partsOf(looks, look);
  const files = parts.version === undefined ? null : portraitFiles(parts.version.art);
  const c = coloursOf(looks, look);
  const colours: PortraitColours = isMachine(look) ? { main: c.main, skin: c.skin } : c;
  const key = `${files?.mask ?? ''} ${colours.main} ${colours.skin} ${colours.hair ?? ''}`;
  useEffect(() => {
    let live = true;
    if (files !== null) {
      void loadPortrait(files)
        .then((p) => {
          if (live && canvas.current !== null) {
            paintPortrait(canvas.current, p, colours);
          }
        })
        .catch(() => {
          // A portrait is a picture of what the words say: none is no loss.
        });
    }
    return () => {
      live = false;
    };
  }, [key]);
  return (
    <canvas
      ref={canvas}
      class={`portrait portrait-${size}${className === undefined ? '' : ` ${className}`}`}
      width={256}
      height={320}
      role="img"
      aria-label={lookWords(looks, look)}
    />
  );
}
