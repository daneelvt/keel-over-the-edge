// SPDX-License-Identifier: AGPL-3.0-only

// A picture of the view at the moment a link is shared: the next frame
// the phone draws, copied from the scene's canvas, cut to 16:9 from its
// middle (upright, its full width and the middle band), 1200 × 675, with a
// strip across its foot: the game's name in its own type, and "Watch
// Name sail". The screen's keys and instruments are not in the scene's
// canvas, so the picture is the sea alone. A JPEG under 1 MB, made only on
// the tap, shared with the link and never sent to the server or kept.
// Loaded on the tap, apart from the game's first download.

import type { Sharer } from './sharelink';
import { shareText, watchSailText } from './watchwords';

/** The picture's size. */
export const WIDTH = 1200;
export const HEIGHT = 675;

/** The most a picture may weigh. */
export const MOST = 1_000_000;

/** The strip across the picture's foot, px tall. */
export const STRIP = 84;

/** The part of a source w × h cut out: 16:9, from the middle. */
export function cropOf(w: number, h: number): { x: number; y: number; w: number; h: number } {
  const aspect = WIDTH / HEIGHT;
  if (w / h > aspect) {
    // Wider than 16:9 (a phone sideways): the full height, the middle.
    const cw = Math.round(h * aspect);
    return { x: Math.round((w - cw) / 2), y: 0, w: cw, h };
  }
  // Taller (a phone upright): the full width, the middle band.
  const ch = Math.round(w / aspect);
  return { x: 0, y: Math.round((h - ch) / 2), w, h: ch };
}

/** The strip's words: the game's name, and the line under it. */
export function stripWords(name: string): { title: string; line: string } {
  return { title: 'Keel Over the Edge', line: watchSailText(name) };
}

/** Draws the picture of source, with the strip naming name, on a canvas of its own. */
export function draw(source: HTMLCanvasElement, name: string): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = WIDTH;
  out.height = HEIGHT;
  const ctx = out.getContext('2d');
  if (ctx === null) {
    return out;
  }
  const c = cropOf(source.width, source.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, c.x, c.y, c.w, c.h, 0, 0, WIDTH, HEIGHT);
  // The strip: dark and a little clear, the sea showing through.
  const top = HEIGHT - STRIP;
  ctx.fillStyle = 'rgb(16 24 30 / 72%)';
  ctx.fillRect(0, top, WIDTH, STRIP);
  ctx.fillStyle = 'rgb(232 180 80 / 85%)';
  ctx.fillRect(0, top, WIDTH, 2);
  const words = stripWords(name);
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f2efe7';
  ctx.font = '40px "IM Fell English SC", Georgia, serif';
  ctx.textAlign = 'left';
  ctx.fillText(words.title, 32, top + STRIP / 2 + 2, WIDTH / 2 - 48);
  ctx.font = '500 32px "Alegreya Sans", system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(words.line, WIDTH - 32, top + STRIP / 2 + 2, WIDTH / 2 - 48);
  return out;
}

/** The picture as a JPEG under MOST, the quality lowered until it is. */
export async function jpeg(canvas: HTMLCanvasElement): Promise<Blob | null> {
  for (const q of [0.86, 0.78, 0.68, 0.55]) {
    const b = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', q));
    if (b !== null && b.size < MOST) {
      return b;
    }
  }
  return null;
}

/** How long a frame is waited for, ms. */
const FRAME_WAIT = 2_000;

/** The picture of the next frame, captured, with the strip naming name; null if none is drawn. */
export async function picture(
  capture: () => Promise<HTMLCanvasElement | null>,
  name: string,
): Promise<Blob | null> {
  // The type the strip is written in, before it is drawn with.
  try {
    await Promise.all([
      document.fonts.load('40px "IM Fell English SC"'),
      document.fonts.load('500 32px "Alegreya Sans"'),
    ]);
  } catch {
    // The fallbacks draw it.
  }
  const frame = await Promise.race([
    capture(),
    new Promise<null>((r) => setTimeout(() => r(null), FRAME_WAIT)),
  ]);
  return frame === null ? null : jpeg(draw(frame, name));
}

/** How a picture's share went: shared, saved with the link copied, or neither. */
export type PictureResult = 'shared' | 'saved' | 'failed';

/** The file a picture is shared or saved as. */
export const FILE_NAME = 'keel-over-the-edge.jpg';

/**
 * Shares the picture with the link at the end of its text, where the
 * phone can share a file; otherwise saves it (a download) and copies the
 * link. A share the player closed is neither. The words are a watch's
 * unless others are given, as a race's are.
 */
export async function sharePicture(
  blob: Blob,
  name: string,
  url: string,
  sharer: Sharer,
  save: (blob: Blob) => void = download,
  words: { text: string; file: string } = { text: shareText(name, url), file: FILE_NAME },
): Promise<PictureResult> {
  const file = new File([blob], words.file, { type: 'image/jpeg' });
  const data: ShareData = { files: [file], text: words.text };
  if (sharer.share !== undefined && sharer.canShare?.(data) === true) {
    try {
      await sharer.share(data);
      return 'shared';
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        return 'failed';
      }
      // Refused for another reason (the tap's moment passed): saved instead.
    }
  }
  save(blob);
  try {
    await sharer.copy(url);
  } catch {
    // Saved, though the link was not copied.
  }
  return 'saved';
}

/** Saves a picture to the device, as a download. */
export function download(blob: Blob, file = FILE_NAME): void {
  const a = document.createElement('a');
  const href = URL.createObjectURL(blob);
  a.href = href;
  a.download = file;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}
