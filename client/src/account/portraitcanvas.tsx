// SPDX-License-Identifier: AGPL-3.0-only

// A portrait's canvas, given its pictures and its colours: painted by the
// compositor (portrait.ts) once the pictures are loaded, and again only
// when they or the colours change. It holds no state of its own (the
// canvas remembers what it was last asked to paint), so the approval page
// can draw it without the catalog, and a test can draw it as a function.

import './portraits.css';
import { loadPortrait, type PortraitColours, type PortraitFiles, paintPortrait } from './portrait';

/** The sizes a portrait is shown at, its width in CSS pixels: a row's, Your sailor's and the card's, the account page's. */
export type PortraitSize = 40 | 72 | 96 | 160;

/** Paints a canvas with a portrait, unless it was last asked for the same; a later ask wins. */
function paint(canvas: HTMLCanvasElement, files: PortraitFiles | null, colours: PortraitColours) {
  const asked = `${files?.mask ?? ''} ${colours.main} ${colours.skin} ${colours.hair ?? ''}`;
  if (canvas.dataset.painted === asked) {
    return;
  }
  canvas.dataset.painted = asked;
  if (files === null) {
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  void loadPortrait(files)
    .then((p) => {
      if (canvas.dataset.painted === asked) {
        paintPortrait(canvas, p, colours);
      }
    })
    .catch(() => {
      // A portrait is a picture of what the words say: none is no loss.
    });
}

/**
 * A portrait, size CSS pixels wide (the picture is 4:5), named by words;
 * or, where the words are written beside it, decorative and unnamed.
 * Files null (pictures the build has not) shows the frame alone.
 */
export function PortraitCanvas({
  files,
  colours,
  words,
  size,
  decorative = false,
  class: className,
}: {
  files: PortraitFiles | null;
  colours: PortraitColours;
  words: string;
  size: PortraitSize;
  decorative?: boolean;
  class?: string;
}) {
  return (
    <canvas
      ref={(el) => {
        if (el !== null) {
          paint(el, files, colours);
        }
      }}
      class={`portrait portrait-${size}${className === undefined ? '' : ` ${className}`}`}
      width={256}
      height={320}
      {...(decorative ? { 'aria-hidden': 'true' } : { role: 'img', 'aria-label': words })}
    />
  );
}
