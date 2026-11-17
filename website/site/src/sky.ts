// SPDX-License-Identifier: AGPL-3.0-only

// The page's colours follow the hour at sea. The sky's hour is the game's
// own, from the time alone: the catalog's sky (shared/catalog/sky.yaml)
// counts it from one moment, the same for every world, through a day of
// its own length, noon at the centre of the disk at that moment. The page
// takes four palettes, night, dawn, day and dusk, and blends between them
// through the sky's day; each blend is one of a set of steps the build
// writes into the page's style sheet, so that the Worker, which serves the
// page, names the hour's step on the page itself and the page arrives in
// its light with no script, and the page's script moves it on.
//
// Every surface that carries words keeps them readable at every step: the
// night, dawn and dusk palettes are dark and blend into each other freely;
// day is the log's paper, and between dark and paper the words' ink changes
// at one moment, the backgrounds on either side blended toward the other
// only as far as the ink on them still reads (4.5:1 or better).

/** The catalog's sky, as much of it as the hour needs. */
export interface SkyClock {
  /** The sky's day, minutes. */
  day: number;
  /** Its first moment, seconds since 1970, noon at the disk's centre then. */
  epoch: number;
  /** The sun's angle past the centre's noon at that moment, degrees. */
  sunAtEpoch: number;
}

/** The sky's hour at the disk's centre, 0 to 24 (noon 12), at a moment, ms since 1970: as the game counts it. */
export function hourAt(ms: number, sky: SkyClock): number {
  const period = sky.day * 60;
  const t = ms / 1000 - sky.epoch;
  const frac = (((t % period) + period) % period) / period;
  return (((frac * 24 + 12 + sky.sunAtEpoch / 15) % 24) + 24) % 24;
}

export type HourName = 'night' | 'dawn' | 'day' | 'dusk';
export const HOURS: readonly HourName[] = ['night', 'dawn', 'day', 'dusk'];

/** A palette: each colour a hex, #rrggbb or #rrggbbaa. */
export interface Palette {
  /** The page's ground, at its head and at its foot, and the glow of the sky over its head. */
  ground: string;
  groundDeep: string;
  glow: string;
  /** The cases: lacquer, top and foot, framed in brass with a fine light line inside. */
  case: string;
  caseDeep: string;
  edge: string;
  line: string;
  /** Words: the ink, the faint, and the titles'. */
  ink: string;
  faint: string;
  title: string;
  /** The raised keys, top and foot, and their words. */
  key: string;
  keyDeep: string;
  keyInk: string;
  /** The ring round whatever has the keyboard's focus. */
  focus: string;
}

/** The colours that words sit on, and the words' own. */
export const GROUNDS = ['ground', 'groundDeep', 'glow', 'case', 'caseDeep'] as const;
export const INKS = ['ink', 'faint', 'title'] as const;

/** The four palettes: the instruments' lacquer and brass by night, warmer at the sun's ends of the day, the log's paper and ink by day. */
export const PALETTES: Readonly<Record<HourName, Palette>> = {
  night: {
    ground: '#0d151b',
    groundDeep: '#070c10',
    glow: '#1b2a39',
    case: '#1f2930',
    caseDeep: '#0c1217',
    edge: '#8a6524',
    line: '#f3dfa02e',
    ink: '#f2efe7',
    faint: '#aeb0ab',
    title: '#e8b450',
    key: '#34434e',
    keyDeep: '#1c262d',
    keyInk: '#f2efe7',
    focus: '#e8b450',
  },
  dawn: {
    ground: '#1c1922',
    groundDeep: '#100e14',
    glow: '#47323f',
    case: '#2d2832',
    caseDeep: '#141118',
    edge: '#9c6f4a',
    line: '#f6d9c830',
    ink: '#f6eee8',
    faint: '#bdb1ad',
    title: '#f2bf8f',
    key: '#3d3b4a',
    keyDeep: '#211f29',
    keyInk: '#f6eee8',
    focus: '#f2bf8f',
  },
  day: {
    ground: '#efe4c8',
    groundDeep: '#e5d6b1',
    glow: '#faf4e3',
    case: '#f8f1df',
    caseDeep: '#ece0c1',
    edge: '#8a6524',
    line: '#2b211826',
    ink: '#2b2118',
    faint: '#5c4c38',
    title: '#6b4612',
    key: '#34434e',
    keyDeep: '#1c262d',
    keyInk: '#f2efe7',
    focus: '#6b4612',
  },
  dusk: {
    ground: '#1d1613',
    groundDeep: '#110c0a',
    glow: '#4b2e20',
    case: '#2f241f',
    caseDeep: '#16100d',
    edge: '#a7712c',
    line: '#f3d6a030',
    ink: '#f6eddf',
    faint: '#c0ad9b',
    title: '#f0a94a',
    key: '#43362e',
    keyDeep: '#251c17',
    keyInk: '#f6eddf',
    focus: '#f0a94a',
  },
};

/** The light palettes; the rest are dark. */
const LIGHT: ReadonlySet<HourName> = new Set(['day']);

/**
 * Where each palette holds through the sky's day, by hour, in order: the
 * day's light from dawn (its sky at 6) to dusk (its sky at 18), as the
 * game's sky turns, night between; blended between one and the next.
 */
const MARKS: readonly (readonly [number, HourName])[] = [
  [0, 'night'],
  [4.6, 'night'],
  [6, 'dawn'],
  [7.6, 'day'],
  [16.4, 'day'],
  [18, 'dusk'],
  [19.4, 'night'],
  [24, 'night'],
];

/** The palettes at an hour: blended from one toward the next by t, 0 to 1. */
export function blendAt(hour: number): { from: HourName; to: HourName; t: number } {
  const h = ((hour % 24) + 24) % 24;
  for (let i = 1; i < MARKS.length; i++) {
    const [h1, to] = MARKS[i] as readonly [number, HourName];
    const [h0, from] = MARKS[i - 1] as readonly [number, HourName];
    if (h < h1) {
      return from === to ? { from, to, t: 0 } : { from, to, t: (h - h0) / (h1 - h0) };
    }
  }
  return { from: 'night', to: 'night', t: 0 };
}

/** The opening picture for an hour: the palette that leads at it. */
export function openingAt(hour: number): HourName {
  const b = blendAt(hour);
  return b.t < 0.5 ? b.from : b.to;
}

/**
 * Whether a src or srcset names only the page's own pictures: paths from
 * the site's root, never another site's address or a script.
 */
export function ownPictures(set: string): boolean {
  const urls = set.split(',').map((e) => e.trim().split(/\s+/)[0] ?? '');
  return urls.length > 0 && urls.every((u) => /^\/[\w-]+(?:[./][\w-]+)*$/.test(u));
}

/** The hours, ms of real time, apart that the page's colours step by: a fifth of the sky's hour. */
export const STEP_HOURS = 0.2;
export const STEPS = Math.round(24 / STEP_HOURS);

// Colour: hex in and out, blended in Oklab (Björn Ottosson, 2020), as CSS's
// color-mix blends by default, so a blend looks even to the eye.

type Rgba = [number, number, number, number];

function parse(hex: string): Rgba {
  const h = hex.replace('#', '');
  const n = (i: number) => Number.parseInt(h.slice(i, i + 2), 16) / 255;
  return [n(0), n(2), n(4), h.length === 8 ? n(6) : 1];
}

function hex([r, g, b, a]: Rgba): string {
  const c = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}${a < 1 ? c(a) : ''}`;
}

function linear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function gamma(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

function toOklab([r, g, b]: Rgba): [number, number, number] {
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, A, B]: [number, number, number], alpha: number): Rgba {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    alpha,
  ];
}

/** Two colours blended, t of the way from a to b, in Oklab. */
export function mix(a: string, b: string, t: number): string {
  if (t <= 0) {
    return hex(parse(a));
  }
  if (t >= 1) {
    return hex(parse(b));
  }
  const p = parse(a);
  const q = parse(b);
  const [la, aa, ba] = toOklab(p);
  const [lb, ab, bb] = toOklab(q);
  return hex(
    fromOklab(
      [la + (lb - la) * t, aa + (ab - aa) * t, ba + (bb - ba) * t],
      p[3] + (q[3] - p[3]) * t,
    ),
  );
}

/** A colour's relative luminance (WCAG 2), its alpha ignored. */
export function luminance(colour: string): number {
  const [r, g, b] = parse(colour);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** The contrast ratio of two colours (WCAG 2), 1 to 21. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The least contrast words keep on any ground, with a hair to spare over WCAG's 4.5:1. */
export const READABLE = 4.6;

/** Whether every ink of a palette reads on a colour. */
function readsOn(inks: Palette, ground: string): boolean {
  return INKS.every((k) => contrast(inks[k], ground) >= READABLE);
}

/** The palette at an hour. */
export function paletteAt(hour: number): Palette {
  return paletteOf(blendAt(hour));
}

function paletteOf({ from, to, t }: { from: HourName; to: HourName; t: number }): Palette {
  const a = PALETTES[from];
  const b = PALETTES[to];
  const out = {} as Record<keyof Palette, string>;
  for (const k of Object.keys(a) as (keyof Palette)[]) {
    out[k] = mix(a[k], b[k], t);
  }
  if (LIGHT.has(from) === LIGHT.has(to)) {
    return out;
  }
  // Between dark and light: the ink of the side the hour is nearer, and
  // the grounds drawn toward the other side's only as far as that ink
  // still reads on them.
  const near = t < 0.5 ? a : b;
  const far = t < 0.5 ? b : a;
  const toward = t < 0.5 ? t : 1 - t;
  for (const k of [...INKS, 'focus'] as const) {
    out[k] = near[k];
  }
  for (const k of GROUNDS) {
    let lo = 0;
    let hi = toward;
    if (!readsOn(near, mix(near[k], far[k], hi))) {
      for (let i = 0; i < 24; i++) {
        const m = (lo + hi) / 2;
        if (readsOn(near, mix(near[k], far[k], m))) {
          lo = m;
        } else {
          hi = m;
        }
      }
      hi = lo;
    }
    out[k] = mix(near[k], far[k], hi);
  }
  return out;
}

/** Each step's palette, by step, the same palette for steps that blend alike; and which palette each step takes. */
export interface Steps {
  palettes: Palette[];
  /** The palette of each step of the day, STEPS of them from midnight. */
  ofStep: number[];
}

let built: Steps | null = null;

/** The day's steps and their palettes. */
export function steps(): Steps {
  if (built !== null) {
    return built;
  }
  const palettes: Palette[] = [];
  const seen = new Map<string, number>();
  const ofStep: number[] = [];
  for (let i = 0; i < STEPS; i++) {
    const p = paletteAt(i * STEP_HOURS);
    const key = JSON.stringify(p);
    let n = seen.get(key);
    if (n === undefined) {
      n = palettes.length;
      palettes.push(p);
      seen.set(key, n);
    }
    ofStep.push(n);
  }
  built = { palettes, ofStep };
  return built;
}

/** The step's palette for an hour: what the page names as data-sky. */
export function skyStep(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  return steps().ofStep[Math.min(STEPS - 1, Math.floor(h / STEP_HOURS + 1e-9))] ?? 0;
}

/** A CSS custom property's name for a palette's colour: ground → --ground, groundDeep → --ground-deep. */
export function cssName(k: keyof Palette): string {
  return `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

function declarations(p: Palette): string {
  return (Object.keys(p) as (keyof Palette)[]).map((k) => `${cssName(k)}:${p[k]}`).join(';');
}

/** The style sheet of every step: the default (dusk's) on the root, then each step's by data-sky. */
export function skyCss(fallback: HourName = 'dusk'): string {
  const s = steps();
  const rules = [`:root{${declarations(PALETTES[fallback])}}`];
  s.palettes.forEach((p, i) => {
    rules.push(`:root[data-sky="${i}"]{${declarations(p)}}`);
  });
  return `${rules.join('\n')}\n`;
}

/** An hour given in a page's address (?hour=8.5), for seeing the page in another light; null for none or nonsense. */
export function hourFromQuery(query: URLSearchParams): number | null {
  const v = query.get('hour');
  if (v === null || !/^\d{1,2}(\.\d{1,3})?$/.test(v)) {
    return null;
  }
  const h = Number(v);
  return h >= 0 && h < 24 ? h : null;
}
