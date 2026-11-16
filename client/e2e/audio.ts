// SPDX-License-Identifier: AGPL-3.0-only

// The sound engine alone, rendered offline (e2e/audio.html): a scene of
// e2e/audioscenes.ts played into an OfflineAudioContext as fast as it
// renders, the engine's voices set every 50 ms between its suspends, then
// measured (audio/loudness.ts). The mix is in the first two channels; the
// bed alone, where the engine has a tap on it, in the next two. The last
// rendering stays, for its samples to be read out (pcm) and its flutter
// measured. A voice may be heard alone, every other silenced.
//
// The game's own recordings (the probe and the test sea) are decoded here
// as the page would decode them, and played in a scene's beds in place of
// their synthesis; and the loader is run against a file that is not there
// and one that is not sound.

import { SoundEngine } from '../src/audio/engine';
import { GUN, gunReport } from '../src/audio/gun';
import {
  integrated,
  lufs,
  measure,
  segmentPowers,
  shareAbove,
  windowPowers,
} from '../src/audio/loudness';
import { type BusName, MIX, type MixRecipe } from '../src/audio/mix';
import { decodedBytes, type Numbers, type Recording, type Voice } from '../src/audio/recorded';
import { SCENES } from './audioscenes';

/** The game's own recordings, by name: the probe and the test sea, with their files. */
const OWN_FILES = import.meta.glob<string>(
  ['../../art/sound/recorded/probe.*', '../../art/sound/recorded/test-sea.*', '!**/*.json'],
  { eager: true, query: '?url', import: 'default' },
);
const OWN_NUMBERS = import.meta.glob<Numbers>(
  ['../../art/sound/recorded/probe.json', '../../art/sound/recorded/test-sea.json'],
  { eager: true, import: 'default' },
);

function own(name: 'probe' | 'test-sea', voice: Voice | '' = ''): Recording {
  const n = OWN_NUMBERS[`../../art/sound/recorded/${name}.json`];
  const webm = OWN_FILES[`../../art/sound/recorded/${name}.webm`];
  const m4a = OWN_FILES[`../../art/sound/recorded/${name}.m4a`];
  if (n === undefined || webm === undefined || m4a === undefined) {
    throw new Error(`no ${name} recording`);
  }
  return { ...n, voice, name, urls: { webm, m4a } };
}

/** Each of the game's own recordings decoded from each format: how long and how wide it is, and what it decodes to. */
async function decodeOwn(): Promise<
  {
    name: string;
    format: string;
    length: number;
    channels: number;
    seconds: number;
    bytes: number;
    decoded: number;
  }[]
> {
  const out = [];
  for (const name of ['probe', 'test-sea'] as const) {
    const r = own(name);
    for (const format of ['webm', 'm4a'] as const) {
      const data = await (await fetch(r.urls[format])).arrayBuffer();
      const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: RATE });
      const b = await ctx.decodeAudioData(data);
      out.push({
        name,
        format,
        length: b.length,
        channels: b.numberOfChannels,
        seconds: r.seconds,
        bytes: data.byteLength,
        decoded: b.length * b.numberOfChannels * 4,
      });
    }
  }
  return out;
}

/** The decoded bytes the numbers say a recording comes to. */
function declared(name: 'probe' | 'test-sea'): number {
  return decodedBytes(own(name), RATE);
}

/**
 * The loader on the engine, offline, given the test sea as a voice's and
 * as two more whose files are not there and are not sound: what loaded and
 * what did not, and the voices then playing recordings.
 */
async function loadWithFaults(): Promise<{
  format: string | null;
  loaded: string[];
  failed: string[];
  recorded: string[];
}> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: RATE, sampleRate: RATE });
  const engine = new SoundEngine();
  engine.attach(ctx);
  const sea = own('test-sea', 'sea.moderate');
  const gone: Recording = {
    ...sea,
    name: 'gone',
    voice: 'wind.light',
    urls: { webm: '/no/such.webm', m4a: '/no/such.m4a' },
  };
  const notSound: Recording = {
    ...sea,
    name: 'not-sound',
    voice: 'surf',
    urls: { webm: '/e2e/audio.html', m4a: '/e2e/audio.html' },
  };
  const out = await engine.record([gone, notSound, sea], own('probe'), { failed: () => {} });
  return { ...(out ?? { format: null, loaded: [], failed: [] }), recorded: [...engine.recorded] };
}

/** The test sea, decoded once for the renderings that play it. */
let testSea: Promise<AudioBuffer> | null = null;
function testSeaBuffer(): Promise<AudioBuffer> {
  testSea ??= (async () => {
    const data = await (await fetch(own('test-sea').urls.webm)).arrayBuffer();
    return new OfflineAudioContext({
      numberOfChannels: 1,
      length: 1,
      sampleRate: RATE,
    }).decodeAudioData(data);
  })();
  return testSea;
}

const RATE = 48000;
const STEP = 0.05;
/** When the limiter's meter has settled, s. */
const SETTLE = 3;

let last: AudioBuffer | null = null;

/** Each scene's mix's last rendering, as the meter's 100 ms powers. */
const powers = new Map<string, Float64Array>();

/** The engine a rendering plays: the game's, on the mix given. */
let makeEngine = (o: RenderOptions): SoundEngine => {
  const mix = o.alone === undefined ? o.mix : alone(o.mix ?? MIX, o.alone);
  return new SoundEngine(undefined, mix === undefined ? {} : { mix });
};

/** Renders with another engine (a tuning script's). */
function useEngine(make: (o: RenderOptions) => SoundEngine): void {
  makeEngine = make;
}

/** What a rendering of a scene measures. */
export interface Measured {
  integrated: number;
  /** The quietest and loudest momentary loudness in the first 10 s, once the voices have glided in (from 2 s, as the game's fade in is done by then), LUFS. */
  early: { least: number; most: number };
  momentaryMax: number;
  shortTermMax: number;
  range: number;
  samplePeak: number;
  truePeak: number;
  /** The share of the bed's energy above 2 kHz (the whole mix's where the bed has no tap). */
  bedAbove: number;
  mixAbove: number;
  /** The bed's own integrated loudness, LUFS (the tapped bus's, where another is tapped). */
  bed: number;
  /** The limiter's most gain reduction, dB; 0 where there is none. */
  reduction: number;
  /** How many of each kind of sound played once were played. */
  played: Record<string, number>;
  /** The recordings played once, in turn: each its voice, take and variation. */
  heard: { voice: string; take: number; rate: number; gain: number }[];
}

/** An engine's parts this harness may find on it: older engines have none. */
interface Taps {
  tap?: (bus: string) => AudioNode | null;
  reduction?: number;
  volumes?: (volume: number, sea: number, sounds: number) => void;
}

/** How a scene is rendered: at a volume (the sliders' values), on a mix of the test's own. */
export interface RenderOptions {
  volume?: number;
  mix?: MixRecipe;
  /** The bus measured as the bed: the sea's, unless another is named. */
  tap?: BusName;
  /** Voices played by the test sea in place of their synthesis, from the start, taking over over crossfade s (none: at once). */
  recorded?: { voices: Voice[]; crossfade?: number };
  /** Voices played once given count takes of their own (bursts of noise, each its own length). */
  takes?: { voices: Voice[]; count: number };
  /** A racer's gun fired beside the boat at this, s. */
  gunAt?: number;
  /** A voice heard alone: a voice of the bed (by its trim's name), the storm, the slaps, the sheet or the boom. */
  alone?: Alone;
}

/** The voices that may be heard alone. */
export type Alone = keyof MixRecipe['bed']['trims'] | 'storm' | 'slaps' | 'sheet' | 'boom';

/** The mix with every voice but one silenced: the other buses, the bed's other voices, the calm, the storm and the sounds of the boat's motion. */
function alone(base: MixRecipe, keep: Alone): MixRecipe {
  const m = structuredClone(base);
  const off = -200;
  for (const k of Object.keys(m.bed.trims) as (keyof MixRecipe['bed']['trims'])[]) {
    if (k !== keep) {
      m.bed.trims[k] = off;
    }
  }
  m.calm.level = 0;
  m.halyards.level = 0;
  if (keep !== 'storm') {
    m.storm.level = 0;
  }
  if (keep !== 'slaps') {
    m.slaps.level = 0;
  }
  if (keep !== 'sheet') {
    m.sail.sheet.level = 0;
  }
  if (keep !== 'boom') {
    m.sail.boom.level = 0;
  }
  for (const b of ['world', 'races', 'notices'] as const) {
    m.buses[b].level = off;
  }
  if (keep !== 'sheet' && keep !== 'boom') {
    m.buses.boat.level = off;
  }
  return m;
}

/** A take for a test: a burst of noise dying away over seconds. */
function burst(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const b = ctx.createBuffer(1, Math.round(RATE * seconds), RATE);
  const d = b.getChannelData(0);
  let seed = Math.round(seconds * 1000);
  for (let i = 0; i < d.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    d[i] = (seed / 2147483648 - 1) * 0.3 * Math.exp((-4 * i) / d.length);
  }
  return b;
}

async function render(name: string, seconds: number, o: RenderOptions = {}): Promise<Measured> {
  const scene = SCENES[name];
  if (scene === undefined) {
    throw new Error(`no scene ${name}`);
  }
  const ctx = new OfflineAudioContext({
    numberOfChannels: 4,
    length: Math.round(RATE * seconds),
    sampleRate: RATE,
  });
  const merger = ctx.createChannelMerger(4);
  merger.connect(ctx.destination);
  // Mono parts of the mix go to both sides, as the speakers would have them.
  const stereo = (into: number): AudioNode => {
    const g = ctx.createGain();
    g.channelCount = 2;
    g.channelCountMode = 'explicit';
    g.channelInterpretation = 'speakers';
    const s = ctx.createChannelSplitter(2);
    g.connect(s);
    s.connect(merger, 0, into);
    s.connect(merger, 1, into + 1);
    return g;
  };
  const engine = makeEngine(o);
  engine.attach(ctx, stereo(0));
  if (o.recorded !== undefined) {
    const b = await testSeaBuffer();
    for (const v of o.recorded.voices) {
      engine.useRecording(v, b, 0, o.recorded.crossfade ?? 0);
    }
  }
  if (o.takes !== undefined) {
    for (const v of o.takes.voices) {
      for (let k = 0; k < o.takes.count; k++) {
        engine.useRecording(v, burst(ctx, 0.3 + 0.1 * k));
      }
    }
  }
  const taps = engine as unknown as Taps;
  taps.volumes?.(o.volume ?? 1, 1, 1);
  const bed = taps.tap?.(o.tap ?? 'sea') ?? null;
  if (bed !== null) {
    bed.connect(stereo(2));
  }
  let reduction = 0;
  let k = 0;
  const tick = (): void => {
    scene.step(engine, k * STEP, k * STEP * 1000);
    if (o.gunAt !== undefined && Math.abs(k * STEP - o.gunAt) < STEP / 2) {
      const r = gunReport(GUN, { east: 0, north: 0 }, { east: 0, north: 0 }, 0, 1, true);
      if (r !== null) {
        engine.gun(r);
      }
    }
    // The limiter's meter starts from a reduction of its own, settling
    // within a second: it is read from then on.
    if (k * STEP >= SETTLE) {
      reduction = Math.max(reduction, -(taps.reduction ?? 0));
    }
    k++;
  };
  const next = (): void => {
    const t = k * STEP;
    if (t >= seconds) {
      return;
    }
    void ctx.suspend(t).then(() => {
      tick();
      next();
      void ctx.resume();
    });
  };
  tick();
  next();
  const buffer = await ctx.startRendering();
  last = buffer;
  const mix = [buffer.getChannelData(0), buffer.getChannelData(1)];
  const m = measure(mix, RATE);
  const segments = segmentPowers(mix, RATE);
  powers.set(name, segments);
  const first = windowPowers(segments.subarray(20, 100), 4);
  const early = {
    least: lufs(first.reduce((a, z) => Math.min(a, z), Number.POSITIVE_INFINITY)),
    most: lufs(first.reduce((a, z) => Math.max(a, z), 0)),
  };
  const mixAbove = shareAbove(mix, RATE, 2000);
  return {
    ...m,
    early,
    bedAbove:
      bed === null
        ? mixAbove
        : shareAbove([buffer.getChannelData(2), buffer.getChannelData(3)], RATE, 2000),
    mixAbove,
    bed:
      bed === null
        ? m.integrated
        : integrated(
            windowPowers(
              segmentPowers([buffer.getChannelData(2), buffer.getChannelData(3)], RATE),
              4,
            ),
          ),
    reduction,
    played: {
      harbour: engine.harbourEvents,
      life: engine.lifeEvents,
      fog: engine.fogSignalEvents,
      thunder: engine.thunderEvents,
      guns: engine.guns,
      cheers: engine.cheers,
      slaps: engine.slaps,
      sheets: engine.sheets,
      booms: engine.booms,
      taps: engine.taps,
      knocks: engine.knocks,
      water: engine.waterSounds,
      features: engine.featureEvents,
      letGo: engine.letGo,
      ducks: engine.ducks,
    },
    heard: (engine.heard ?? []).map((h) => ({ ...h })),
  };
}

/** The mean power of the last rendering's bed (the tapped bus) from s to s. */
function bedPower(from: number, to: number): number {
  if (last === null) {
    throw new Error('nothing rendered');
  }
  let sum = 0;
  let n = 0;
  for (const c of [2, 3]) {
    const d = last.getChannelData(c);
    for (let i = Math.round(from * RATE); i < Math.min(d.length, Math.round(to * RATE)); i++) {
      sum += (d[i] ?? 0) ** 2;
      n++;
    }
  }
  return sum / Math.max(1, n);
}

/**
 * How much the last rendering's mix flutters from s to s: its power over
 * 10 ms blocks, the loudest tenth's against the quietest tenth's, dB. A
 * sound gated on and off is far apart; a steady or softly swelling one near.
 */
function flutter(from: number, to: number): number {
  if (last === null) {
    throw new Error('nothing rendered');
  }
  const block = RATE / 100;
  const blocks: number[] = [];
  const a = last.getChannelData(0);
  const b = last.getChannelData(1);
  for (let i = Math.round(from * RATE); i + block <= Math.min(a.length, to * RATE); i += block) {
    let sum = 0;
    for (let j = i; j < i + block; j++) {
      sum += (a[j] ?? 0) ** 2 + (b[j] ?? 0) ** 2;
    }
    blocks.push(sum / block);
  }
  blocks.sort((x, y) => x - y);
  const at = (q: number): number => blocks[Math.floor(q * (blocks.length - 1))] ?? 0;
  return 10 * Math.log10(at(0.9) / Math.max(at(0.1), 1e-30));
}

/** The integrated loudness of scenes' last renderings heard one after another, LUFS. */
function typical(names: string[]): number {
  const parts = names.map((n) => powers.get(n) ?? new Float64Array(0));
  const all = new Float64Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return integrated(windowPowers(all, 4));
}

/** The last rendering's mix from s to s, interleaved stereo 32-bit floats, in base64. */
function pcm(from: number, to: number): string {
  if (last === null) {
    throw new Error('nothing rendered');
  }
  const a = last.getChannelData(0);
  const b = last.getChannelData(1);
  const i0 = Math.round(from * RATE);
  const i1 = Math.min(a.length, Math.round(to * RATE));
  const out = new Float32Array(2 * Math.max(0, i1 - i0));
  for (let i = i0; i < i1; i++) {
    out[2 * (i - i0)] = a[i] ?? 0;
    out[2 * (i - i0) + 1] = b[i] ?? 0;
  }
  const bytes = new Uint8Array(out.buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

const hooks = {
  render,
  pcm,
  bedPower,
  flutter,
  typical,
  useEngine,
  decodeOwn,
  declared,
  loadWithFaults,
  rate: RATE,
  scenes: Object.keys(SCENES),
};

export type AudioHooks = typeof hooks;

declare global {
  // What e2e/audio.html puts on window for the tests.
  var audio: AudioHooks;
}

globalThis.audio = hooks;
