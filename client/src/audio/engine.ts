// SPDX-License-Identifier: AGPL-3.0-only

// The sound engine: Web Audio, synthesised, with no sound files. One looped
// buffer of noise feeds five voices: the wind (a band-pass), the rigging's
// song (a narrow band-pass at the Aeolian tone), the flogging cloth (a band
// beaten by a flap), the water on the hull (a low-pass, with the bow
// wave's hiss), and the sea about the boat (a wide, low band). The frame loop sets their parameters at most every 50 ms,
// each gliding to its target with setTargetAtTime. A bump's knock is played
// once, from the same noise and a tone, and let go when it has died away.
//
// Browsers start audio only from a user gesture. Under the HTML standard's
// user activation, a keydown (not Escape), a mouse's pointerdown, or a
// touch's or pen's pointerup counts; a touch's pointerdown does not. So the
// context is made and resumed on the first such event, and tried again on
// every one until it runs. It is suspended while the page is hidden.

import type { Knock } from './knock';
import {
  newTargets,
  RECIPES,
  type Recipes,
  SOUND_INTERVAL,
  type SoundInput,
  soundTargets,
  Throttle,
} from './voices';

/** How quickly a parameter glides to its target: setTargetAtTime's time constant, in seconds. */
const GLIDE = 0.08;
const NOISE_SECONDS = 2;

interface Graph {
  ctx: AudioContext;
  master: GainNode;
  noise: AudioBuffer;
  windBand: BiquadFilterNode;
  wind: GainNode;
  rigBand: BiquadFilterNode;
  rig: GainNode;
  flap: OscillatorNode;
  flog: GainNode;
  waterLow: GainNode;
  waterFilter: BiquadFilterNode;
  hiss: GainNode;
  seaBand: BiquadFilterNode;
  sea: GainNode;
}

/** A white-noise buffer, from a fixed sequence so every page sounds alike. */
function noise(ctx: AudioContext): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * NOISE_SECONDS);
  const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 22222;
  for (let i = 0; i < n; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    data[i] = (seed / 2147483648 - 1) * 0.7;
  }
  return buffer;
}

function build(ctx: AudioContext, r: Recipes): Graph {
  const master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(ctx.destination);
  const source = ctx.createBufferSource();
  const buffer = noise(ctx);
  source.buffer = buffer;
  source.loop = true;

  const voice = (filter: BiquadFilterNode): GainNode => {
    const g = ctx.createGain();
    g.gain.value = 0;
    source.connect(filter);
    filter.connect(g);
    g.connect(master);
    return g;
  };
  const band = (type: BiquadFilterType, frequency: number, q: number): BiquadFilterNode => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = frequency;
    f.Q.value = q;
    return f;
  };

  const windBand = band('bandpass', r.wind.centre.atRest, r.wind.q);
  const wind = voice(windBand);
  const rigBand = band('bandpass', 100, r.rigging.q);
  const rig = voice(rigBand);

  // The flog: the cloth's band, its level beaten by a flap. The flap is a
  // square wave turned from [−1, 1] into [0, 1] so it only opens the gain.
  const flogBand = band('bandpass', r.flogging.centre, r.flogging.q);
  const flogGate = voice(flogBand);
  const flog = ctx.createGain();
  flog.gain.value = 0;
  const flap = ctx.createOscillator();
  flap.type = 'square';
  flap.frequency.value = r.flogging.rate.atRest;
  const rectify = ctx.createWaveShaper();
  rectify.curve = new Float32Array([0, 0, 1]);
  flap.connect(rectify);
  rectify.connect(flog);
  flog.connect(flogGate.gain);

  const waterFilter = band('lowpass', r.water.cutoff.atRest, 0.7);
  const waterLow = voice(waterFilter);
  const hiss = voice(band('bandpass', r.water.hiss.centre, r.water.hiss.q));

  const seaBand = band('bandpass', r.sea.centre.atRest, r.sea.q);
  const sea = voice(seaBand);

  source.start();
  flap.start();
  return {
    ctx,
    master,
    noise: buffer,
    windBand,
    wind,
    rigBand,
    rig,
    flap,
    flog,
    waterLow,
    waterFilter,
    hiss,
    seaBand,
    sea,
  };
}

export class SoundEngine {
  readonly #recipes: Recipes;
  readonly #throttle = new Throttle(SOUND_INTERVAL);
  readonly #targets = newTargets();
  #graph: Graph | null = null;
  #enabled = true;
  #hidden = false;
  /** How many times the parameters were set (tests). */
  updates = 0;

  constructor(recipes: Recipes = RECIPES) {
    this.#recipes = recipes;
  }

  /** The audio context's state, or 'none' before the first gesture. */
  get state(): AudioContextState | 'none' {
    return this.#graph?.ctx.state ?? 'none';
  }

  /** Listens for the gestures that may start audio, and for the page being hidden. */
  listen(doc: Document): void {
    const gesture = (e: Event): void => {
      if (e instanceof KeyboardEvent && e.key === 'Escape') {
        return;
      }
      if (e instanceof PointerEvent) {
        // A touch or pen activates on pointerup; a mouse on pointerdown.
        const mouse = e.pointerType === 'mouse';
        if ((e.type === 'pointerdown') !== mouse) {
          return;
        }
      }
      this.unlock();
    };
    for (const type of ['pointerdown', 'pointerup', 'keydown', 'touchend']) {
      doc.addEventListener(type, gesture, { capture: true, passive: true });
    }
    doc.addEventListener('visibilitychange', () =>
      this.setHidden(doc.visibilityState === 'hidden'),
    );
  }

  /** Makes and resumes the context; called inside a user gesture. */
  unlock(): void {
    if (!this.#enabled || this.#hidden || typeof AudioContext === 'undefined') {
      return;
    }
    if (this.#graph === null) {
      try {
        this.#graph = build(new AudioContext({ latencyHint: 'playback' }), this.#recipes);
      } catch (err) {
        console.warn('sound could not start', err);
        return;
      }
    }
    if (this.#graph.ctx.state !== 'running') {
      void this.#graph.ctx.resume().catch(() => {});
    }
  }

  set enabled(on: boolean) {
    this.#enabled = on;
    this.#apply();
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  setHidden(hidden: boolean): void {
    this.#hidden = hidden;
    this.#apply();
  }

  /** Sets the voices for the boat as it is now (ms), at most every 50 ms. */
  update(now: number, input: SoundInput): void {
    const g = this.#graph;
    if (g === null || g.ctx.state !== 'running' || !this.#throttle.due(now)) {
      return;
    }
    this.updates++;
    const t = soundTargets(this.#recipes, input, this.#targets);
    const at = g.ctx.currentTime;
    g.windBand.frequency.setTargetAtTime(t.windCentre, at, GLIDE);
    g.wind.gain.setTargetAtTime(t.windLevel, at, GLIDE);
    g.rigBand.frequency.setTargetAtTime(Math.max(20, t.rigTone), at, GLIDE);
    g.rig.gain.setTargetAtTime(t.rigLevel, at, GLIDE);
    g.flap.frequency.setTargetAtTime(t.flapRate, at, GLIDE);
    g.flog.gain.setTargetAtTime(t.flogLevel, at, GLIDE);
    g.waterFilter.frequency.setTargetAtTime(t.waterCutoff, at, GLIDE);
    g.waterLow.gain.setTargetAtTime(t.waterLevel, at, GLIDE);
    g.hiss.gain.setTargetAtTime(t.hissLevel, at, GLIDE);
    g.seaBand.frequency.setTargetAtTime(t.seaCentre, at, GLIDE);
    g.sea.gain.setTargetAtTime(t.seaLevel, at, GLIDE);
  }

  /** How many knocks were played (tests). */
  knocks = 0;

  /**
   * Plays a bump's knock once: a thump falling in pitch and a crack of
   * noise, each dying away, placed left or right.
   */
  knock(k: Knock): void {
    const g = this.#graph;
    if (g === null || g.ctx.state !== 'running' || !(k.level > 0)) {
      return;
    }
    this.knocks++;
    const ctx = g.ctx;
    const at = ctx.currentTime;
    const pan = ctx.createStereoPanner();
    pan.pan.value = k.pan;
    pan.connect(g.master);

    const tone = ctx.createOscillator();
    tone.type = 'sine';
    tone.frequency.setValueAtTime(k.thump, at);
    tone.frequency.exponentialRampToValueAtTime(
      Math.max(20, k.thump * k.fall),
      at + 4 * k.thumpDecay,
    );
    const thump = ctx.createGain();
    thump.gain.setValueAtTime(k.level, at);
    thump.gain.setTargetAtTime(0, at + 0.004, k.thumpDecay);
    tone.connect(thump);
    thump.connect(pan);

    const burst = ctx.createBufferSource();
    burst.buffer = g.noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = k.crack;
    band.Q.value = k.q;
    const crack = ctx.createGain();
    crack.gain.setValueAtTime(0.8 * k.level, at);
    crack.gain.setTargetAtTime(0, at + 0.002, k.crackDecay);
    burst.connect(band);
    band.connect(crack);
    crack.connect(pan);

    const end = at + 8 * Math.max(k.thumpDecay, k.crackDecay);
    tone.start(at);
    tone.stop(end);
    burst.start(at, 0.3);
    burst.stop(end);
    tone.onended = () => {
      for (const n of [tone, thump, burst, band, crack, pan]) {
        n.disconnect();
      }
    };
  }

  #apply(): void {
    const ctx = this.#graph?.ctx;
    if (ctx === undefined) {
      return;
    }
    if (!this.#enabled || this.#hidden) {
      if (ctx.state === 'running') {
        void ctx.suspend().catch(() => {});
      }
    } else if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }
  }
}
