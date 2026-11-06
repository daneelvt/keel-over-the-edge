// SPDX-License-Identifier: AGPL-3.0-only

// The approval page's portraits of machine sailors: the machine look's
// versions' pictures alone, each a file of the page's (never inlined into
// its script, which is held small), recoloured by the colours of the
// server's choices. The page does not load the catalog: a version's
// pictures are found by its id, as the sailors' build names them.

import type { LookOption, MachineLooks, MachinePicture } from '../src/account/machineform';
import type { PortraitFiles } from '../src/account/portrait';
import { PortraitCanvas } from '../src/account/portraitcanvas';

/** The machine versions' portrait pictures, by their path. */
const FILES = import.meta.glob<string>(
  [
    '../../art/sailors/machine/*.portrait.{avif,webp}',
    '../../art/sailors/machine/*.portrait-mask.webp',
  ],
  { query: '?url&no-inline', import: 'default', eager: true },
);

/** A machine version's portrait pictures, by URL; null for one the build has not. */
export function machineFiles(version: string): PortraitFiles | null {
  const at = (ext: string) => FILES[`../../art/sailors/machine/${version}.${ext}`];
  const base = at('portrait.avif');
  const fallback = at('portrait.webp');
  const mask = at('portrait-mask.webp');
  return base === undefined || fallback === undefined || mask === undefined
    ? null
    : { base, fallback, mask };
}

const colourOf = (options: readonly LookOption[], id: string): string =>
  options.find((o) => o.id === id)?.colour ?? '#808080';

/** Machine looks' portraits in the server's choices' colours. */
export function machinePicture(looks: MachineLooks): MachinePicture {
  return (l, size) => (
    <PortraitCanvas
      files={machineFiles(l.version)}
      colours={{
        main: colourOf(looks.colours, l.colour),
        skin: colourOf(looks.finishes, l.finish),
      }}
      words=""
      size={size}
      decorative
    />
  );
}
