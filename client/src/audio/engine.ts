// SPDX-License-Identifier: AGPL-3.0-only

// The sound engine: Web Audio, synthesised, with no sound files. One looped
// buffer of noise feeds the voices: the wind (a band-pass), the rigging's
// song (a narrow band-pass at the Aeolian tone), the flogging cloth (a band
// beaten by a flap), the water on the hull (a low-pass, with the bow
// wave's hiss), the sea about the boat (a wide, low band), and the falls (a
// low band through a low-pass, panned toward the lip), and in port the
// water lapping at the quays (audio/harbour.ts, with the bell, the gulls
// and the mallets, each played once). The frame loop sets their parameters at most every 50 ms,
// each gliding to its target with setTargetAtTime. A bump's knock is played
// once, from the same noise and a tone, and let go when it has died away.
//
// Browsers start audio only from a user gesture. Under the HTML standard's
// user activation, a keydown (not Escape), a mouse's pointerdown, or a
// touch's or pen's pointerup counts; a touch's pointerdown does not. So the
// context is made and resumed on the first such event, and tried again on
// every one until it runs. It is suspended while the page is hidden.

import {
  FEATURE_RECIPES,
  type FeatureEvent,
  type FeatureRecipes,
  type FeaturesInput,
  featureEvents,
  roarNow,
} from './features';
import type { Scrape } from './ground';
import {
  bellPartials,
  HARBOUR_RECIPES,
  type HarbourEvent,
  type HarbourInput,
  type HarbourRecipes,
  harbourEvents,
  lappingNow,
} from './harbour';
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
  fallsLow: BiquadFilterNode;
  falls: GainNode;
  fallsPan: StereoPannerNode;
  lapping: GainNode;
  lappingPan: StereoPannerNode;
  roar: GainNode;
  roarPan: StereoPannerNode;
  rain: GainNode;
  drum: GainNode;
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
  const rain = voice(band('bandpass', r.rain.hiss.centre, r.rain.hiss.q));
  const drum = voice(band('bandpass', r.rain.drum.centre, r.rain.drum.q));
  // The falls: their band, through a low-pass the distance closes, panned.
  const fallsBand = band('bandpass', r.falls.centre, r.falls.q);
  const fallsLow = band('lowpass', r.falls.cutoff.most, 0.7);
  const falls = ctx.createGain();
  falls.gain.value = 0;
  const fallsPan = ctx.createStereoPanner();
  source.connect(fallsBand);
  fallsBand.connect(fallsLow);
  fallsLow.connect(falls);
  falls.connect(fallsPan);
  fallsPan.connect(master);

  // The harbour's lapping: a band of noise, panned toward the quay.
  const lappingBand = band('bandpass', HARBOUR_RECIPES.lapping.centre, HARBOUR_RECIPES.lapping.q);
  const lapping = ctx.createGain();
  lapping.gain.value = 0;
  const lappingPan = ctx.createStereoPanner();
  source.connect(lappingBand);
  lappingBand.connect(lapping);
  lapping.connect(lappingPan);
  lappingPan.connect(master);

  // A waterfall's roar: a band of noise, panned toward the fall.
  const roarBand = band('bandpass', FEATURE_RECIPES.waterfall.centre, FEATURE_RECIPES.waterfall.q);
  const roar = ctx.createGain();
  roar.gain.value = 0;
  const roarPan = ctx.createStereoPanner();
  source.connect(roarBand);
  roarBand.connect(roar);
  roar.connect(roarPan);
  roarPan.connect(master);

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
    fallsLow,
    falls,
    fallsPan,
    lapping,
    lappingPan,
    roar,
    roarPan,
    rain,
    drum,
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
    g.fallsLow.frequency.setTargetAtTime(t.fallsCutoff, at, GLIDE);
    g.falls.gain.setTargetAtTime(t.fallsLevel, at, GLIDE);
    g.fallsPan.pan.setTargetAtTime(t.fallsPan, at, GLIDE);
    g.rain.gain.setTargetAtTime(t.rainLevel, at, GLIDE);
    g.drum.gain.setTargetAtTime(t.drumLevel, at, GLIDE);
  }

  /** The harbour's recipes, the world seconds its events are played to, and how many were played (tests). */
  readonly #harbour: HarbourRecipes = HARBOUR_RECIPES;
  #harbourTo = Number.NaN;
  readonly #harbourThrottle = new Throttle(SOUND_INTERVAL);
  harbourEvents = 0;

  /**
   * Sets the harbour's voices for the listener now (ms): the lapping, and
   * the bell's strokes, gulls' calls and mallets' blows due since the last
   * time, each played once at its world time. secondsPerHour is how long
   * an hour of the world's day lasts, s.
   */
  harbour(now: number, x: HarbourInput, secondsPerHour: number): void {
    const g = this.#graph;
    if (g === null || g.ctx.state !== 'running' || !this.#harbourThrottle.due(now)) {
      return;
    }
    const at = g.ctx.currentTime;
    const lap = lappingNow(this.#harbour.lapping, x);
    g.lapping.gain.setTargetAtTime(lap.level, at, GLIDE * 4);
    g.lappingPan.pan.setTargetAtTime(lap.pan, at, GLIDE * 4);
    // A jump in world time (a new world, a restore) plays nothing missed.
    if (!(x.seconds - this.#harbourTo < 2) || x.seconds < this.#harbourTo) {
      this.#harbourTo = x.seconds;
      return;
    }
    for (const e of harbourEvents(this.#harbour, x, this.#harbourTo, x.seconds, secondsPerHour)) {
      this.#play(g, e, at + Math.max(0, e.at - x.seconds));
    }
    this.#harbourTo = x.seconds;
  }

  /** The features' recipes, the world seconds their events are played to, and how many were played (tests). */
  readonly #features: FeatureRecipes = FEATURE_RECIPES;
  #featuresTo = Number.NaN;
  readonly #featuresThrottle = new Throttle(SOUND_INTERVAL);
  featureEvents = 0;

  /**
   * Sets the features' voices for the listener now (ms): the nearest
   * fall's roar, and the blowholes' booms and the colonies' calls due since
   * the last time, each played once at its world time.
   */
  features(now: number, x: FeaturesInput): void {
    const g = this.#graph;
    if (g === null || g.ctx.state !== 'running' || !this.#featuresThrottle.due(now)) {
      return;
    }
    const at = g.ctx.currentTime;
    const roar = roarNow(this.#features.waterfall, x);
    g.roar.gain.setTargetAtTime(roar.level, at, GLIDE * 4);
    g.roarPan.pan.setTargetAtTime(roar.pan, at, GLIDE * 4);
    if (!(x.seconds - this.#featuresTo < 2) || x.seconds < this.#featuresTo) {
      this.#featuresTo = x.seconds;
      return;
    }
    for (const e of featureEvents(this.#features, x, this.#featuresTo, x.seconds)) {
      this.#playFeature(g, e, at + Math.max(0, e.at - x.seconds));
    }
    this.#featuresTo = x.seconds;
  }

  #playFeature(g: Graph, e: FeatureEvent, at: number): void {
    if (!(e.level > 0)) {
      return;
    }
    this.featureEvents++;
    const ctx = g.ctx;
    const pan = ctx.createStereoPanner();
    pan.pan.value = e.pan;
    pan.connect(g.master);
    const nodes: AudioNode[] = [pan];
    const unit = (k: number): number => {
      const v = Math.sin(e.seed * 3.7 + k * 1.3) * 43758.5453;
      return v - Math.floor(v);
    };
    const between = (r: number[], k: number): number =>
      (r[0] ?? 0) + unit(k) * ((r[1] ?? 0) - (r[0] ?? 0));
    if (e.kind === 'boom') {
      // A thump falling in pitch, and the air's whoosh out of the vent.
      const c = this.#features.blowhole;
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(c.thump * 1.6, at);
      o.frequency.exponentialRampToValueAtTime(c.thump, at + c.decay);
      const v = ctx.createGain();
      v.gain.setValueAtTime(e.level, at);
      v.gain.setTargetAtTime(0, at + 0.01, c.decay / 2);
      const burst = ctx.createBufferSource();
      burst.buffer = g.noise;
      const bandp = ctx.createBiquadFilter();
      bandp.type = 'bandpass';
      bandp.frequency.value = c.whoosh;
      bandp.Q.value = c.q;
      const whoosh = ctx.createGain();
      whoosh.gain.setValueAtTime(0, at);
      whoosh.gain.linearRampToValueAtTime(0.7 * e.level, at + 0.08);
      whoosh.gain.setTargetAtTime(0, at + 0.1, c.decay);
      o.connect(v);
      v.connect(pan);
      burst.connect(bandp);
      bandp.connect(whoosh);
      whoosh.connect(pan);
      const end = at + 5 * c.decay;
      o.start(at);
      o.stop(end);
      burst.start(at, (e.seed % 10) * 0.1);
      burst.stop(end);
      nodes.push(o, v, burst, bandp, whoosh);
    } else {
      // A call: a rasp, a whistle or a rattle.
      const c = this.#features.colony;
      const r = c[e.kind];
      const pitch = between(r.pitch, 1);
      const note = between(r.note, 2);
      const o = ctx.createOscillator();
      o.type = e.kind === 'whistle' ? 'sine' : 'sawtooth';
      o.frequency.setValueAtTime(pitch, at);
      o.frequency.exponentialRampToValueAtTime(
        pitch * (e.kind === 'harsh' ? 0.75 : 1.1),
        at + note,
      );
      const v = ctx.createGain();
      v.gain.setValueAtTime(0, at);
      v.gain.linearRampToValueAtTime(e.level, at + 0.02);
      v.gain.linearRampToValueAtTime(0, at + note);
      o.connect(v);
      if (e.kind === 'rattle') {
        // Beaten rate times a second.
        const beat = ctx.createOscillator();
        beat.type = 'square';
        beat.frequency.value = (r as typeof c.rattle).rate;
        const depth = ctx.createGain();
        depth.gain.value = 0.5;
        const gate = ctx.createGain();
        gate.gain.value = 0.5;
        beat.connect(depth);
        depth.connect(gate.gain);
        v.connect(gate);
        gate.connect(pan);
        beat.start(at);
        beat.stop(at + note);
        nodes.push(beat, depth, gate);
      } else {
        v.connect(pan);
      }
      o.start(at);
      o.stop(at + note);
      nodes.push(o, v);
    }
    const first = nodes[1] as AudioScheduledSourceNode | undefined;
    if (first !== undefined && 'onended' in first) {
      first.onended = () => {
        for (const n of nodes) {
          n.disconnect();
        }
      };
    }
  }

  #play(g: Graph, e: HarbourEvent, at: number): void {
    if (!(e.level > 0)) {
      return;
    }
    this.harbourEvents++;
    const ctx = g.ctx;
    const pan = ctx.createStereoPanner();
    pan.pan.value = e.pan;
    pan.connect(g.master);
    const nodes: AudioNode[] = [pan];
    let end = at;
    const r = this.#harbour;
    if (e.kind === 'bell') {
      // Its partials, each dying away over its own decay.
      bellPartials(r.bell).forEach((f, i) => {
        const o = ctx.createOscillator();
        o.frequency.value = f;
        const v = ctx.createGain();
        v.gain.setValueAtTime(0, at);
        v.gain.linearRampToValueAtTime(e.level * (r.bell.levels[i] ?? 0.3), at + 0.004);
        const decay = r.bell.decays[i] ?? 1;
        v.gain.setTargetAtTime(0, at + 0.004, decay / 3);
        o.connect(v);
        v.connect(pan);
        o.start(at);
        o.stop(at + decay * 2);
        end = Math.max(end, at + decay * 2);
        nodes.push(o, v);
      });
    } else if (e.kind === 'gull') {
      // A long call: notes of a harmonic voice, each falling at its end.
      const c = r.gulls;
      const unit = (k: number): number => {
        const v = Math.sin(e.seed * 3.7 + k * 1.3) * 43758.5453;
        return v - Math.floor(v);
      };
      const notes = Math.round(
        (c.notes[0] ?? 3) + unit(1) * ((c.notes[1] ?? 7) - (c.notes[0] ?? 3)),
      );
      const pitch = (c.pitch[0] ?? 1100) + unit(2) * ((c.pitch[1] ?? 1500) - (c.pitch[0] ?? 1100));
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const bandp = ctx.createBiquadFilter();
      bandp.type = 'bandpass';
      bandp.frequency.value = pitch;
      bandp.Q.value = c.q;
      const v = ctx.createGain();
      v.gain.setValueAtTime(0, at);
      let t = at;
      for (let k = 0; k < notes; k++) {
        const note = (c.note[0] ?? 0.2) + unit(3 + k) * ((c.note[1] ?? 0.3) - (c.note[0] ?? 0.2));
        o.frequency.setValueAtTime(pitch / 2, t);
        o.frequency.exponentialRampToValueAtTime((pitch / 2) * c.fall, t + note);
        v.gain.setValueAtTime(0, t);
        v.gain.linearRampToValueAtTime(e.level, t + 0.02);
        v.gain.linearRampToValueAtTime(0, t + note);
        t += note + c.gap;
      }
      o.connect(bandp);
      bandp.connect(v);
      v.connect(pan);
      o.start(at);
      o.stop(t);
      end = t;
      nodes.push(o, bandp, v);
    } else {
      // A mallet's blow: a falling tone and a crack.
      const c = r.mallets;
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(c.thump, at);
      o.frequency.exponentialRampToValueAtTime(c.thump * 0.6, at + 4 * c.decay);
      const v = ctx.createGain();
      v.gain.setValueAtTime(e.level, at);
      v.gain.setTargetAtTime(0, at + 0.003, c.decay);
      const burst = ctx.createBufferSource();
      burst.buffer = g.noise;
      const bandp = ctx.createBiquadFilter();
      bandp.type = 'bandpass';
      bandp.frequency.value = c.crack;
      bandp.Q.value = c.q;
      const crack = ctx.createGain();
      crack.gain.setValueAtTime(0.6 * e.level, at);
      crack.gain.setTargetAtTime(0, at + 0.002, c.decay / 2);
      o.connect(v);
      v.connect(pan);
      burst.connect(bandp);
      bandp.connect(crack);
      crack.connect(pan);
      end = at + 10 * c.decay;
      o.start(at);
      o.stop(end);
      burst.start(at, (e.seed % 10) * 0.1);
      burst.stop(end);
      nodes.push(o, v, burst, bandp, crack);
    }
    const first = nodes[1] as AudioScheduledSourceNode | undefined;
    if (first !== undefined && 'onended' in first) {
      first.onended = () => {
        for (const n of nodes) {
          n.disconnect();
        }
      };
    }
  }

  /** How many knocks were played (tests). */
  knocks = 0;

  /**
   * Plays a bump's knock once: a thump falling in pitch and a crack of
   * noise, each dying away, placed left or right.
   */
  /** How many scrapes were played (tests). */
  scrapes = 0;

  /** Plays a hull's scrape on the bottom once: band-passed noise swelling and dying away. */
  scrape(sc: Scrape): void {
    const g = this.#graph;
    if (g === null || g.ctx.state !== 'running' || !(sc.level > 0)) {
      return;
    }
    this.scrapes++;
    const ctx = g.ctx;
    const at = ctx.currentTime;
    const burst = ctx.createBufferSource();
    burst.buffer = g.noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = sc.band;
    band.Q.value = sc.q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(sc.level, at + sc.rise);
    gain.gain.setTargetAtTime(0, at + sc.rise, sc.decay);
    burst.connect(band);
    band.connect(gain);
    gain.connect(g.master);
    const end = at + sc.rise + 8 * sc.decay;
    burst.start(at, 0.7);
    burst.stop(end);
    burst.onended = () => {
      for (const n of [burst, band, gain]) {
        n.disconnect();
      }
    };
  }

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
