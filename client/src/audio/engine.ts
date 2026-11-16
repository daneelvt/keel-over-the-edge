// SPDX-License-Identifier: AGPL-3.0-only

// The sound engine: Web Audio, synthesised, with no sound files. The boat's
// bed is made of noises (audio/noise.ts: pink for the wind, brown for the
// water and the sea, white for the rest), each voice reading its own at its
// own offset: the wind (a band-pass), the rigging's song (a narrow band at
// the Aeolian tone, in gusts), the flogging cloth (a band beaten by a
// flap), the water on the hull (a low-pass, with the bow wave's hiss), the
// sea about the boat (a wide, low band), rain, the falls (a low band
// through a low-pass, panned toward the lip), and, while the boat drifts,
// the calm's lapping at the hull; in port the water lapping at the quays
// (audio/harbour.ts, with the bell, the gulls and the mallets, each played
// once), and by day the calls of the sea's life about the boat
// (audio/life.ts), each played once. The frame loop sets their parameters
// at most every 50 ms, each gliding to its target with setTargetAtTime. A
// bump's knock is played once, from the noise and a tone, and let go when
// it has died away; so are a lighthouse's fog signal's blasts in fog
// (audio/fogsignals.ts), each a tone of the device's harmonics, and the
// thunder after a flash (audio/thunder.ts), from the noise.
//
// Every voice plays into its family's bus of the mix (audio/mix.ts), which
// decides how loud it is heard: the bed's levels as the recipes give them
// (the server's lookout tells machine sailors the same) are played on the
// mix's curve, nearer together, and each voice at its trim.
//
// Browsers start audio only from a user gesture. Under the HTML standard's
// user activation, a keydown (not Escape), a mouse's pointerdown, or a
// touch's or pen's pointerup counts; a touch's pointerdown does not. So the
// context is made and resumed on the first such event, and tried again on
// every one until it runs; never while the sound is off. Before it is made
// the page's audio session is set to ambient where the browser has one: the
// game's sound then mixes with the player's own music, and an iPhone's
// silent switch silences it. It fades in as it starts. Muted, or while the
// page is hidden, it fades out and then is suspended; unmuted or shown, it
// is resumed and fades in.

import { CHEER, type CheerSound } from './cheer';
import {
  FEATURE_RECIPES,
  type FeatureEvent,
  type FeatureRecipes,
  type FeaturesInput,
  featureEvents,
  roarNow,
} from './features';
import {
  FOG_SIGNAL_RECIPES,
  FOG_SIGNAL_RULES,
  type FogSignalEvent,
  type FogSignalRecipes,
  type FogSignalRules,
  type FogSignalsInput,
  fogSignalEvents,
} from './fogsignals';
import type { Scrape } from './ground';
import { GUN, type GunReport } from './gun';
import {
  bellPartials,
  HARBOUR_RECIPES,
  type HarbourEvent,
  type HarbourInput,
  type HarbourRecipes,
  harbourEvents,
  lappingNow,
  strokeTimes,
} from './harbour';
import type { Knock } from './knock';
import {
  LIFE_RECIPES,
  type LifeEvent,
  type LifeInput,
  type LifeRecipes,
  lifeEvents,
  WATER_RECIPES,
  type WaterRecipes,
  type WaterSound,
} from './life';
import { type BusName, calmLevel, curved, gainOf, MIX, Mixer, type MixRecipe } from './mix';
import { type NoiseColour, noiseBuffer } from './noise';
import {
  THUNDER_RECIPE,
  THUNDER_RULE,
  type ThunderEvent,
  type ThunderInput,
  type ThunderRecipe,
  type ThunderRule,
  thunderEvents,
} from './thunder';
import {
  newTargets,
  RECIPES,
  type Recipes,
  ramp,
  SOUND_INTERVAL,
  type SoundInput,
  soundTargets,
  Throttle,
} from './voices';

/** How quickly the lapping and a fall's roar glide to their targets, s: slower than the voices. */
const SLOW = 0.32;

/**
 * A voice of the bed: its synthesis, held at one, into its level, which
 * the physics sets. A recording of the same voice would play into the
 * level beside the synthesis, the two crossfaded.
 */
interface BedVoice {
  synth: GainNode;
  level: GainNode;
}

interface Graph {
  ctx: BaseAudioContext;
  mix: Mixer;
  /** The noises the voices read; one-shots read the white. */
  noise: Record<NoiseColour, AudioBuffer>;
  windBand: BiquadFilterNode;
  wind: BedVoice;
  rigBand: BiquadFilterNode;
  rig: BedVoice;
  flap: OscillatorNode;
  flog: BedVoice;
  water: BedVoice;
  waterFilter: BiquadFilterNode;
  hiss: BedVoice;
  seaBand: BiquadFilterNode;
  sea: BedVoice;
  fallsLow: BiquadFilterNode;
  falls: BedVoice;
  fallsPan: StereoPannerNode;
  lapping: BedVoice;
  lappingPan: StereoPannerNode;
  roar: BedVoice;
  roarPan: StereoPannerNode;
  rain: BedVoice;
  drum: BedVoice;
  calm: BedVoice;
  /** The fog signals' tones, by device: made once each. */
  waves: Map<string, PeriodicWave>;
}

function build(ctx: BaseAudioContext, r: Recipes, m: MixRecipe, destination: AudioNode): Graph {
  const mix = new Mixer(ctx, destination, m);
  const noise = {
    white: noiseBuffer(ctx, 'white', m.noise),
    pink: noiseBuffer(ctx, 'pink', m.noise),
    brown: noiseBuffer(ctx, 'brown', m.noise),
  };
  const band = (type: BiquadFilterType, frequency: number, q: number): BiquadFilterNode => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = frequency;
    f.Q.value = q;
    return f;
  };
  // Each voice's noise starts at its own place in the loop, the golden
  // ratio's steps apart.
  const sources: [AudioBufferSourceNode, number][] = [];
  const bed = (colour: NoiseColour, filters: AudioNode[], pan?: StereoPannerNode): BedVoice => {
    const s = ctx.createBufferSource();
    s.buffer = noise[colour];
    s.loop = true;
    sources.push([s, ((sources.length * 0.61803398875) % 1) * m.noise]);
    let at: AudioNode = s;
    for (const f of filters) {
      at.connect(f);
      at = f;
    }
    const synth = ctx.createGain();
    const level = ctx.createGain();
    level.gain.value = 0;
    at.connect(synth);
    synth.connect(level);
    if (pan !== undefined) {
      level.connect(pan);
      pan.connect(mix.input('sea'));
    } else {
      level.connect(mix.input('sea'));
    }
    return { synth, level };
  };

  const windBand = band('bandpass', r.wind.centre.atRest, r.wind.q);
  const wind = bed('pink', [windBand]);
  const rigBand = band('bandpass', 100, m.tone.rigging.q);
  const rig = bed('white', [rigBand]);

  // The flog: the cloth's band, beaten by a flap. The flap is a square wave
  // turned from [−1, 1] into [0, 1] so it only opens the gate.
  const flogGate = ctx.createGain();
  flogGate.gain.value = 0;
  const flog = bed('white', [band('bandpass', r.flogging.centre, r.flogging.q), flogGate]);
  const flap = ctx.createOscillator();
  flap.type = 'square';
  flap.frequency.value = r.flogging.rate.atRest;
  const rectify = ctx.createWaveShaper();
  rectify.curve = new Float32Array([0, 0, 1]);
  flap.connect(rectify);
  rectify.connect(flogGate.gain);

  const waterFilter = band('lowpass', r.water.cutoff.atRest, 0.7);
  const water = bed('brown', [waterFilter]);
  const hiss = bed('white', [band('bandpass', m.tone.hiss, r.water.hiss.q)]);

  const seaBand = band('bandpass', r.sea.centre.atRest, r.sea.q);
  const sea = bed('brown', [seaBand]);
  const rain = bed('white', [band('bandpass', r.rain.hiss.centre, r.rain.hiss.q)]);
  const drum = bed('white', [band('bandpass', r.rain.drum.centre, r.rain.drum.q)]);
  // The falls: their band, through a low-pass the distance closes, panned.
  const fallsLow = band('lowpass', r.falls.cutoff.most, 0.7);
  const fallsPan = ctx.createStereoPanner();
  const falls = bed('white', [band('bandpass', r.falls.centre, r.falls.q), fallsLow], fallsPan);
  // The harbour's lapping: a band of noise, panned toward the quay.
  const lappingPan = ctx.createStereoPanner();
  const lapping = bed(
    'white',
    [band('bandpass', HARBOUR_RECIPES.lapping.centre, HARBOUR_RECIPES.lapping.q)],
    lappingPan,
  );
  // A waterfall's roar: a band of noise, panned toward the fall.
  const roarPan = ctx.createStereoPanner();
  const roar = bed(
    'white',
    [band('bandpass', FEATURE_RECIPES.waterfall.centre, FEATURE_RECIPES.waterfall.q)],
    roarPan,
  );
  // The calm's lapping at the hull.
  const calm = bed('brown', [band('bandpass', m.calm.centre, m.calm.q)]);

  for (const [s, offset] of sources) {
    s.start(0, offset);
  }
  flap.start();
  return {
    ctx,
    mix,
    noise,
    windBand,
    wind,
    rigBand,
    rig,
    flap,
    flog,
    water,
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
    calm,
    waves: new Map(),
  };
}

/** What the engine may be given: a maker of its context (the page's own, else none), and the mix. */
export interface EngineOptions {
  context?: () => AudioContext;
  mix?: MixRecipe;
}

/** The page's audio session, where the browser has one (the W3C's Audio Session; Safari since iOS 17). */
interface AudioSessionNavigator {
  audioSession?: { type: string };
}

/**
 * Sets the page's audio session to ambient where the browser has one: the
 * game's sound mixes with what else plays, and an iPhone's silent switch
 * silences it. Before an audio context is made, which takes the session.
 */
export function ambientSession(nav: unknown = globalThis.navigator): void {
  const s = (nav as AudioSessionNavigator | undefined)?.audioSession;
  if (s !== undefined && s !== null) {
    try {
      s.type = 'ambient';
    } catch {
      // A session that refuses: the browser's own then.
    }
  }
}

export class SoundEngine {
  readonly #recipes: Recipes;
  readonly #mix: MixRecipe;
  readonly #context: (() => AudioContext) | null;
  readonly #throttle = new Throttle(SOUND_INTERVAL);
  readonly #targets = newTargets();
  #graph: Graph | null = null;
  #enabled = true;
  #hidden = false;
  /** Whether a gesture has been seen: the sound turned on later may start at once. */
  #gestured = false;
  /** Whether the sound plays: not faded out for a mute or the page hidden. */
  #playing = false;
  #suspending: ReturnType<typeof setTimeout> | null = null;
  #volumes = { volume: 1, sea: 1, sounds: 1 };
  /** How many times the parameters were set, and contexts made (tests). */
  updates = 0;
  contexts = 0;

  constructor(recipes: Recipes = RECIPES, options: EngineOptions = {}) {
    this.#recipes = recipes;
    this.#mix = options.mix ?? MIX;
    this.#context =
      options.context ??
      (typeof AudioContext === 'undefined'
        ? null
        : () => new AudioContext({ latencyHint: 'playback' }));
  }

  /** The audio context's state, or 'none' before the first gesture. */
  get state(): AudioContextState | 'none' {
    return this.#graph?.ctx.state ?? 'none';
  }

  /** Whether the graph was built on a context rendered offline (attach). */
  #offline = false;

  /**
   * Builds the graph on a context of the caller's, into destination: an
   * OfflineAudioContext renders what the engine plays faster than it
   * would be heard, the caller setting the voices between its suspends.
   * Its state is then no matter: the voices are set while it is suspended.
   * It starts at full, with no fade.
   */
  attach(ctx: BaseAudioContext, destination: AudioNode = ctx.destination): void {
    this.#offline = true;
    this.#graph = build(ctx, this.#recipes, this.#mix, destination);
    this.#graph.mix.volumes(this.#volumes);
    this.#graph.mix.fade.gain.value = 1;
    this.#playing = true;
  }

  /** Whether the graph plays: its context runs, or renders offline. */
  #live(g: Graph): boolean {
    return this.#offline || g.ctx.state === 'running';
  }

  /** The mixer, once the context is made: where recordings and the meter join the mix. */
  get mixer(): Mixer | null {
    return this.#graph?.mix ?? null;
  }

  /** A bus's output, for a meter to listen to; null before the context is made. */
  tap(bus: BusName): AudioNode | null {
    return this.#graph?.mix.output(bus) ?? null;
  }

  /** The limiter's gain reduction now, dB (0 or less). */
  get reduction(): number {
    return this.#graph?.mix.reduction ?? 0;
  }

  /** Sets the player's volume, the sea and wind's and every other sound's, each 0 to 1. */
  volumes(volume: number, sea: number, sounds: number): void {
    this.#volumes = { volume, sea, sounds };
    this.#graph?.mix.volumes(this.#volumes);
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

  /** Makes and resumes the context; called inside a user gesture. Never while the sound is off. */
  unlock(): void {
    this.#gestured = true;
    if (!this.#enabled || this.#hidden || this.#context === null) {
      return;
    }
    if (this.#graph === null) {
      try {
        ambientSession();
        const ctx = this.#context();
        this.contexts++;
        this.#graph = build(ctx, this.#recipes, this.#mix, ctx.destination);
      } catch (err) {
        console.warn('sound could not start', err);
        return;
      }
      this.#graph.mix.volumes(this.#volumes);
      this.#graph.mix.fadeIn(this.#mix.fades.start);
      this.#playing = true;
    }
    const ctx = this.#graph.ctx;
    if (!this.#offline && ctx.state !== 'running') {
      void (ctx as AudioContext).resume().catch(() => {});
    }
  }

  set enabled(on: boolean) {
    this.#enabled = on;
    // Turned on from a gesture (the menu's switch, the M key): start now.
    if (on && this.#graph === null && this.#gestured) {
      this.unlock();
    }
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
    if (g === null || !this.#live(g) || !this.#throttle.due(now)) {
      return;
    }
    this.updates++;
    const r = this.#recipes;
    const m = this.#mix;
    const t = soundTargets(r, input, this.#targets);
    const at = g.ctx.currentTime;
    const glide = m.fades.glide;
    const b = m.bed;
    // A bed's voice at the level the recipe gives, on the mix's curve, at its trim.
    const play = (v: BedVoice, level: number, most: number, trim: number): void => {
      v.level.gain.setTargetAtTime(gainOf(trim) * curved(level, most, b.curve), at, glide);
    };
    g.windBand.frequency.setTargetAtTime(t.windCentre, at, glide);
    play(g.wind, t.windLevel, r.wind.level.most, b.trims.wind);
    // The rigging sings in the gusts alone.
    const sings = ramp(m.tone.rigging.gust.from, m.tone.rigging.gust.full, input.gustFactor ?? 1);
    g.rigBand.frequency.setTargetAtTime(Math.max(20, t.rigTone), at, glide);
    play(g.rig, t.rigLevel * sings, r.rigging.level.most, b.trims.rigging);
    g.flap.frequency.setTargetAtTime(t.flapRate, at, glide);
    play(g.flog, t.flogLevel, r.flogging.level.most, b.trims.flog);
    g.waterFilter.frequency.setTargetAtTime(t.waterCutoff, at, glide);
    play(g.water, t.waterLevel, r.water.level.most, b.trims.water);
    play(g.hiss, t.hissLevel, r.water.hiss.most, b.trims.hiss);
    g.seaBand.frequency.setTargetAtTime(t.seaCentre, at, glide);
    play(g.sea, t.seaLevel, r.sea.level.most, b.trims.sea);
    g.fallsLow.frequency.setTargetAtTime(t.fallsCutoff, at, glide);
    // The falls keep their fall with distance: their warning is in it.
    g.falls.level.gain.setTargetAtTime(gainOf(b.trims.falls) * t.fallsLevel, at, glide);
    g.fallsPan.pan.setTargetAtTime(t.fallsPan, at, glide);
    play(g.rain, t.rainLevel, r.rain.level.most, b.trims.rain);
    play(g.drum, t.drumLevel, r.rain.drumLevel.most, b.trims.drum);
    g.calm.level.gain.setTargetAtTime(calmLevel(m.calm, input.speed, input.time), at, glide);
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
    if (g === null || !this.#live(g) || !this.#harbourThrottle.due(now)) {
      return;
    }
    const at = g.ctx.currentTime;
    const lap = lappingNow(this.#harbour.lapping, x);
    g.lapping.level.gain.setTargetAtTime(gainOf(this.#mix.bed.trims.lapping) * lap.level, at, SLOW);
    g.lappingPan.pan.setTargetAtTime(lap.pan, at, SLOW);
    // A jump in world time (a new world, a restore) plays nothing missed.
    if (!(x.seconds - this.#harbourTo < 2) || x.seconds < this.#harbourTo) {
      this.#harbourTo = x.seconds;
      return;
    }
    for (const e of harbourEvents(this.#harbour, x, this.#harbourTo, x.seconds, secondsPerHour)) {
      this.#play(g, e, at + Math.max(0, e.at - x.seconds), 'world');
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
    if (g === null || !this.#live(g) || !this.#featuresThrottle.due(now)) {
      return;
    }
    const at = g.ctx.currentTime;
    const roar = roarNow(this.#features.waterfall, x);
    g.roar.level.gain.setTargetAtTime(gainOf(this.#mix.bed.trims.roar) * roar.level, at, SLOW);
    g.roarPan.pan.setTargetAtTime(roar.pan, at, SLOW);
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
    const pan = this.#shot(g, 'world', e.pan);
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
      burst.buffer = g.noise.white;
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
      v.gain.linearRampToValueAtTime(e.level, at + Math.min(this.#mix.tone.birds.attack, note / 3));
      v.gain.linearRampToValueAtTime(0, at + note);
      if (e.kind === 'whistle') {
        o.connect(v);
      } else {
        const soft = this.#soft(g, pitch);
        o.connect(soft);
        soft.connect(v);
        nodes.push(soft);
      }
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

  /** The sea's life's recipes, the world seconds its calls are played to, and how many were played (tests). */
  readonly #life: LifeRecipes = LIFE_RECIPES;
  #lifeTo = Number.NaN;
  readonly #lifeThrottle = new Throttle(SOUND_INTERVAL);
  lifeEvents = 0;

  /**
   * Plays the calls of the sea's life about the listener due since the last
   * time (ms), each once at its world time.
   */
  life(now: number, x: LifeInput): void {
    const g = this.#graph;
    if (g === null || !this.#live(g) || !this.#lifeThrottle.due(now)) {
      return;
    }
    if (!(x.seconds - this.#lifeTo < 2) || x.seconds < this.#lifeTo) {
      this.#lifeTo = x.seconds;
      return;
    }
    const at = g.ctx.currentTime;
    for (const e of lifeEvents(this.#life, x, this.#lifeTo, x.seconds)) {
      this.#playLife(g, e, at + Math.max(0, e.at - x.seconds));
    }
    this.#lifeTo = x.seconds;
  }

  readonly #water: WaterRecipes = WATER_RECIPES;
  /** The splashes and breaths played (tests). */
  waterSounds = 0;

  /** Plays the life in the water's splashes and breaths of a frame, each once, now. */
  water(sounds: readonly WaterSound[]): void {
    const g = this.#graph;
    if (g === null || !this.#live(g)) {
      return;
    }
    for (const s of sounds) {
      this.#playWater(g, s);
    }
  }

  /** A splash or a breath: a burst of the noise through a falling band, dying away. */
  #playWater(g: Graph, s: WaterSound): void {
    if (!(s.level > 0)) {
      return;
    }
    this.waterSounds++;
    const ctx = g.ctx;
    const c = this.#water[s.kind];
    const unit = (k: number): number => {
      const v = Math.sin(s.seed * 3.7 + k * 1.3) * 43758.5453;
      return v - Math.floor(v);
    };
    const at = ctx.currentTime;
    const length =
      (c.length[0] ?? 0.2) + unit(1) * ((c.length[1] ?? 0.4) - (c.length[0] ?? 0.2)) * s.size;
    const f = (c.band[0] ?? 800) + unit(2) * ((c.band[1] ?? 1600) - (c.band[0] ?? 800));
    const burst = ctx.createBufferSource();
    burst.buffer = g.noise.white;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = c.q;
    band.frequency.setValueAtTime(f, at);
    band.frequency.exponentialRampToValueAtTime(f * c.fall, at + length);
    const v = ctx.createGain();
    v.gain.setValueAtTime(0, at);
    v.gain.linearRampToValueAtTime(s.level, at + 0.012);
    v.gain.exponentialRampToValueAtTime(0.0001, at + length);
    const pan = this.#shot(g, 'world', s.pan);
    burst.connect(band);
    band.connect(v);
    v.connect(pan);
    burst.start(at, unit(3) * 2);
    burst.stop(at + length + 0.05);
    burst.onended = () => {
      for (const n of [burst, band, v, pan]) {
        n.disconnect();
      }
    };
  }

  #playLife(g: Graph, e: LifeEvent, at: number): void {
    if (!(e.level > 0)) {
      return;
    }
    this.lifeEvents++;
    const ctx = g.ctx;
    const r = this.#life;
    const unit = (k: number): number => {
      const v = Math.sin(e.seed * 3.7 + k * 1.3) * 43758.5453;
      return v - Math.floor(v);
    };
    const between = (p: readonly number[], k: number): number =>
      (p[0] ?? 0) + unit(k) * ((p[1] ?? 0) - (p[0] ?? 0));
    const pan = this.#shot(g, 'world', e.pan);
    const o = ctx.createOscillator();
    const v = ctx.createGain();
    v.gain.setValueAtTime(0, at);
    const nodes: AudioNode[] = [pan, o, v];
    let t = at;
    // One note of a call: from pitch at t, gliding to end over its length.
    const note = (pitch: number, end: number, length: number): void => {
      o.frequency.setValueAtTime(pitch, t);
      o.frequency.exponentialRampToValueAtTime(end, t + length);
      v.gain.setValueAtTime(0, t);
      v.gain.linearRampToValueAtTime(
        e.level,
        t + Math.min(this.#mix.tone.birds.attack, length / 4),
      );
      v.gain.linearRampToValueAtTime(0, t + length);
    };
    if (e.kind === 'whistle') {
      // A thin whistle, rising a little at its end.
      const c = r.whistle;
      const pitch = between(c.pitch, 1);
      const length = between(c.note, 2);
      o.type = 'sine';
      note(pitch, pitch * c.rise, length);
      o.connect(v);
      t += length;
    } else {
      // A nasal voice: a harmonic tone through a band at the call's pitch,
      // its fundamental an octave under it.
      const c = e.kind === 'laugh' ? r.laugh : r.tern;
      const pitch = between(c.pitch, 1);
      o.type = 'sawtooth';
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = pitch;
      band.Q.value = c.q;
      const soft = this.#soft(g, pitch);
      o.connect(band);
      band.connect(soft);
      soft.connect(v);
      nodes.push(band, soft);
      if (e.kind === 'laugh') {
        // "Ha-ha-ha": a run of short notes, each a little lower.
        const l = r.laugh;
        const notes = Math.round(between(l.notes, 2));
        for (let k = 0; k < notes; k++) {
          const length = between(l.note, 3 + k);
          const f = (pitch / 2) * (1 - 0.02 * k);
          note(f, f * l.fall, length);
          t += length + l.gap;
        }
      } else {
        // "Ker-wacki-wah": short, shorter and higher, then long and falling.
        const tn = r.tern;
        tn.syllables.forEach((length, k) => {
          const f = (pitch / 2) * (k === 1 ? 1.12 : 1);
          note(f, k === tn.syllables.length - 1 ? f * tn.fall : f * 0.97, length);
          t += length + tn.gap;
        });
      }
    }
    v.connect(pan);
    o.start(at);
    o.stop(t);
    o.onended = () => {
      for (const n of nodes) {
        n.disconnect();
      }
    };
  }

  #play(g: Graph, e: HarbourEvent, at: number, bus: BusName): void {
    if (!(e.level > 0)) {
      return;
    }
    this.harbourEvents++;
    const ctx = g.ctx;
    const pan = this.#shot(g, bus, e.pan);
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
        v.gain.linearRampToValueAtTime(
          e.level,
          t + Math.min(this.#mix.tone.birds.attack, note / 3),
        );
        v.gain.linearRampToValueAtTime(0, t + note);
        t += note + c.gap;
      }
      const soft = this.#soft(g, pitch);
      o.connect(bandp);
      bandp.connect(soft);
      soft.connect(v);
      v.connect(pan);
      o.start(at);
      o.stop(t);
      end = t;
      nodes.push(o, bandp, soft, v);
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
      burst.buffer = g.noise.white;
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

  /** The fog signals' recipes and rules, the world seconds their blasts are played to, and how many were played (tests). */
  readonly #fog: FogSignalRecipes = FOG_SIGNAL_RECIPES;
  readonly #fogRules: FogSignalRules = FOG_SIGNAL_RULES;
  #fogTo = Number.NaN;
  readonly #fogThrottle = new Throttle(SOUND_INTERVAL);
  fogSignalEvents = 0;

  /**
   * Plays the fog signals' blasts heard by the listener since the last
   * time (ms), each once as its sound arrives.
   */
  fogSignals(now: number, x: FogSignalsInput): void {
    const g = this.#graph;
    if (g === null || !this.#live(g) || !this.#fogThrottle.due(now)) {
      return;
    }
    if (!(x.seconds - this.#fogTo < 2) || x.seconds < this.#fogTo) {
      this.#fogTo = x.seconds;
      return;
    }
    const at = g.ctx.currentTime;
    for (const e of fogSignalEvents(this.#fog, this.#fogRules, x, this.#fogTo, x.seconds)) {
      this.#playBlast(g, e, at + Math.max(0, e.at - x.seconds));
    }
    this.#fogTo = x.seconds;
  }

  /** A device's tone: a periodic wave of its harmonics, made once. */
  #wave(g: Graph, device: FogSignalEvent['device']): PeriodicWave {
    let w = g.waves.get(device);
    if (w === undefined) {
      const h = this.#fog[device].harmonics;
      const real = new Float32Array(h.length + 1);
      const imag = new Float32Array(h.length + 1);
      h.forEach((v, i) => {
        imag[i + 1] = v;
      });
      w = g.ctx.createPeriodicWave(real, imag);
      g.waves.set(device, w);
    }
    return w;
  }

  /**
   * A blast: the device's tone through a low-pass, never above the air's
   * over its distance, swelling in over the attack, held, and dying away
   * over the release after it ends.
   */
  #playBlast(g: Graph, e: FogSignalEvent, at: number): void {
    if (!(e.level > 0) || !(e.length > 0)) {
      return;
    }
    this.fogSignalEvents++;
    const ctx = g.ctx;
    const r = this.#fog;
    const device = r[e.device];
    const end = at + e.length;
    const stop = end + 2 * device.release;
    const o = ctx.createOscillator();
    o.setPeriodicWave(this.#wave(g, e.device));
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.Q.value = 0.7;
    const v = ctx.createGain();
    v.gain.setValueAtTime(0, at);
    v.gain.linearRampToValueAtTime(e.level, at + Math.min(device.attack, e.length / 3));
    v.gain.setValueAtTime(e.level, end);
    v.gain.setTargetAtTime(0, end, device.release / 3);
    const pan = this.#shot(g, 'world', e.pan);
    o.connect(low);
    low.connect(v);
    v.connect(pan);
    const nodes: AudioNode[] = [o, low, v, pan];
    // A diaphone's low-pass opens as the blast swells: a horn brightens as
    // it grows louder.
    const swell = (c: { from: number; to: number; open: number }): void => {
      low.frequency.setValueAtTime(Math.min(c.from, e.cutoff), at);
      low.frequency.exponentialRampToValueAtTime(
        Math.min(c.to, e.cutoff),
        at + Math.min(c.open, e.length),
      );
    };
    const f = o.frequency;
    if (e.device === 'diaphone') {
      // Its pitch sags as the air runs out, then drops in the grunt.
      const c = r.diaphone;
      const grunt = Math.min(c.gruntTime, e.length / 3);
      f.setValueAtTime(c.pitch, at);
      f.exponentialRampToValueAtTime(c.sag, end - grunt);
      f.exponentialRampToValueAtTime(c.sag * c.grunt, end - grunt + Math.min(0.04, grunt));
      swell(c.cutoff);
    } else if (e.device === 'twotone') {
      // The high tone, then the low held to the end.
      const c = r.twotone;
      const high = e.tones[0] ?? c.pitch;
      const turn = at + c.high * e.length;
      f.setValueAtTime(high, at);
      f.setValueAtTime(high, turn);
      f.exponentialRampToValueAtTime(e.tones[1] ?? c.low, turn + c.glide);
      swell(c.cutoff);
    } else if (e.device === 'siren') {
      // The wail: rising as the rotor spins up, falling at the end.
      const c = r.siren;
      const k = Math.min(1, e.length / (c.rise + c.fall));
      f.setValueAtTime(c.low, at);
      f.exponentialRampToValueAtTime(e.tones[0] ?? c.pitch, at + c.rise * k);
      f.setValueAtTime(e.tones[0] ?? c.pitch, end - c.fall * k);
      f.exponentialRampToValueAtTime(c.low, end);
      low.frequency.value = Math.min(c.cutoff, e.cutoff);
    } else {
      // A reed's note, wavering a few cents.
      const c = r.reedhorn;
      const pitch = e.tones[0] ?? c.pitch;
      f.value = pitch;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = c.vibrato.rate;
      const depth = ctx.createGain();
      depth.gain.value = pitch * (2 ** (c.vibrato.cents / 1200) - 1);
      lfo.connect(depth);
      depth.connect(f);
      lfo.start(at);
      lfo.stop(stop);
      nodes.push(lfo, depth);
      low.frequency.value = Math.min(c.cutoff, e.cutoff);
    }
    o.start(at);
    o.stop(stop);
    o.onended = () => {
      for (const n of nodes) {
        n.disconnect();
      }
    };
  }

  /** The thunder's recipe and rule, the world seconds it is played to, and how many were played (tests). */
  readonly #thunder: ThunderRecipe = THUNDER_RECIPE;
  readonly #thunderRule: ThunderRule = THUNDER_RULE;
  #thunderTo = Number.NaN;
  readonly #thunderThrottle = new Throttle(SOUND_INTERVAL);
  thunderEvents = 0;

  /** Plays the thunder first heard by the listener since the last time (ms), each once. */
  thunder(now: number, x: ThunderInput): void {
    const g = this.#graph;
    if (g === null || !this.#live(g) || !this.#thunderThrottle.due(now)) {
      return;
    }
    if (!(x.seconds - this.#thunderTo < 2) || x.seconds < this.#thunderTo) {
      this.#thunderTo = x.seconds;
      return;
    }
    const at = g.ctx.currentTime;
    for (const e of thunderEvents(
      this.#thunder,
      this.#thunderRule,
      x,
      this.#thunderTo,
      x.seconds,
    )) {
      this.#playThunder(g, e, at + Math.max(0, e.at - x.seconds));
    }
    this.#thunderTo = x.seconds;
  }

  /**
   * A thunder, from one run of the noise: near, a crack of band-passed
   * noise; a rumble of low-passed noise swelling and falling, fainter as
   * the sound of farther stretches arrives, held while the channel's sound
   * arrives and dying over the roll; and a deep layer under it.
   */
  #playThunder(g: Graph, e: ThunderEvent, at: number): void {
    if (!(e.level > 0)) {
      return;
    }
    this.thunderEvents++;
    const ctx = g.ctx;
    const r = this.#thunder;
    const unit = (k: number): number => {
      const v = Math.sin(e.seed * 3.7 + k * 1.3) * 43758.5453;
      return v - Math.floor(v);
    };
    const hold = at + Math.max(e.length, 0.3);
    const stop = hold + 1.5 * r.roll;
    const burst = ctx.createBufferSource();
    burst.buffer = g.noise.white;
    burst.loop = true;
    const pan = this.#shot(g, 'world', e.pan);
    const lowpass = (frequency: number): BiquadFilterNode => {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = frequency;
      f.Q.value = 0.7;
      return f;
    };
    const nodes: AudioNode[] = [burst, pan];

    // The rumble: its swells drawn from the flash's seed, each fainter as
    // the sound comes from farther along the channel.
    const rumbleLow = lowpass(Math.min(r.rumble.cutoff, e.cutoff));
    const rumble = ctx.createGain();
    const level = e.level * r.rumble.level;
    const step = 1 / r.rumble.swells;
    const near = Math.max(e.distance, r.near);
    rumble.gain.setValueAtTime(0, at);
    rumble.gain.linearRampToValueAtTime(level * (1 - r.rumble.depth * unit(0)), at + 0.15);
    for (let k = 1; at + k * step < hold; k++) {
      const fade = near / (near + this.#thunderRule.speed * k * step);
      rumble.gain.setTargetAtTime(
        level * fade * (1 - r.rumble.depth * unit(k)),
        at + k * step,
        step / 3,
      );
    }
    rumble.gain.setTargetAtTime(0, hold, r.roll / 3);
    burst.connect(rumbleLow);
    rumbleLow.connect(rumble);
    rumble.connect(pan);
    nodes.push(rumbleLow, rumble);

    // The deep layer, below what the air absorbs.
    const deepLow = lowpass(r.deep.cutoff);
    const deep = ctx.createGain();
    deep.gain.setValueAtTime(0, at);
    deep.gain.linearRampToValueAtTime(e.level * r.deep.level, at + 0.3);
    deep.gain.setTargetAtTime(0, hold, r.roll / 3);
    burst.connect(deepLow);
    deepLow.connect(deep);
    deep.connect(pan);
    nodes.push(deepLow, deep);

    if (e.crack) {
      // The crack: a band of noise through the air's low-pass, dying fast.
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = r.crack.centre;
      band.Q.value = r.crack.q;
      const air = lowpass(e.cutoff);
      const crack = ctx.createGain();
      crack.gain.setValueAtTime(e.level * r.crack.level, at);
      crack.gain.setTargetAtTime(0, at + 0.005, r.crack.decay / 3);
      burst.connect(band);
      band.connect(air);
      air.connect(crack);
      crack.connect(pan);
      nodes.push(band, air, crack);
    }
    burst.start(at, (Math.abs(Math.floor(e.seed)) % 20) * 0.1);
    burst.stop(stop);
    burst.onended = () => {
      for (const n of nodes) {
        n.disconnect();
      }
    };
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
    if (g === null || !this.#live(g) || !(sc.level > 0)) {
      return;
    }
    this.scrapes++;
    const ctx = g.ctx;
    const at = ctx.currentTime;
    const burst = ctx.createBufferSource();
    burst.buffer = g.noise.white;
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
    gain.connect(g.mix.input('boat'));
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
    if (g === null || !this.#live(g) || !(k.level > 0)) {
      return;
    }
    this.knocks++;
    const ctx = g.ctx;
    const at = ctx.currentTime;
    const pan = this.#shot(g, 'boat', k.pan);

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
    burst.buffer = g.noise.white;
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

  /** How many times the bell was rung near (tests). */
  bells = 0;

  /**
   * Rings the harbour's bell near the listener, strokes times, a pair's
   * spacing apart: as near as it is ever heard, in the middle. A
   * certificate earned rings it twice.
   */
  bell(strokes: number): void {
    const g = this.#graph;
    if (g === null || !this.#live(g) || strokes < 1) {
      return;
    }
    this.bells++;
    const r = this.#harbour.bell;
    const at = g.ctx.currentTime;
    strokeTimes(strokes, r).forEach((t, i) => {
      this.#play(
        g,
        { kind: 'bell', at: at + t, level: r.level, pan: 0, seed: i },
        at + t,
        'notices',
      );
    });
  }

  /** How many of the signal gun's reports were played (tests). */
  guns = 0;

  /**
   * Plays the signal gun's report once: the crack of its blast, a thump
   * falling in pitch and the boom of low-passed noise, each dying away, and
   * the boom's echoes after them, duller and fainter; through the air's
   * low-pass over its distance, placed left or right.
   */
  gun(g0: GunReport): void {
    const g = this.#graph;
    if (g === null || !this.#live(g) || !(g0.level > 0)) {
      return;
    }
    this.guns++;
    const r = GUN;
    const ctx = g.ctx;
    const at = ctx.currentTime + g0.delay;
    const pan = this.#shot(g, 'races', g0.pan);
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    air.frequency.value = g0.cutoff;
    air.Q.value = 0.7;
    air.connect(pan);
    const nodes: AudioNode[] = [pan, air];

    const tone = ctx.createOscillator();
    tone.type = 'sine';
    tone.frequency.setValueAtTime(r.thump.frequency, at);
    tone.frequency.exponentialRampToValueAtTime(
      Math.max(20, r.thump.frequency * r.thump.fall),
      at + 3 * r.thump.decay,
    );
    const thump = ctx.createGain();
    thump.gain.setValueAtTime(0, ctx.currentTime);
    thump.gain.setValueAtTime(g0.level * r.thump.level, at);
    thump.gain.setTargetAtTime(0, at + 0.004, r.thump.decay / 3);
    tone.connect(thump);
    thump.connect(air);
    nodes.push(tone, thump);

    const burst = ctx.createBufferSource();
    burst.buffer = g.noise.white;
    burst.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = r.crack.centre;
    band.Q.value = r.crack.q;
    // The crack, low-passed: a report across the water, not a snap at the ear.
    const dull = ctx.createBiquadFilter();
    dull.type = 'lowpass';
    dull.frequency.value = this.#mix.tone.gunCrack;
    dull.Q.value = 0.7;
    const crack = ctx.createGain();
    crack.gain.setValueAtTime(0, ctx.currentTime);
    crack.gain.setValueAtTime(g0.level * r.crack.level, at);
    crack.gain.setTargetAtTime(0, at + 0.002, r.crack.decay / 3);
    burst.connect(band);
    band.connect(dull);
    dull.connect(crack);
    crack.connect(air);
    nodes.push(burst, band, dull, crack);

    // The boom, and each echo a later copy of it, duller and fainter.
    let end = at + 3 * r.thump.decay;
    for (const e of [{ delay: 0, level: 1, cutoff: r.boom.cutoff }, ...g0.echoes]) {
      const t = at + e.delay;
      const low = ctx.createBiquadFilter();
      low.type = 'lowpass';
      low.frequency.value = Math.min(r.boom.cutoff, e.cutoff);
      low.Q.value = 0.7;
      const boom = ctx.createGain();
      boom.gain.setValueAtTime(0, ctx.currentTime);
      boom.gain.setValueAtTime(0, t);
      boom.gain.linearRampToValueAtTime(g0.level * r.boom.level * e.level, t + 0.012);
      boom.gain.setTargetAtTime(0, t + 0.012, r.boom.decay / 3);
      burst.connect(low);
      low.connect(boom);
      boom.connect(air);
      nodes.push(low, boom);
      end = Math.max(end, t + 2 * r.boom.decay);
    }
    tone.start(at);
    tone.stop(end);
    burst.start(at, 0.5);
    burst.stop(end);
    tone.onended = () => {
      for (const n of nodes) {
        n.disconnect();
      }
    };
  }

  /** How many cheers were played (tests). */
  cheers = 0;

  /**
   * Plays a crowd's cheer once, as cheerOf works it out: each voice a
   * breath and an "ah" through the open vowel's formants, its pitch rising
   * on the stress and falling away; a roar and claps under a big crowd's;
   * all through the low-pass of its distance. The one place the crowd is
   * heard: a recorded cheer would be played here instead.
   */
  cheer(c: CheerSound): void {
    const g = this.#graph;
    if (g === null || !this.#live(g) || !(c.level > 0)) {
      return;
    }
    this.cheers++;
    const r = CHEER;
    const ctx = g.ctx;
    const t0 = ctx.currentTime + 0.02;
    const out = ctx.createGain();
    out.gain.value = c.level;
    out.connect(g.mix.input('races'));
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    air.frequency.value = c.cutoff;
    air.Q.value = 0.7;
    air.connect(out);
    const nodes: AudioNode[] = [out, air];
    let end = t0;
    for (const v of c.voices) {
      const at = t0 + v.at;
      const pan = ctx.createStereoPanner();
      pan.pan.value = v.pan;
      pan.connect(air);
      // The breath, "h".
      const breath = ctx.createBufferSource();
      breath.buffer = g.noise.white;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = r.breath.centre;
      band.Q.value = r.breath.q;
      const bg = ctx.createGain();
      bg.gain.setValueAtTime(0, ctx.currentTime);
      bg.gain.linearRampToValueAtTime(v.level * r.breath.level, at + 0.02);
      bg.gain.linearRampToValueAtTime(0, at + r.breath.length);
      breath.connect(band);
      band.connect(bg);
      bg.connect(pan);
      breath.start(at, Math.random());
      breath.stop(at + r.breath.length + 0.05);
      // The vowel, "ah": a sawtooth through the formants.
      const start = at + r.breath.length * 0.7;
      const stop = start + v.length;
      const saw = ctx.createOscillator();
      saw.type = 'sawtooth';
      saw.frequency.setValueAtTime(v.pitch, start);
      saw.frequency.linearRampToValueAtTime(
        v.pitch * r.vowel.rise,
        start + v.length * r.vowel.riseShare,
      );
      saw.frequency.linearRampToValueAtTime(v.pitch * r.vowel.rise * r.vowel.fall, stop);
      const vib = ctx.createOscillator();
      vib.frequency.value = r.vowel.vibrato.rate;
      const vibDepth = ctx.createGain();
      vibDepth.gain.value = v.pitch * r.vowel.vibrato.depth;
      vib.connect(vibDepth);
      vibDepth.connect(saw.frequency);
      const vg = ctx.createGain();
      vg.gain.setValueAtTime(0, ctx.currentTime);
      vg.gain.setValueAtTime(0, start);
      vg.gain.linearRampToValueAtTime(v.level * r.vowel.level, start + r.vowel.attack);
      vg.gain.setTargetAtTime(0, start + v.length * 0.55, v.length * 0.18);
      vg.connect(pan);
      nodes.push(pan, breath, band, bg, saw, vib, vibDepth, vg);
      for (const f of r.formants) {
        const fb = ctx.createBiquadFilter();
        fb.type = 'bandpass';
        fb.frequency.value = f.frequency;
        fb.Q.value = f.q;
        const fg = ctx.createGain();
        fg.gain.value = f.level;
        saw.connect(fb);
        fb.connect(fg);
        fg.connect(vg);
        nodes.push(fb, fg);
      }
      saw.start(start);
      vib.start(start);
      saw.stop(stop + 0.3);
      vib.stop(stop + 0.3);
      end = Math.max(end, stop + 0.3);
    }
    if (c.roar > 0) {
      const roar = ctx.createBufferSource();
      roar.buffer = g.noise.white;
      roar.loop = true;
      const lo = ctx.createBiquadFilter();
      lo.type = 'highpass';
      lo.frequency.value = r.roar.low;
      const hi = ctx.createBiquadFilter();
      hi.type = 'lowpass';
      hi.frequency.value = r.roar.high;
      const rg = ctx.createGain();
      rg.gain.setValueAtTime(0, ctx.currentTime);
      rg.gain.linearRampToValueAtTime(c.roar, t0 + r.roar.attack);
      rg.gain.setTargetAtTime(0, t0 + r.roar.length * 0.5, r.roar.length * 0.25);
      roar.connect(lo);
      lo.connect(hi);
      hi.connect(rg);
      rg.connect(air);
      roar.start(t0, Math.random());
      roar.stop(t0 + r.roar.length * 1.6);
      nodes.push(roar, lo, hi, rg);
      end = Math.max(end, t0 + r.roar.length * 1.6);
    }
    for (const k of c.claps) {
      const at = t0 + k.at;
      const clap = ctx.createBufferSource();
      clap.buffer = g.noise.white;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = r.claps.centre;
      band.Q.value = 1.2;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0, ctx.currentTime);
      cg.gain.setValueAtTime(r.claps.level, at);
      cg.gain.setTargetAtTime(0, at + 0.001, r.claps.length / 3);
      const pan = ctx.createStereoPanner();
      pan.pan.value = k.pan;
      clap.connect(band);
      band.connect(cg);
      cg.connect(pan);
      pan.connect(air);
      clap.start(at, Math.random());
      clap.stop(at + r.claps.length * 4);
      nodes.push(clap, band, cg, pan);
    }
    const done = ctx.createConstantSource();
    done.start(t0);
    done.stop(end + 0.1);
    done.onended = () => {
      for (const n of nodes) {
        n.disconnect();
      }
    };
  }

  /**
   * A bird's harmonic call's low-pass, at the mix's times its pitch: the
   * sawtooth's harsh upper partials taken off.
   */
  #soft(g: Graph, pitch: number): BiquadFilterNode {
    const f = g.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = Math.min(this.#mix.tone.birds.lowpass * pitch, g.ctx.sampleRate / 2);
    f.Q.value = 0.5;
    return f;
  }

  /**
   * Where a sound played once goes: a panner into its family's bus. Every
   * one-shot goes through here.
   */
  #shot(g: Graph, bus: BusName, pan: number): StereoPannerNode {
    const p = g.ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(g.mix.input(bus));
    return p;
  }

  /**
   * Fades the sound out and then suspends the context while it is off or
   * the page hidden; resumes it and fades it in when both are past.
   */
  #apply(): void {
    const g = this.#graph;
    if (g === null || this.#offline) {
      return;
    }
    const ctx = g.ctx as AudioContext;
    const f = this.#mix.fades;
    if (!this.#enabled || this.#hidden) {
      if (!this.#playing) {
        return;
      }
      this.#playing = false;
      g.mix.fadeOut(f.out);
      if (this.#suspending !== null) {
        clearTimeout(this.#suspending);
      }
      this.#suspending = setTimeout(
        () => {
          this.#suspending = null;
          if (!this.#playing && ctx.state === 'running') {
            void ctx.suspend().catch(() => {});
          }
        },
        f.out * 1000 + 20,
      );
      return;
    }
    if (this.#playing) {
      return;
    }
    this.#playing = true;
    if (this.#suspending !== null) {
      clearTimeout(this.#suspending);
      this.#suspending = null;
    }
    if (ctx.state === 'running') {
      g.mix.fadeTo(1, f.in);
      return;
    }
    void ctx.resume().then(
      () => {
        if (this.#playing) {
          g.mix.fadeTo(1, f.in);
        }
      },
      () => {},
    );
  }
}
