// SPDX-License-Identifier: AGPL-3.0-only

// The sound engine alone, rendered offline (e2e/audio.html): a scene of
// e2e/audioscenes.ts played into an OfflineAudioContext as fast as it
// renders, the engine's voices set every 50 ms between its suspends, then
// measured (audio/loudness.ts). The mix is in the first two channels; the
// bed alone, where the engine has a tap on it, in the next two. The last
// rendering stays, for its samples to be read out (pcm).

import { SoundEngine } from '../src/audio/engine';
import {
  integrated,
  measure,
  segmentPowers,
  shareAbove,
  windowPowers,
} from '../src/audio/loudness';
import type { MixRecipe } from '../src/audio/mix';
import { SCENES } from './audioscenes';

const RATE = 48000;
const STEP = 0.05;
/** When the limiter's meter has settled, s. */
const SETTLE = 3;

let last: AudioBuffer | null = null;

/** Each scene's mix's last rendering, as the meter's 100 ms powers. */
const powers = new Map<string, Float64Array>();

/** The engine a rendering plays: the game's, on the mix given. */
let makeEngine = (o: RenderOptions): SoundEngine =>
  new SoundEngine(undefined, o.mix === undefined ? {} : { mix: o.mix });

/** Renders with another engine (a tuning script's). */
function useEngine(make: (o: RenderOptions) => SoundEngine): void {
  makeEngine = make;
}

/** What a rendering of a scene measures. */
export interface Measured {
  integrated: number;
  momentaryMax: number;
  shortTermMax: number;
  range: number;
  samplePeak: number;
  truePeak: number;
  /** The share of the bed's energy above 2 kHz (the whole mix's where the bed has no tap). */
  bedAbove: number;
  mixAbove: number;
  /** The limiter's most gain reduction, dB; 0 where there is none. */
  reduction: number;
  /** How many of each kind of sound played once were played. */
  played: Record<string, number>;
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
  const taps = engine as unknown as Taps;
  taps.volumes?.(o.volume ?? 1, 1, 1);
  const bed = taps.tap?.('sea') ?? null;
  if (bed !== null) {
    bed.connect(stereo(2));
  }
  let reduction = 0;
  let k = 0;
  const tick = (): void => {
    scene.step(engine, k * STEP, k * STEP * 1000);
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
  powers.set(name, segmentPowers(mix, RATE));
  const mixAbove = shareAbove(mix, RATE, 2000);
  return {
    ...m,
    bedAbove:
      bed === null
        ? mixAbove
        : shareAbove([buffer.getChannelData(2), buffer.getChannelData(3)], RATE, 2000),
    mixAbove,
    reduction,
    played: {
      harbour: engine.harbourEvents,
      life: engine.lifeEvents,
      fog: engine.fogSignalEvents,
      thunder: engine.thunderEvents,
      guns: engine.guns,
      cheers: engine.cheers,
    },
  };
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

const hooks = { render, pcm, typical, useEngine, rate: RATE, scenes: Object.keys(SCENES) };

export type AudioHooks = typeof hooks;

declare global {
  // What e2e/audio.html puts on window for the tests.
  var audio: AudioHooks;
}

globalThis.audio = hooks;
