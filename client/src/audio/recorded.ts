// SPDX-License-Identifier: AGPL-3.0-only

// The recordings: which exist (art/sound/recorded/*.json, each a
// recording's numbers, which only the page reads), where their files are,
// and how they are loaded. Nothing is in the game's first download: Set
// sail starts the synthesis at once, and the recordings are fetched after,
// one at a time, beds first and what is heard now first; each decoded
// between frames, and each taking over from its synthesis as it arrives. A
// recording that is missing or will not decode leaves its synthesis
// playing. With none listed, nothing is fetched.
//
// The format is chosen by decoding: a recording is in Opus in WebM and in
// AAC in .m4a, and a probe a twentieth of a second long in each says which
// this browser decodes (canPlayType has said yes where the decoder then
// failed).

/** The voices a recording may play, by its kind: beds loop, shots play once. */
export const VOICES = {
  'wind.light': 'bed',
  'wind.moderate': 'bed',
  'wind.strong': 'bed',
  'wind.gale': 'bed',
  'hull.chuckle': 'bed',
  'hull.wash': 'bed',
  'hull.bow': 'bed',
  'sea.calm': 'bed',
  'sea.moderate': 'bed',
  'sea.rough': 'bed',
  'rain.light': 'bed',
  'rain.heavy': 'bed',
  flog: 'bed',
  lapping: 'bed',
  halyards: 'bed',
  surf: 'bed',
  slap: 'shot',
  sheet: 'shot',
  boom: 'shot',
} as const;

export type Voice = keyof typeof VOICES;

export type Format = 'webm' | 'm4a';

/** A recording's numbers' file, as tools/sounds writes it. */
export interface Numbers {
  kind: 'bed' | 'shot' | 'probe';
  voice: string;
  gain: number;
  seconds: number;
  channels: number;
  bytes: { webm: number; m4a: number };
}

/** A recording the page may play: its name, its numbers, and its files. */
export interface Recording extends Numbers {
  name: string;
  urls: Record<Format, string>;
}

/** The recordings' numbers and files, by name; the tests' own (test-*) are left out. */
const NUMBERS = import.meta.glob<Numbers>(
  ['../../../art/sound/recorded/*.json', '!../../../art/sound/recorded/test-*'],
  { eager: true, import: 'default' },
);
const FILES = import.meta.glob<string>(
  [
    '../../../art/sound/recorded/*.webm',
    '../../../art/sound/recorded/*.m4a',
    '!../../../art/sound/recorded/test-*',
  ],
  { eager: true, query: '?url&no-inline', import: 'default' },
);

/** The recordings listed, from numbers and files by path, with what plays each. */
export function recordings(
  numbers: Record<string, Numbers>,
  files: Record<string, string>,
): { voices: Recording[]; probe: Recording | null } {
  const voices: Recording[] = [];
  let probe: Recording | null = null;
  for (const [path, n] of Object.entries(numbers)) {
    const stem = path.replace(/\.json$/, '');
    const name = stem.slice(stem.lastIndexOf('/') + 1);
    const webm = files[`${stem}.webm`];
    const m4a = files[`${stem}.m4a`];
    if (webm === undefined || m4a === undefined) {
      continue;
    }
    const r: Recording = { ...n, name, urls: { webm, m4a } };
    if (n.kind === 'probe') {
      probe = r;
    } else if (n.voice in VOICES && VOICES[n.voice as Voice] === n.kind) {
      voices.push(r);
    }
  }
  voices.sort((a, b) => a.name.localeCompare(b.name));
  return { voices, probe };
}

/** The game's recordings. */
export const RECORDED = recordings(NUMBERS, FILES);

/** What the loader needs of the page. */
export interface LoaderHost {
  /** Where recordings are decoded: the engine's context. */
  decode(data: ArrayBuffer): Promise<AudioBuffer>;
  /** A file's bytes; rejects where it cannot be had. */
  fetch(url: string): Promise<ArrayBuffer>;
  /** Resolves between frames: a decode is started there. */
  frame(): Promise<void>;
  /** How much a recording is needed now: the most needed is fetched first. */
  need(r: Recording): number;
  /** A recording has loaded. */
  loaded(r: Recording, buffer: AudioBuffer): void;
  /** A recording could not be had: its synthesis plays on. */
  failed?(r: Recording, why: unknown): void;
}

/** What a load came to: the format chosen (none where neither decodes), and the recordings loaded and failed. */
export interface Loaded {
  format: Format | null;
  loaded: string[];
  failed: string[];
}

/** The fetch the page uses: the bytes, or a rejection for a status that is not ok. */
export async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url}: ${res.status}`);
  }
  return res.arrayBuffer();
}

/** Resolves between frames: after the next frame is drawn. */
export function betweenFrames(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/** The format this browser decodes, by the probe: WebM first, else AAC, else none. */
export async function probeFormat(host: LoaderHost, probe: Recording): Promise<Format | null> {
  for (const format of ['webm', 'm4a'] as const) {
    try {
      const b = await host.decode(await host.fetch(probe.urls[format]));
      if (b.length > 0) {
        return format;
      }
    } catch {
      // Not this one.
    }
  }
  return null;
}

/**
 * Loads the recordings, one at a time: the probe first, then beds before
 * shots, the most needed of what is left each time; each decoded between
 * frames. Stops when stopped() says so.
 */
export async function load(
  host: LoaderHost,
  list: readonly Recording[],
  probe: Recording | null,
  stopped: () => boolean = () => false,
): Promise<Loaded> {
  const out: Loaded = { format: null, loaded: [], failed: [] };
  if (list.length === 0 || probe === null) {
    return out;
  }
  out.format = await probeFormat(host, probe);
  const format = out.format;
  if (format === null) {
    for (const r of list) {
      out.failed.push(r.name);
      host.failed?.(r, new Error('this browser decodes neither format'));
    }
    return out;
  }
  const left = [...list];
  while (left.length > 0 && !stopped()) {
    let best = 0;
    for (let i = 1; i < left.length; i++) {
      if (before(host, left[i] as Recording, left[best] as Recording)) {
        best = i;
      }
    }
    const r = left.splice(best, 1)[0] as Recording;
    try {
      const data = await host.fetch(r.urls[format]);
      await host.frame();
      const buffer = await host.decode(data);
      if (stopped()) {
        break;
      }
      host.loaded(r, buffer);
      out.loaded.push(r.name);
    } catch (why) {
      out.failed.push(r.name);
      host.failed?.(r, why);
    }
  }
  return out;
}

/** Whether a is to be fetched before b: beds first, then the more needed, then by name. */
function before(host: LoaderHost, a: Recording, b: Recording): boolean {
  if (a.kind !== b.kind) {
    return a.kind === 'bed';
  }
  const na = host.need(a);
  const nb = host.need(b);
  if (na !== nb) {
    return na > nb;
  }
  return a.name < b.name;
}

/** The bytes a recording decodes to, as the context's 32-bit floats at its rate. */
export function decodedBytes(r: Pick<Numbers, 'seconds' | 'channels'>, rate = 48000): number {
  return Math.round(r.seconds * rate) * r.channels * 4;
}
