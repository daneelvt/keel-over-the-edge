// SPDX-License-Identifier: AGPL-3.0-only

// The page's build, beside Vite's own: what the page is made from that
// lives elsewhere in the repository.
//
// - The colours of every step of the sky's day (sky.ts), written as a
//   style sheet the page imports.
// - Its fonts, the game's own (client/src/fonts, SIL Open Font License 1.1,
//   no Reserved Font Name), cut to the letters the page writes, with their
//   licences beside them.
// - Its pictures, the game's (art/website, all rights reserved), each
//   <keel-picture> and the <keel-opening> in the page written out as a
//   <picture> from the pictures' manifest, the file names with their
//   content's hash. The opening's every hour is also written into the
//   page as data (#openings), for the Worker that serves it and the page's
//   script to change the hour's picture.
// - The links that add the game to AI apps (words.ts), written into the
//   page's keys.
//
// Written to site/gen (git ignores it) before Vite reads the page, so its
// style sheets take them as their own; the pictures are put among the
// built files as they are.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import subsetFont from 'subset-font';
import type { Plugin } from 'vite';
import { skyCss } from '../src/sky.ts';
import { claudeLink, cursorLink, MCP, vscodeLink } from '../src/words.ts';

const repo = new URL('../../../', import.meta.url);
const site = new URL('../', import.meta.url);
const gen = new URL('gen/', site);
const art = new URL('art/website/', repo);
const fonts = new URL('client/src/fonts/', repo);

/** The pictures' manifest, as much of it as the page reads. */
export interface PictureFile {
  width: number;
  height: number;
  file: string;
  bytes: number;
}
export interface Picture {
  alt: string;
  width: number;
  height: number;
  files: { avif: PictureFile[]; jpeg: PictureFile[] };
}
export type Hour = 'night' | 'dawn' | 'day' | 'dusk';
export interface Manifest {
  pictures: Record<string, Picture>;
  opening: {
    hours: Record<Hour, { wide: string; upright: string }>;
    default: Hour;
    upright: string;
  };
}

export function manifest(): Manifest {
  return JSON.parse(readFileSync(new URL('manifest.json', art), 'utf8')) as Manifest;
}

/** A picture file's name among the built files: assets/<its name>-<its content's hash>.<its kind>. */
export function builtName(file: string): string {
  const hash = createHash('sha256')
    .update(readFileSync(new URL(file, art)))
    .digest('base64url')
    .slice(0, 8);
  const ext = extname(file);
  return `assets/${basename(file, ext)}-${hash}${ext}`;
}

/** The fonts, cut to the page's letters: the titles' and the log's to its own words, the rest to whatever its script may write too. */
const FACES = [
  {
    file: 'IMFellEnglishSC-Regular.woff2',
    family: 'IM Fell English SC',
    out: 'fell-sc',
    words: 'page',
  },
  {
    file: 'LibreCaslonText-Regular.woff2',
    family: 'Libre Caslon Text',
    out: 'caslon',
    words: 'page',
  },
  {
    file: 'LibreCaslonText-Italic.woff2',
    family: 'Libre Caslon Text',
    style: 'italic',
    out: 'caslon-italic',
    words: 'page',
  },
  {
    file: 'AlegreyaSans-Regular.woff2',
    family: 'Alegreya Sans',
    weight: 400,
    out: 'sans',
    words: 'all',
  },
  {
    file: 'AlegreyaSans-Medium.woff2',
    family: 'Alegreya Sans',
    weight: 500,
    out: 'sans-medium',
    words: 'all',
  },
] as const;
const LICENCES = ['OFL.txt', 'LibreCaslonText-OFL.txt', 'AlegreyaSans-OFL.txt'];

/** The page's own words, its markup taken out, with the figures and marks its numbers take. */
function pageLetters(): string {
  const html = readFileSync(new URL('index.html', site), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replaceAll('&amp;', '&');
  return `${html}0123456789–-:·.,`;
}

/**
 * Every letter the script may write besides: printable ASCII, and Latin-1's
 * letters for the dates a visitor's own language writes.
 */
function allLetters(): string {
  let s = `${pageLetters()}${readFileSync(new URL('src/words.ts', site), 'utf8')}‘’“”–—…·`;
  for (let c = 0x20; c < 0x7f; c++) {
    s += String.fromCharCode(c);
  }
  for (let c = 0xa0; c <= 0xff; c++) {
    s += String.fromCharCode(c);
  }
  return s;
}

function unique(s: string): string {
  return [...new Set(s)].filter((c) => c >= ' ').join('');
}

/** The fonts cut, and the style sheet that names them, into site/gen. */
async function cutFonts(): Promise<void> {
  mkdirSync(new URL('fonts/', gen), { recursive: true });
  const text = { page: unique(pageLetters()), all: unique(allLetters()) };
  const faces: string[] = [];
  for (const f of FACES) {
    const cut = await subsetFont(readFileSync(new URL(f.file, fonts)), text[f.words], {
      targetFormat: 'woff2',
    });
    writeFileSync(new URL(`fonts/${f.out}.woff2`, gen), cut);
    faces.push(
      `@font-face{font-family:"${f.family}";font-style:${'style' in f ? f.style : 'normal'};font-weight:${'weight' in f ? f.weight : 400};font-display:swap;src:url("./fonts/${f.out}.woff2") format("woff2")}`,
    );
  }
  writeFileSync(new URL('fonts.css', gen), `${faces.join('\n')}\n`);
}

function attr(v: string): string {
  return v.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function srcset(files: PictureFile[]): string {
  return files.map((f) => `/${builtName(f.file)} ${f.width}w`).join(', ');
}

/** The JPEG an old browser shows: the one nearest 1200 wide. */
function fallback(files: PictureFile[]): string {
  const f = [...files].sort((a, b) => Math.abs(a.width - 1200) - Math.abs(b.width - 1200))[0];
  return f === undefined ? '' : `/${builtName(f.file)}`;
}

function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-z-]+)(?:="([^"]*)")?/g)) {
    if (m[1] !== undefined && m[1] !== 'keel-picture') {
      out[m[1]] = m[2] ?? '';
    }
  }
  return out;
}

/** A picture by name, at the widths the manifest has, for a box of the sizes given. */
export function pictureHtml(
  m: Manifest,
  name: string,
  { sizes, cls, eager }: { sizes: string; cls?: string; eager?: boolean },
): string {
  const p = m.pictures[name];
  if (p === undefined) {
    throw new Error(`no picture ${name} in the manifest`);
  }
  return [
    `<picture${cls === undefined ? '' : ` class="${cls}"`}>`,
    `<source type="image/avif" srcset="${srcset(p.files.avif)}" sizes="${sizes}">`,
    `<img src="${fallback(p.files.jpeg)}" srcset="${srcset(p.files.jpeg)}" sizes="${sizes}" width="${p.width}" height="${p.height}" alt="${attr(p.alt)}"${eager === true ? '' : ' loading="lazy"'} decoding="async">`,
    '</picture>',
  ].join('');
}

/** Each hour's opening picture, as the page's elements take it: their srcset by their data-o, the fallback and the words. */
export type Openings = Record<Hour, Record<string, string>>;

export function openings(m: Manifest): Openings {
  const out = {} as Openings;
  for (const [hour, { wide, upright }] of Object.entries(m.opening.hours) as [
    Hour,
    { wide: string; upright: string },
  ][]) {
    const w = m.pictures[wide];
    const u = m.pictures[upright];
    if (w === undefined || u === undefined) {
      throw new Error(`no opening picture for ${hour}`);
    }
    out[hour] = {
      'upright avif': srcset(u.files.avif),
      'upright jpeg': srcset(u.files.jpeg),
      'wide avif': srcset(w.files.avif),
      'wide jpeg': srcset(w.files.jpeg),
      src: fallback(w.files.jpeg),
      alt: w.alt,
    };
  }
  return out;
}

/** The opening picture: upright on a phone held upright, wide else; the default hour's, which the Worker changes to the hour's. */
export function openingHtml(m: Manifest, sizes: string): string {
  const o = openings(m)[m.opening.default];
  const wide = m.pictures[m.opening.hours[m.opening.default].wide];
  if (wide === undefined) {
    throw new Error('no wide opening picture');
  }
  const media = m.opening.upright;
  return [
    '<picture class="opening-picture">',
    `<source data-o="upright avif" media="${media}" type="image/avif" srcset="${o['upright avif']}" sizes="100vw">`,
    `<source data-o="upright jpeg" media="${media}" type="image/jpeg" srcset="${o['upright jpeg']}" sizes="100vw">`,
    `<source data-o="wide avif" type="image/avif" srcset="${o['wide avif']}" sizes="${sizes}">`,
    `<img data-o="wide jpeg" src="${o.src}" srcset="${o['wide jpeg']}" sizes="${sizes}" width="${wide.width}" height="${wide.height}" alt="${attr(o.alt ?? '')}" fetchpriority="high" decoding="async">`,
    '</picture>',
  ].join('');
}

/** The page's own words with its pictures, opening and links written out. */
export function writeOut(html: string, m: Manifest): string {
  const data = JSON.stringify(openings(m)).replaceAll('<', '\\u003c');
  return html
    .replace('</head>', `<script type="application/json" id="openings">${data}</script>\n</head>`)
    .replace(/<keel-opening\s+sizes="([^"]*)"\s*><\/keel-opening>/, (_, sizes: string) =>
      openingHtml(m, sizes),
    )
    .replace(/<keel-picture\s[^>]*>\s*<\/keel-picture>/g, (tag) => {
      const a = attrsOf(tag.slice(0, tag.indexOf('>')));
      return pictureHtml(m, a.name ?? '', {
        sizes: a.sizes ?? '100vw',
        ...(a.class === undefined ? {} : { cls: a.class }),
        eager: 'eager' in a,
      });
    })
    .replace(/data-link="(claude|cursor|vscode)" href="[^"]*"/g, (_, app: string) => {
      const link = app === 'claude' ? claudeLink() : app === 'cursor' ? cursorLink() : vscodeLink();
      return `data-link="${app}" href="${attr(link)}"`;
    })
    .replaceAll('@MCP@', MCP);
}

/** Every picture file the page names. */
function pictureFiles(m: Manifest): string[] {
  return Object.values(m.pictures).flatMap((p) => [
    ...p.files.avif.map((f) => f.file),
    ...p.files.jpeg.map((f) => f.file),
  ]);
}

export function sitePlugin(): Plugin {
  const m = manifest();
  return {
    name: 'keel-site',
    async buildStart() {
      mkdirSync(gen, { recursive: true });
      writeFileSync(new URL('sky.css', gen), skyCss(m.opening.default));
      await cutFonts();
    },
    transformIndexHtml: {
      order: 'post',
      handler: (html) => writeOut(html, m),
    },
    generateBundle() {
      for (const file of pictureFiles(m)) {
        this.emitFile({
          type: 'asset',
          fileName: builtName(file),
          source: readFileSync(new URL(file, art)),
        });
      }
      for (const l of LICENCES) {
        this.emitFile({
          type: 'asset',
          fileName: `fonts/${l}`,
          source: readFileSync(new URL(l, fonts)),
        });
      }
    },
    configureServer(server) {
      // Vite's own server, for writing the page: the pictures by their built names.
      const byName = new Map(pictureFiles(m).map((f) => [`/${builtName(f)}`, f]));
      server.middlewares.use((req, res, next) => {
        const file = byName.get((req.url ?? '').split('?')[0] ?? '');
        if (file === undefined) {
          next();
          return;
        }
        res.setHeader('Content-Type', file.endsWith('.avif') ? 'image/avif' : 'image/jpeg');
        res.end(readFileSync(new URL(file, art)));
      });
    },
  };
}
