// SPDX-License-Identifier: AGPL-3.0-only

// The share picture, 1200 × 630: the world's map on its table, and beside
// it the game's name in IM Fell English SC and its three numbers in
// Alegreya Sans, as the game letters its titles and its figures. Drawn as
// SVG, every letter its own shape, and rasterised by resvg; under the
// million bytes the sites that show it take.

import { Resvg } from '@cf-wasm/resvg';
import { fellCaps, sans, sansMedium } from '../gen/glyphs.gen.ts';
import { RESTING, TABLE } from './map/draw';
import { Svg, textAt } from './map/svg';
import type { Status } from './status';

export const WIDTH = 1200;
export const HEIGHT = 630;

/** The game's own colours: its light ink, faint ink, gold and brass (client/src/ui/hud.css). */
const INK = '#f2efe7';
const FAINT = '#a9a8a3';
const GOLD = '#e8b450';
const BRASS = '#c9a24c';

/** The map's picture set inside another at (x, y), w × h px, its ids its own. */
function nest(map: string, x: number, y: number, w: number, h: number): string {
  return map.replace(
    /^<svg [^>]*?(viewBox="[^"]*")[^>]*>/,
    `<svg x="${x}" y="${y}" width="${w}" height="${h}" $1 preserveAspectRatio="xMidYMid meet">`,
  );
}

/** A count in words: "1 sailor at sea", "12 sailors at sea". */
function counted(n: number, one: string, many: string): [string, string] {
  return [n.toLocaleString('en-US'), n === 1 ? one : many];
}

/** The share picture's SVG: the map (an SVG of its own, its ids prefixed apart), the name, the numbers. */
export function shareSvg(map: string, status: Status | null, resting: boolean): string {
  const svg = new Svg('s');
  svg.raw(`<rect width="${WIDTH}" height="${HEIGHT}" fill="${TABLE}"/>`);
  const left = 56;
  const name = 64;
  svg.text(
    'Keel Over',
    { face: fellCaps, faceName: 'c', size: name, fill: GOLD },
    textAt(left, 132),
  );
  svg.text(
    'the Edge',
    { face: fellCaps, faceName: 'c', size: name, fill: GOLD },
    textAt(left, 196),
  );
  svg.raw(`<path d="M${left} 232h300" stroke="${BRASS}" stroke-width="2" opacity="0.7"/>`);
  if (status === null || resting) {
    svg.text(RESTING, { face: sansMedium, faceName: 'm', size: 34, fill: INK }, textAt(left, 300));
    svg.text('Back soon.', { face: sans, faceName: 'a', size: 26, fill: FAINT }, textAt(left, 342));
  } else {
    const rows = [
      counted(status.atSea, 'sailor at sea', 'sailors at sea'),
      counted(status.machinesAtSea, 'machine sailor at sea', 'machine sailors at sea'),
      counted(status.charted, 'place charted this week', 'places charted this week'),
    ];
    rows.forEach(([figure, words], i) => {
      const y = 316 + i * 104;
      svg.text(figure, { face: sansMedium, faceName: 'm', size: 52, fill: GOLD }, textAt(left, y));
      svg.text(words, { face: sans, faceName: 'a', size: 24, fill: INK }, textAt(left, y + 34));
    });
  }
  const mapX = 392;
  svg.raw(nest(map, mapX, 8, WIDTH - mapX - 8, HEIGHT - 16));
  return svg.toString([0, 0, WIDTH, HEIGHT], 'Keel Over the Edge: the world now');
}

/** The share picture as PNG. */
export async function sharePng(
  map: string,
  status: Status | null,
  resting: boolean,
): Promise<Uint8Array> {
  const r = await Resvg.async(shareSvg(map, status, resting), {
    fitTo: { mode: 'width', value: WIDTH },
    font: { loadSystemFonts: false },
  });
  return r.render().asPng();
}
