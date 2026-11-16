// SPDX-License-Identifier: AGPL-3.0-only

// Encodes the pictures the page shows (pictures.ts) from their raw takes
// to art/website/: AVIF and JPEG at each of a picture's widths, and the
// manifest the page reads, manifest.json. An AVIF's quality is lowered
// until every width fits the picture's budget. For the opening pictures it
// also measures the sea behind the page's words (the lower left of a wide
// frame) against the title's light letters, as WCAG's contrast ratio.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { ART, DEFAULT_HOUR, type Picture, pictures } from './pictures.ts';

/** The art's header, the manifest's first field: art/ is all rights reserved. */
export const LICENCE =
  'SPDX-License-Identifier: LicenseRef-All-Rights-Reserved. Art: all rights reserved, not covered by the AGPL. See art/README.md.';

/** The title's letters on the opening picture: the log's paper. */
export const TITLE = '#efe4c8';
/** Where a desktop's words sit over a wide opening picture: its lower left, as shares of it. */
export const WORDS = { left: 0.04, top: 0.42, right: 0.5, bottom: 0.92 };

/** AVIF's quality: the first tried, and the least a budget may push it to. */
const AVIF_QUALITY = 60;
const AVIF_LEAST = 30;
const JPEG_QUALITY = 75;
/** The JPEGs are the fallback for the few browsers without AVIF: none wider than this. */
const JPEG_WIDEST = 1600;

export interface Encoded {
  width: number;
  height: number;
  file: string;
  bytes: number;
}

/** WCAG's relative luminance of an sRGB colour, 0 to 255 a channel. */
export function luminance(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG's contrast ratio of two luminances. */
export function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * The title's contrast over the words' part of a picture: at its middle
 * brightness and at its brightest tenth; and the least black veil over
 * that part (its opacity, laid over the picture as CSS lays one) that
 * brings the brightest tenth to 4.5:1.
 */
async function wordsContrast(
  file: string,
): Promise<{ median: number; brightest: number; veil: number }> {
  const { data, info } = await sharp(file)
    .resize({ width: 600 })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const x0 = Math.floor(info.width * WORDS.left);
  const x1 = Math.floor(info.width * WORDS.right);
  const y0 = Math.floor(info.height * WORDS.top);
  const y1 = Math.floor(info.height * WORDS.bottom);
  const title = luminance(0xef, 0xe4, 0xc8);
  /** The title's contrast over the part at a share of its brightness order, under a veil. */
  const at = (q: number, veil: number) => {
    const lums: number[] = [];
    const k = 1 - veil;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * info.width + x) * info.channels;
        lums.push(luminance((data[o] ?? 0) * k, (data[o + 1] ?? 0) * k, (data[o + 2] ?? 0) * k));
      }
    }
    lums.sort((a, b) => a - b);
    return contrast(title, lums[Math.min(lums.length - 1, Math.floor(q * lums.length))] ?? 0);
  };
  let veil = 0;
  while (veil < 0.95 && at(0.9, veil) < 4.5) {
    veil = Math.round((veil + 0.05) * 100) / 100;
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  return { median: round(at(0.5, 0)), brightest: round(at(0.9, 0)), veil };
}

/** One picture at its widths, AVIF within its budget and JPEG. */
async function encode(p: Picture, raw: string, out: string) {
  const source = join(raw, `${p.take}.png`);
  if (!existsSync(source)) {
    throw new Error(`${p.name}: no take ${p.take} in ${raw}: npm run pictures -- --only ${p.take}`);
  }
  const meta = await sharp(source).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const widths = p.widths.filter((w) => w <= width);
  const sized = (w: number) => sharp(source).resize({ width: w, kernel: 'lanczos3' });
  const tall = (w: number) => Math.round((height * w) / width);
  let quality = AVIF_QUALITY;
  let avif: { w: number; data: Buffer }[] = [];
  for (;;) {
    avif = [];
    for (const w of widths) {
      avif.push({ w, data: await sized(w).avif({ quality, effort: 6 }).toBuffer() });
    }
    const most = Math.max(...avif.map((a) => a.data.length));
    if (p.budget === undefined || most <= p.budget) {
      break;
    }
    if (quality <= AVIF_LEAST) {
      throw new Error(`${p.name}: ${most} bytes at quality ${quality}, over its ${p.budget}`);
    }
    quality -= 4;
  }
  const files: { avif: Encoded[]; jpeg: Encoded[] } = { avif: [], jpeg: [] };
  for (const { w, data } of avif) {
    const file = `${p.name}-${w}.avif`;
    writeFileSync(join(out, file), data);
    files.avif.push({ width: w, height: tall(w), file, bytes: data.length });
  }
  for (const w of widths.filter((x) => x <= JPEG_WIDEST)) {
    const data = await sized(w).jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer();
    const file = `${p.name}-${w}.jpg`;
    writeFileSync(join(out, file), data);
    files.jpeg.push({ width: w, height: tall(w), file, bytes: data.length });
  }
  const words = p.frame === 'wide' ? await wordsContrast(source) : undefined;
  return {
    alt: p.alt,
    take: p.take,
    width,
    height,
    ...(p.hour === undefined ? {} : { hour: p.hour }),
    ...(p.frame === undefined ? {} : { frame: p.frame }),
    avifQuality: quality,
    files,
    ...(words === undefined ? {} : { titleContrast: words }),
  };
}

/** The boats' glyphs, each with its name and how many it takes aboard, from the catalog. */
function boats(root: string) {
  const catalog = JSON.parse(
    readFileSync(join(root, 'client', 'src', 'catalog', 'catalog.gen.json'), 'utf8'),
  ) as { boats: { id: string; name: string; capacity: number }[] };
  return catalog.boats
    .map((b) => ({ name: b.name, aboard: b.capacity, glyph: `art/glyphs/${b.id}.webp` }))
    .sort((a, b) => a.aboard - b.aboard);
}

/** Encodes every picture into out and writes the manifest; files of pictures no longer shown go. */
export async function encodeAll(raw: string, out: string): Promise<void> {
  const root = join(out, '..', '..');
  mkdirSync(out, { recursive: true });
  const made: Record<string, Awaited<ReturnType<typeof encode>>> = {};
  for (const p of pictures) {
    const m = await encode(p, raw, out);
    made[p.name] = m;
    const largest = m.files.avif.at(-1);
    console.warn(
      `${p.name}: ${p.take}, AVIF quality ${m.avifQuality}, ${largest?.bytes} bytes at ${largest?.width} px`,
    );
  }
  const kept = new Set(
    Object.values(made).flatMap((m) => [...m.files.avif, ...m.files.jpeg].map((f) => f.file)),
  );
  for (const f of readdirSync(out)) {
    if (/\.(avif|jpg)$/.test(f) && !kept.has(f)) {
      rmSync(join(out, f));
    }
  }
  const art = { ...ART, boats: boats(root) };
  for (const path of [
    ...ART.watch,
    ...ART.machine,
    ...ART.medals,
    ...art.boats.map((b) => b.glyph),
  ]) {
    if (!existsSync(join(root, path))) {
      throw new Error(`no ${path}`);
    }
  }
  const hours = Object.fromEntries(
    pictures
      .filter((p) => p.hour !== undefined && p.frame === 'wide')
      .map((p) => [p.hour, { wide: p.name, upright: `${p.name}-upright` }]),
  );
  const manifest = {
    licence: LICENCE,
    description:
      'The website’s pictures, taken from the game by website/pictures (npm run pictures): each picture by name, with its words for those who cannot see it, its take, and its AVIF and JPEG files beside this manifest at each width; the boat at the edge for each hour at sea, wide and upright (for a phone held upright), the title’s contrast over the lower left of each wide frame (at its middle brightness, at its brightest tenth, and the black veil that brings its brightest tenth to 4.5:1); the groups the page shows them in; and the game’s own art the page shows as it is, by path from the repository’s root.',
    // Each picture by name, its files beside this manifest.
    pictures: made,
    opening: {
      // The boat at the edge for each hour at sea, wide and upright.
      hours,
      // The hour shown when the sea's is not known.
      default: DEFAULT_HOUR,
      // The upright frame is for a phone held upright, by <picture>'s media.
      upright: '(orientation: portrait) and (max-width: 700px)',
      // What titleContrast measures: the title's letters over this part of a wide frame.
      title: TITLE,
      words: WORDS,
    },
    groups: {
      race: ['race'],
      together: ['together-keelboat', 'together-yacht', 'together-tall-ship'],
      weather: ['lightning', 'storm', 'squall', 'fog'],
      out: ['out-gale', 'out-reefs', 'out-land', 'out-lagoon', 'out-stars', 'out-edge'],
    },
    // The game's own art, by path from the repository's root, used as it is.
    art,
  };
  const file = join(out, 'manifest.json');
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  // As Biome formats the repository's JSON, with the client's configuration.
  const formatted = spawnSync('npx', ['--no-install', 'biome', 'format', '--write', file], {
    cwd: join(root, 'client'),
    stdio: 'ignore',
  });
  if (formatted.status !== 0) {
    throw new Error('Biome did not format the manifest');
  }
  const bytes = readdirSync(out).reduce((n, f) => n + statSync(join(out, f)).size, 0);
  console.warn(`art/website: ${bytes} bytes in all`);
}
