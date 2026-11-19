// SPDX-License-Identifier: AGPL-3.0-only

// An SVG picture written a piece at a time: its definitions (the letters'
// outlines, the clips) and its body, each path in the order drawn. A path
// drawn in the same ink as the one before it, under the same clip, joins
// it, so a thousand of the chart's barbs are a few elements. Letters are
// the faces' outlines, each defined once and used where printed.

import type { Face } from './letters';

/** How a path is inked: its paint, opacity, and a stroke's width, dashes, caps and joins; a fill's rule. */
export interface Ink {
  fill?: string;
  stroke?: string;
  opacity?: number;
  width?: number;
  dash?: readonly number[];
  cap?: 'butt' | 'round' | 'square';
  join?: 'miter' | 'round' | 'bevel';
  rule?: 'nonzero' | 'evenodd';
  /** A filter's id, from the definitions. */
  filter?: string;
  /** The stroke under the fill. */
  strokeUnder?: boolean;
}

/** The matrix that sets text's baseline start at (x, y) px. */
export function textAt(x: number, y: number): number[] {
  return [1, 0, 0, 1, x, y];
}

/** A number to a tenth, as short as it goes. */
export function n1(v: number): string {
  const r = Math.round(v * 10) / 10;
  return Object.is(r, -0) ? '0' : String(r);
}

/** A number to a thousandth: a matrix's terms. */
function n3(v: number): string {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}

function attrs(ink: Ink): string {
  let s = '';
  if (ink.fill !== undefined) {
    s += ` fill="${ink.fill}"`;
    if (ink.rule === 'evenodd') {
      s += ' fill-rule="evenodd"';
    }
  } else {
    s += ' fill="none"';
  }
  if (ink.stroke !== undefined) {
    s += ` stroke="${ink.stroke}" stroke-width="${n1(Math.max(ink.width ?? 1, 0.1))}"`;
    if (ink.dash !== undefined && ink.dash.length > 0) {
      s += ` stroke-dasharray="${ink.dash.map((d) => n1(Math.max(d, 0.1))).join(' ')}"`;
    }
    if (ink.cap !== undefined && ink.cap !== 'butt') {
      s += ` stroke-linecap="${ink.cap}"`;
    }
    if (ink.join !== undefined && ink.join !== 'miter') {
      s += ` stroke-linejoin="${ink.join}"`;
    }
  }
  if (ink.opacity !== undefined && ink.opacity < 0.999) {
    s += ` opacity="${n3(ink.opacity)}"`;
  }
  if (ink.strokeUnder === true) {
    s += ' paint-order="stroke"';
  }
  if (ink.filter !== undefined) {
    s += ` filter="url(#${ink.filter})"`;
  }
  return s;
}

/** What a run of letters is printed with. */
export interface Lettering {
  face: Face;
  /** Its name, for the letters' ids. */
  faceName: string;
  /** The em, px before the matrix. */
  size: number;
  fill: string;
  opacity?: number;
  /** A halo about each letter: its colour, opacity and width, px before the matrix. */
  halo?: { colour: string; opacity: number; width: number };
  /** Letter spacing, ems. */
  spacing?: number;
  /** Drawn heavier than the face: a stroke of the fill's colour this many ems wide. */
  bold?: number;
}

/** A face's advance for text, ems, its kerning and letter spacing taken in. */
export function advanceOf(face: Face, text: string, spacing = 0): number {
  let w = 0;
  const chars = [...text];
  chars.forEach((ch, i) => {
    const g = face.glyphs[ch];
    w += (g?.[0] ?? face.upem / 3) + (face.kern[ch + (chars[i + 1] ?? '')] ?? 0);
    if (i < chars.length - 1) {
      w += spacing * face.upem;
    }
  });
  return w / face.upem;
}

export class Svg {
  readonly #defs: string[] = [];
  readonly #body: string[] = [];
  /** The last path's ink, clip and data, still open for the next to join. */
  #open: { key: string; clip: string | null; d: string[] } | null = null;
  #ids = 0;
  readonly #glyphs = new Map<string, string>();
  readonly #prefix: string;

  /** A picture whose ids all begin with prefix, so it can be set inside another. */
  constructor(prefix = '') {
    this.#prefix = prefix;
  }

  /** A fresh id for a definition. */
  id(kind: string): string {
    return `${this.#prefix}${kind}${(this.#ids++).toString(36)}`;
  }

  /** A definition, written as given. */
  define(def: string): void {
    this.#defs.push(def);
  }

  /** A clip of path d, inside an outer clip if any: its id. */
  clip(d: string, rule: 'nonzero' | 'evenodd', outer: string | null): string {
    const id = this.id('c');
    const within = outer === null ? '' : ` clip-path="url(#${outer})"`;
    const r = rule === 'evenodd' ? ' clip-rule="evenodd"' : '';
    this.#defs.push(`<clipPath id="${id}"${within}><path d="${d}"${r}/></clipPath>`);
    return id;
  }

  /** A path d inked so, under a clip. */
  path(d: string, ink: Ink, clip: string | null = null): void {
    if (d === '') {
      return;
    }
    const key = attrs(ink);
    const o = this.#open;
    if (o !== null && o.key === key && o.clip === clip) {
      o.d.push(d);
      return;
    }
    this.#close();
    this.#open = { key, clip, d: [d] };
  }

  /** Raw SVG for the body, in drawing order. */
  raw(element: string): void {
    this.#close();
    this.#body.push(element);
  }

  #close(): void {
    const o = this.#open;
    if (o === null) {
      return;
    }
    this.#open = null;
    const clip = o.clip === null ? '' : ` clip-path="url(#${o.clip})"`;
    this.#body.push(`<path d="${o.d.join('')}"${o.key}${clip}/>`);
  }

  /** A letter's id, defined on its first use. */
  #glyph(faceName: string, face: Face, ch: string): string | null {
    const key = `${faceName}:${ch}`;
    let id = this.#glyphs.get(key);
    if (id === undefined) {
      const g = face.glyphs[ch];
      if (g === undefined || g[1] === '') {
        return null;
      }
      id = this.id('g');
      this.#glyphs.set(key, id);
      this.#defs.push(`<path id="${id}" d="${g[1]}"/>`);
    }
    return id;
  }

  /**
   * Prints text with its baseline's start at the origin of matrix m (a b c
   * d e f, px), which carries the text's own px: its letters in the face's
   * units, y up.
   */
  text(text: string, l: Lettering, m: readonly number[], clip: string | null = null): void {
    const face = l.face;
    const k = l.size / face.upem;
    const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = m;
    // The matrix in the face's units, y up: m × scale(k, −k).
    const mm = [a * k, b * k, -c * k, -d * k, e, f].map(n3).join(' ');
    let uses = '';
    let x = 0;
    const chars = [...text];
    chars.forEach((ch, i) => {
      const id = this.#glyph(l.faceName, face, ch);
      if (id !== null) {
        uses += `<use href="#${id}"${x === 0 ? '' : ` x="${Math.round(x)}"`}/>`;
      }
      x +=
        (face.glyphs[ch]?.[0] ?? face.upem / 3) +
        (face.kern[ch + (chars[i + 1] ?? '')] ?? 0) +
        (l.spacing ?? 0) * face.upem;
    });
    if (uses === '') {
      return;
    }
    this.#close();
    // A clip is in the space of the element it is on, its transform and
    // all: the letters' group goes inside the clipped one.
    const wrap = (g: string) => (clip === null ? g : `<g clip-path="url(#${clip})">${g}</g>`);
    const op = l.opacity !== undefined && l.opacity < 0.999 ? ` opacity="${n3(l.opacity)}"` : '';
    if (l.halo !== undefined) {
      const h = l.halo;
      const w = Math.round((h.width / k) * 10) / 10;
      const hop = h.opacity < 0.999 ? ` opacity="${n3(h.opacity)}"` : '';
      this.#body.push(
        wrap(
          `<g transform="matrix(${mm})" fill="${h.colour}" stroke="${h.colour}" stroke-width="${w}" stroke-linejoin="round"${hop}>${uses}</g>`,
        ),
      );
    }
    if (l.opacity === 0) {
      return;
    }
    const bold =
      l.bold === undefined
        ? ''
        : ` stroke="${l.fill}" stroke-width="${Math.round(l.bold * face.upem)}" stroke-linejoin="round"`;
    this.#body.push(wrap(`<g transform="matrix(${mm})" fill="${l.fill}"${bold}${op}>${uses}</g>`));
  }

  /** Its definitions and body alone, to be set inside another picture. */
  inner(): string {
    this.#close();
    return `<defs>${this.#defs.join('')}</defs>${this.#body.join('')}`;
  }

  /** The picture: a viewBox of (x, y, width, height) px, at its width and height. */
  toString(view: [number, number, number, number], title: string): string {
    this.#close();
    const [x, y, w, h] = view;
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n1(x)} ${n1(y)} ${n1(w)} ${n1(h)}" width="${Math.round(w)}" height="${Math.round(h)}" role="img">` +
      `<title>${escapeXml(title)}</title><defs>${this.#defs.join('')}</defs>${this.#body.join('')}</svg>`
    );
  }
}

/** Text safe inside an XML element or attribute. */
export function escapeXml(s: string): string {
  return s.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] ?? c,
  );
}
