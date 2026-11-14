// SPDX-License-Identifier: AGPL-3.0-only

// The picture a race's link is shared with, drawn by the phone on a canvas
// of its own: the course on a small chart at the left (a buoy course's
// shape with the wind's arrow, an island course's way), and at the right
// the race's name, its boats and its start, written for others anywhere
// with the zone's name. 1200 × 675, as the pictures of a watch are, made
// only on the tap and never sent to the server or kept.

import type { RaceCard } from './raceapi';
import { courseShape, type Pt, shapeText } from './racecourse';
import {
  boatsText,
  kindText,
  lengthText,
  raceShareText,
  whoText,
  zonedWhenText,
} from './racewords';
import type { Sharer } from './sharelink';

/** The picture's size. */
export const WIDTH = 1200;
export const HEIGHT = 675;

/** The chart's square at the left: its corner and side, px. */
export const CHART = { x: 48, y: 48, side: 579 };

/** The words on the picture. */
export interface PictureWords {
  title: string;
  name: string;
  boats: string;
  /** The start's line on the picture. */
  when: string;
  /** The start alone, for the text shared with it: "Saturday 4:00 PM NZDT". */
  at: string;
  lines: string[];
}

/** What the picture of a race says. */
export function pictureWords(card: RaceCard, locale?: string, zone?: string): PictureWords {
  const lines = [kindText(card.kind)];
  if (card.course.kind === 'island') {
    const len = lengthText(card.course.length ?? 0);
    lines.push(len === '' ? card.course.name : `${card.course.name}, ${len}`);
  } else {
    lines.push(shapeText(card.course));
  }
  if (card.who !== 'everyone') {
    lines.push(whoText(card.who));
  }
  const at = zonedWhenText(card.startsAt, locale, zone);
  return {
    title: 'Keel Over the Edge',
    name: card.name,
    boats: boatsText(card.boat.name),
    when: card.kind === 'trial' ? 'Open now' : `Starts ${at}`,
    at,
    lines,
  };
}

/** Breaks text into lines no wider than max, at most n, the last ended with an ellipsis if cut. */
export function wrap(
  text: string,
  max: number,
  n: number,
  measure: (s: string) => number,
): string[] {
  const words = text.split(/\s+/).filter((w) => w !== '');
  const out: string[] = [];
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    const next = line === '' ? w : `${line} ${w}`;
    if (measure(next) <= max || line === '') {
      line = next;
      continue;
    }
    out.push(line);
    line = w;
    if (out.length === n) {
      line = '';
      // Cut: the last line kept ends with an ellipsis.
      let last = out[n - 1] as string;
      while (last.length > 1 && measure(`${last}…`) > max) {
        last = last.slice(0, -1);
      }
      out[n - 1] = `${last.trimEnd()}…`;
      return out;
    }
  }
  if (line !== '') {
    out.push(line);
  }
  return out;
}

const INK = '#2a2620';
const MARK = '#e0742c';
const PAPER = '#ece3cc';

/** Draws a course's shape in ctx: the legs dashed, the marks, the line and the wind's arrow. */
export function drawCourse(
  ctx: CanvasRenderingContext2D,
  card: Pick<RaceCard, 'course'>,
  x: number,
  y: number,
  side: number,
): void {
  const s = courseShape(card.course, side, side, side * 0.1);
  const at = (p: Pt): Pt => ({ x: x + p.x, y: y + p.y });
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // The legs.
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.max(2, side / 120);
  ctx.setLineDash([side / 40, side / 60]);
  ctx.beginPath();
  s.legs.forEach((p, i) => {
    const q = at(p);
    if (i === 0) {
      ctx.moveTo(q.x, q.y);
    } else {
      ctx.lineTo(q.x, q.y);
    }
  });
  ctx.stroke();
  ctx.setLineDash([]);
  // The start line, solid, a flag at each end.
  if (s.line !== null) {
    const [a, b] = [at(s.line[0]), at(s.line[1])];
    ctx.lineWidth = Math.max(3, side / 90);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    for (const p of [a, b]) {
      ctx.fillStyle = INK;
      ctx.fillRect(p.x - 2, p.y - side / 16, 4, side / 16);
      ctx.fillStyle = MARK;
      ctx.beginPath();
      ctx.moveTo(p.x + 2, p.y - side / 16);
      ctx.lineTo(p.x + 2 + side / 28, p.y - side / 22);
      ctx.lineTo(p.x + 2, p.y - side / 36);
      ctx.fill();
    }
  }
  // The marks.
  for (const m of s.marks) {
    const q = at(m);
    ctx.fillStyle = MARK;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(q.x, q.y, Math.max(5, side / 40), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  // The wind, from the top: an arrow, and its word.
  if (s.wind !== null) {
    const [a, b] = [at(s.wind[0]), at(s.wind[1])];
    ctx.strokeStyle = '#3b6d8f';
    ctx.fillStyle = '#3b6d8f';
    ctx.lineWidth = Math.max(3, side / 80);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    const head = side / 28;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y + head * 0.4);
    ctx.lineTo(b.x - head * 0.7, b.y - head * 0.6);
    ctx.lineTo(b.x + head * 0.7, b.y - head * 0.6);
    ctx.fill();
    ctx.font = `600 ${Math.round(side / 26)}px "Alegreya Sans", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('WIND', a.x, b.y + head);
  }
  ctx.restore();
}

/** Draws the picture of a race on out, which it sizes. */
export function drawPicture(out: HTMLCanvasElement, card: RaceCard, words: PictureWords): void {
  out.width = WIDTH;
  out.height = HEIGHT;
  const ctx = out.getContext('2d');
  if (ctx === null) {
    return;
  }
  // The sea, deep blue to the foot.
  const sea = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  sea.addColorStop(0, '#1d4560');
  sea.addColorStop(1, '#0d2333');
  ctx.fillStyle = sea;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  // The chart: paper, a brass rim, a faint grid.
  const { x, y, side } = CHART;
  ctx.fillStyle = PAPER;
  ctx.beginPath();
  ctx.roundRect(x, y, side, side, 18);
  ctx.fill();
  ctx.strokeStyle = '#c9a24c';
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, side, side, 18);
  ctx.clip();
  ctx.strokeStyle = 'rgb(42 38 32 / 10%)';
  ctx.lineWidth = 1;
  for (let g = 1; g < 6; g++) {
    const d = (side * g) / 6;
    ctx.beginPath();
    ctx.moveTo(x + d, y);
    ctx.lineTo(x + d, y + side);
    ctx.moveTo(x, y + d);
    ctx.lineTo(x + side, y + d);
    ctx.stroke();
  }
  ctx.restore();
  drawCourse(ctx, card, x, y, side);
  // The words at the right.
  const left = x + side + 48;
  const max = WIDTH - left - 48;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#e8b450';
  ctx.font = '30px "IM Fell English SC", Georgia, serif';
  ctx.fillText(words.title, left, 104, max);
  ctx.fillStyle = '#f2efe7';
  ctx.font = '60px "IM Fell English SC", Georgia, serif';
  const names = wrap(words.name, max, 3, (s) => ctx.measureText(s).width);
  let top = 190;
  for (const line of names) {
    ctx.fillText(line, left, top, max);
    top += 66;
  }
  top += 14;
  ctx.font = '500 36px "Alegreya Sans", system-ui, sans-serif';
  ctx.fillText(words.boats, left, top, max);
  top += 50;
  ctx.fillStyle = '#e8b450';
  for (const line of wrap(words.when, max, 2, (s) => ctx.measureText(s).width)) {
    ctx.fillText(line, left, top, max);
    top += 46;
  }
  ctx.fillStyle = 'rgb(242 239 231 / 75%)';
  ctx.font = '400 28px "Alegreya Sans", system-ui, sans-serif';
  for (const line of words.lines) {
    if (top > HEIGHT - 48) {
      break;
    }
    ctx.fillText(line, left, top, max);
    top += 38;
  }
}

/** The file a race's picture is shared or saved as. */
export const RACE_FILE = 'keel-over-the-edge-race.jpg';

/** The picture of a race as a JPEG; null if none can be made. */
export async function racePicture(card: RaceCard, words: PictureWords): Promise<Blob | null> {
  try {
    await Promise.all([
      document.fonts.load('60px "IM Fell English SC"'),
      document.fonts.load('500 36px "Alegreya Sans"'),
    ]);
  } catch {
    // The fallbacks draw it.
  }
  const out = document.createElement('canvas');
  drawPicture(out, card, words);
  const m = await import('./snapshot');
  return m.jpeg(out);
}

/** Shares a race's link with its picture; or saves the picture and copies the link. */
export async function shareRace(
  card: RaceCard,
  words: PictureWords,
  sharer: Sharer,
): Promise<'shared' | 'saved' | 'failed'> {
  const blob = await racePicture(card, words);
  const text = raceShareText(card.name, words.boats, words.at, card.link, card.kind === 'trial');
  const m = await import('./snapshot');
  if (blob === null) {
    return 'failed';
  }
  return m.sharePicture(blob, card.name, card.link, sharer, (b) => m.download(b, RACE_FILE), {
    text,
    file: RACE_FILE,
  });
}
