// SPDX-License-Identifier: AGPL-3.0-only

// The sound engine: Web Audio, synthesised, with recordings taking over
// where they have loaded (audio/recorded.ts, audio/layers.ts). The boat's
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
// thunder after a flash (audio/thunder.ts), from the noise. The boat's own
// motion makes its sounds once (audio/motion.ts): a slap as the bow meets a
// wave, the sheet running in a tack, the boom's thump in a gybe; and near
// the land (audio/shore.ts) the halyards in port tap their masts and the
// surf breaks as the water shoals.
//
// The bed's families (the wind, the hull's water, the sea, rain, the
// flogging sail, the lapping, the halyards and the surf) are layers: each
// plays its recordings, crossfaded by the physics, where they have loaded,
// and its synthesis the share they leave. The synthesis plays from the
// start and wherever no recording has come.
//
// So do the sounds played once (audio/oneshots.ts): the gulls, the sea's
// birds and the colonies, the bell, the fog signals, thunder, splashes and
// breaths, knocks and the scrape, the gun and the crowd each play one of
// their recordings where they have some, chosen and varied by the event's
// own seed, and their synthesis, varied alike, where they have none. At
// most so many play at once, and so many of a family, the quietest let go.
// The gun, a near fog signal and the crowd's cheer dip the sea's bus.
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
import { Loop, shares, takeOf } from './layers';
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
import { type SailSound, SailWatch, type Slap, SlapWatch } from './motion';
import { type NoiseColour, noiseBuffer } from './noise';
import { pickTake, unit, type Variation, Voices, vary } from './oneshots';
import {
  betweenFrames,
  fetchBytes,
  type Loaded,
  type LoaderHost,
  load,
  RECORDED,
  type Recording,
  VOICES,
  type Voice,
} from './recorded';
import { halyardsLevel, halyardTaps, surfLevel, type Tap } from './shore';
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
 * A voice of the bed: its synthesis, at its family's share of it, into its
 * level, which the physics sets.
 */
interface BedVoice {
  synth: GainNode;
  level: GainNode;
}

/** The bed's families, each a set of layers (mix.json's layers). */
export type FamilyName = Exclude<keyof MixRecipe['layers'], 'crossfade'>;

/** A recording playing a layer: its loop, its gain, when it began to take over and over how long, and its trim. */
interface Layer {
  loop: Loop;
  gain: GainNode;
  from: number;
  seconds: number;
  trim: number;
}

/**
 * A family of the bed: its layers' voices, its synthesis's voices, where
 * its recordings play into, and as last set its level (a gain), its
 * layers' shares and its synthesis's share.
 */
interface Family {
  voices: readonly Voice[];
  synths: GainNode[];
  out: AudioNode;
  match: number;
  layers: (Layer | null)[];
  level: number;
  shares: number[];
  synth: number;
}

/** A shot's recordings: its takes, their trims, notes (Hz, 0 for none) and loops (s), and the last played. */
interface Takes {
  buffers: AudioBuffer[];
  trims: number[];
  notes: number[];
  loops: ([number, number] | null)[];
  last: number;
}

/** The voices played once, as the mix lists them. */
type ShotVoice = keyof MixRecipe['shots'];

/** A recording chosen for a sound played once: its take, how it is varied, and how long it plays at that rate, s. */
interface Chosen {
  voice: ShotVoice;
  take: number;
  buffer: AudioBuffer;
  trim: number;
  note: number;
  loop: [number, number] | null;
  rate: number;
  gain: number;
  seconds: number;
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
  surf: BedVoice;
  /** The wind's recordings' low-pass and gain, which its gusts open. */
  windLow: BiquadFilterNode;
  windGust: GainNode;
  /** The halyards, panned toward the quay. */
  halyardsPan: StereoPannerNode;
  families: Record<FamilyName, Family>;
  /** The shots' recordings, by voice. */
  takes: Map<Voice, Takes>;
  /** The fog signals' tones, by device: made once each. */
  waves: Map<string, PeriodicWave>;
  /** The sounds playing once, held to their limits. */
  voices: Voices;
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
  // The surf on a shore near.
  const surf = bed('brown', [band('bandpass', m.surf.centre, m.surf.q)]);

  // Where each family's recordings play: the wind's through the low-pass
  // its gusts open; the lapping's and the halyards' panned.
  const windLow = band('lowpass', m.layers.wind.gust.lowpass[0] ?? 2500, 0.7);
  const windGust = ctx.createGain();
  windLow.connect(windGust);
  windGust.connect(mix.input('sea'));
  const halyardsPan = ctx.createStereoPanner();
  halyardsPan.connect(mix.input('world'));
  const family = (name: FamilyName, synths: BedVoice[], out: AudioNode): Family => {
    const f = m.layers[name];
    return {
      voices: f.voices as Voice[],
      synths: synths.map((v) => v.synth),
      out,
      match: f.match,
      layers: f.voices.map(() => null),
      level: 0,
      shares: f.voices.map(() => 0),
      synth: 1,
    };
  };
  const families: Record<FamilyName, Family> = {
    wind: family('wind', [wind], windLow),
    hull: family('hull', [water, hiss], mix.input('sea')),
    sea: family('sea', [sea], mix.input('sea')),
    rain: family('rain', [rain, drum], mix.input('sea')),
    flog: family('flog', [flog], mix.input('sea')),
    lapping: family('lapping', [lapping], lappingPan),
    calm: family('calm', [calm], mix.input('sea')),
    surf: family('surf', [surf], mix.input('sea')),
    halyards: family('halyards', [], halyardsPan),
  };

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
    surf,
    windLow,
    windGust,
    halyardsPan,
    families,
    takes: new Map(),
    waves: new Map(),
    voices: new Voices(m.voices),
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
  readonly #slaps: SlapWatch;
  readonly #sail: SailWatch;
  /** How many times the parameters were set, and contexts made (tests). */
  updates = 0;
  contexts = 0;

  constructor(recipes: Recipes = RECIPES, options: EngineOptions = {}) {
    this.#recipes = recipes;
    this.#mix = options.mix ?? MIX;
    this.#slaps = new SlapWatch(this.#mix.slaps);
    this.#sail = new SailWatch(this.#mix.sail);
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
    this.#startLoading();
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
      this.#startLoading();
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
    const calm = calmLevel(m.calm, input.speed, input.time);
    g.calm.level.gain.setTargetAtTime(calm, at, glide);
    const surf =
      gainOf(b.trims.surf) *
      surfLevel(m.surf, input.depth ?? Number.NaN, input.seaHeight, input.time);
    g.surf.level.gain.setTargetAtTime(surf, at, glide);

    // The families' recordings, at the level their synthesis plays at.
    const on = (level: number, most: number, trim: number): number =>
      gainOf(trim) * curved(level, most, b.curve);
    const L = m.layers;
    this.#family(g, 'wind', on(t.windLevel, r.wind.level.most, b.trims.wind), input.apparentWind);
    const gusting = ramp(L.wind.gust.from, L.wind.gust.full, input.gustFactor ?? 1);
    const [still, gust] = L.wind.gust.lowpass;
    g.windLow.frequency.setTargetAtTime(
      (still ?? 2500) + ((gust ?? 7000) - (still ?? 2500)) * gusting,
      at,
      glide,
    );
    g.windGust.gain.setTargetAtTime(gainOf(L.wind.gust.gain * gusting), at, glide);
    const hullSpeed =
      r.water.hiss.hullSpeed *
      Math.sqrt((input.waterline ?? r.water.hiss.waterline) / r.water.hiss.waterline);
    this.#family(
      g,
      'hull',
      Math.hypot(
        on(t.waterLevel, r.water.level.most, b.trims.water),
        on(t.hissLevel, r.water.hiss.most, b.trims.hiss),
      ),
      Math.abs(input.speed) / hullSpeed,
    );
    this.#family(
      g,
      'sea',
      on(t.seaLevel, r.sea.level.most, b.trims.sea),
      input.seaHeight + L.sea.whitecaps * input.whitecaps,
    );
    this.#family(
      g,
      'rain',
      Math.hypot(
        on(t.rainLevel, r.rain.level.most, b.trims.rain),
        on(t.drumLevel, r.rain.drumLevel.most, b.trims.drum),
      ),
      input.rain ?? 0,
    );
    this.#family(g, 'flog', on(t.flogLevel, r.flogging.level.most, b.trims.flog), 0);
    this.#family(g, 'calm', calm, 0);
    this.#family(g, 'surf', surf, 0);
    this.#wind = input.apparentWind;

    // What the boat's motion makes once.
    const slap = this.#slaps.step(input.pitchRate ?? 0, input.heaveRate ?? 0, input.time);
    if (slap !== null) {
      this.#playSlap(g, slap);
    }
    const sail = this.#sail.step(
      input.boom ?? Number.NaN,
      input.boomRate ?? 0,
      input.apparentAngle ?? 0,
      input.apparentWind,
    );
    if (sail !== null) {
      this.#playSail(g, sail);
    }
  }

  /** The apparent wind as the bed was last set, m/s: the halyards swing in it. */
  #wind = 0;
  /** How many slaps, sheets, booms and halyards' taps were played (tests). */
  slaps = 0;
  sheets = 0;
  booms = 0;
  taps = 0;

  /**
   * Sets a family at a level (a gain) and where the physics is in it (x, on
   * its layers' scale): each layer that plays a recording at its share of
   * the level, as far as it has taken over, and the synthesis at the share
   * they leave.
   */
  #family(g: Graph, name: FamilyName, level: number, x: number): void {
    const f = g.families[name];
    const at = g.ctx.currentTime;
    const glide = this.#mix.fades.glide;
    f.level = level;
    if (f.voices.length > 1) {
      shares(x, this.#mix.layers[name as 'wind'].at, f.shares);
    } else {
      f.shares[0] = 1;
    }
    let left = 1;
    for (let i = 0; i < f.layers.length; i++) {
      const l = f.layers[i];
      if (l === null || l === undefined) {
        continue;
      }
      const take = takeOf(at - l.from, l.seconds);
      const share = f.shares[i] ?? 0;
      left -= (share * take) ** 2;
      l.gain.gain.setTargetAtTime(level * share * take * l.trim, at, glide);
    }
    const synth = Math.sqrt(Math.max(0, left));
    f.synth = synth;
    for (const v of f.synths) {
      v.gain.setTargetAtTime(synth, at, glide);
    }
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
    const lapping = gainOf(this.#mix.bed.trims.lapping) * lap.level;
    g.lapping.level.gain.setTargetAtTime(lapping, at, SLOW);
    g.lappingPan.pan.setTargetAtTime(lap.pan, at, SLOW);
    this.#family(g, 'lapping', lapping, 0);
    // The halyards, toward the quay where the boats lie.
    const halyards = halyardsLevel(this.#mix.halyards, x.inPort, this.#wind);
    g.halyardsPan.pan.setTargetAtTime(lap.pan, at, SLOW);
    this.#family(g, 'halyards', halyards, 0);
    // A jump in world time (a new world, a restore) plays nothing missed.
    if (!(x.seconds - this.#harbourTo < 2) || x.seconds < this.#harbourTo) {
      this.#harbourTo = x.seconds;
      return;
    }
    for (const e of harbourEvents(this.#harbour, x, this.#harbourTo, x.seconds, secondsPerHour)) {
      this.#play(g, e, at + Math.max(0, e.at - x.seconds), 'world');
    }
    // Their taps, synthesised, at the share a recording of them leaves.
    const synth = g.families.halyards.synth;
    for (const tap of halyardTaps(
      this.#mix.halyards,
      this.#harbourTo,
      x.seconds,
      halyards * synth,
      this.#wind,
    )) {
      this.#playTap(g, tap, at + Math.max(0, tap.at - x.seconds));
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
    const ctx = g.ctx;
    const unit = (k: number): number => this.#unit(e.seed, k);
    const between = (r: number[], k: number): number =>
      (r[0] ?? 0) + unit(k) * ((r[1] ?? 0) - (r[0] ?? 0));
    // A colony's harsh calls and rattles are its recordings' where it has
    // them; its whistles, and a blowhole's boom, stay synthesised.
    const call = e.kind !== 'boom';
    const rec =
      e.kind === 'harsh' || e.kind === 'rattle' ? this.#choose(g, 'colony', e.seed) : null;
    const v = call ? this.#vary('colony', e.seed) : { rate: 1, gain: 1 };
    const length =
      rec?.seconds ??
      (e.kind === 'boom'
        ? 5 * this.#features.blowhole.decay
        : between(this.#features.colony[e.kind].note, 2));
    const pan = this.#shot(g, 'world', e.pan, call ? 'seabirds' : null, e.level, at, at + length);
    if (pan === null) {
      return;
    }
    this.featureEvents++;
    if (rec !== null) {
      this.#start(g, rec, at, e.level, pan);
      return;
    }
    const level = e.level * v.gain;
    const nodes: AudioNode[] = [pan];
    if (e.kind === 'boom') {
      // A thump falling in pitch, and the air's whoosh out of the vent.
      const c = this.#features.blowhole;
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(c.thump * 1.6, at);
      o.frequency.exponentialRampToValueAtTime(c.thump, at + c.decay);
      const thump = ctx.createGain();
      thump.gain.setValueAtTime(e.level, at);
      thump.gain.setTargetAtTime(0, at + 0.01, c.decay / 2);
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
      o.connect(thump);
      thump.connect(pan);
      burst.connect(bandp);
      bandp.connect(whoosh);
      whoosh.connect(pan);
      const end = at + 5 * c.decay;
      o.start(at);
      o.stop(end);
      burst.start(at, (e.seed % 10) * 0.1);
      burst.stop(end);
      nodes.push(o, thump, burst, bandp, whoosh);
    } else {
      // A call: a rasp, a whistle or a rattle.
      const c = this.#features.colony;
      const r = c[e.kind];
      const pitch = between(r.pitch, 1) * v.rate;
      const note = between(r.note, 2);
      const o = ctx.createOscillator();
      o.type = e.kind === 'whistle' ? 'sine' : 'sawtooth';
      o.frequency.setValueAtTime(pitch, at);
      o.frequency.exponentialRampToValueAtTime(
        pitch * (e.kind === 'harsh' ? 0.75 : 1.1),
        at + note,
      );
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(
        level,
        at + Math.min(this.#mix.tone.birds.attack, note / 3),
      );
      gain.gain.linearRampToValueAtTime(0, at + note);
      if (e.kind === 'whistle') {
        o.connect(gain);
      } else {
        const soft = this.#soft(g, pitch);
        o.connect(soft);
        soft.connect(gain);
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
        gain.connect(gate);
        gate.connect(pan);
        beat.start(at);
        beat.stop(at + note);
        nodes.push(beat, depth, gate);
      } else {
        gain.connect(pan);
      }
      o.start(at);
      o.stop(at + note);
      nodes.push(o, gain);
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
    const ctx = g.ctx;
    const c = this.#water[s.kind];
    const unit = (k: number): number => this.#unit(s.seed, k);
    const at = ctx.currentTime;
    // A splash, a dolphin's breath and a whale's blow are their recordings'
    // where they have them; the rest stay synthesised, varied as a splash.
    const voice = s.kind === 'breath' ? 'breath' : s.kind === 'blow' ? 'blow' : 'splash';
    const rec = s.kind === voice ? this.#choose(g, voice, s.seed) : null;
    const v = this.#vary(voice, s.seed);
    const length =
      (c.length[0] ?? 0.2) + unit(1) * ((c.length[1] ?? 0.4) - (c.length[0] ?? 0.2)) * s.size;
    const pan = this.#shot(
      g,
      'world',
      s.pan,
      'splashes',
      s.level,
      at,
      at + (rec?.seconds ?? length + 0.05),
    );
    if (pan === null) {
      return;
    }
    this.waterSounds++;
    if (rec !== null) {
      this.#start(g, rec, at, s.level, pan);
      return;
    }
    const f = ((c.band[0] ?? 800) + unit(2) * ((c.band[1] ?? 1600) - (c.band[0] ?? 800))) * v.rate;
    const burst = ctx.createBufferSource();
    burst.buffer = g.noise.white;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = c.q;
    band.frequency.setValueAtTime(f, at);
    band.frequency.exponentialRampToValueAtTime(f * c.fall, at + length);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(s.level * v.gain, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
    burst.connect(band);
    band.connect(gain);
    gain.connect(pan);
    burst.start(at, unit(3) * 2);
    burst.stop(at + length + 0.05);
    burst.onended = () => {
      for (const n of [burst, band, gain, pan]) {
        n.disconnect();
      }
    };
  }

  #playLife(g: Graph, e: LifeEvent, at: number): void {
    if (!(e.level > 0)) {
      return;
    }
    const ctx = g.ctx;
    const r = this.#life;
    const unit = (k: number): number => this.#unit(e.seed, k);
    const between = (p: readonly number[], k: number): number =>
      (p[0] ?? 0) + unit(k) * ((p[1] ?? 0) - (p[0] ?? 0));
    // The laugh's and the tern's calls are their recordings' where they have
    // them; the booby's whistle stays synthesised.
    const voice = e.kind === 'tern' ? 'seabird.tern' : 'seabird.laugh';
    const rec = e.kind === 'whistle' ? null : this.#choose(g, voice, e.seed);
    const vary = this.#vary(voice, e.seed);
    const laughs = Math.round(between(r.laugh.notes, 2));
    const length =
      e.kind === 'whistle'
        ? between(r.whistle.note, 2)
        : e.kind === 'laugh'
          ? Array.from(
              { length: laughs },
              (_, k) => between(r.laugh.note, 3 + k) + r.laugh.gap,
            ).reduce((a, b) => a + b, 0)
          : r.tern.syllables.reduce((a, b) => a + b + r.tern.gap, 0);
    const pan = this.#shot(
      g,
      'world',
      e.pan,
      'seabirds',
      e.level,
      at,
      at + (rec?.seconds ?? length),
    );
    if (pan === null) {
      return;
    }
    this.lifeEvents++;
    if (rec !== null) {
      this.#start(g, rec, at, e.level, pan);
      return;
    }
    const level = e.level * vary.gain;
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
      v.gain.linearRampToValueAtTime(level, t + Math.min(this.#mix.tone.birds.attack, length / 4));
      v.gain.linearRampToValueAtTime(0, t + length);
    };
    if (e.kind === 'whistle') {
      // A thin whistle, rising a little at its end.
      const c = r.whistle;
      const pitch = between(c.pitch, 1) * vary.rate;
      o.type = 'sine';
      note(pitch, pitch * c.rise, length);
      o.connect(v);
      t += length;
    } else {
      // A nasal voice: a harmonic tone through a band at the call's pitch,
      // its fundamental an octave under it.
      const c = e.kind === 'laugh' ? r.laugh : r.tern;
      const pitch = between(c.pitch, 1) * vary.rate;
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
        for (let k = 0; k < laughs; k++) {
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
    const ctx = g.ctx;
    const r = this.#harbour;
    // The gull's notes, drawn from its seed: how many, its pitch, each's length.
    const draw = (k: number): number => this.#unit(e.seed, k);
    const voice = e.kind === 'bell' ? 'bell' : e.kind === 'gull' ? 'gull' : null;
    const rec = voice === null ? null : this.#choose(g, voice, e.seed);
    const v = voice === null ? { rate: 1, gain: 1 } : this.#vary(voice, e.seed);
    const c = r.gulls;
    const notes = Math.round((c.notes[0] ?? 3) + draw(1) * ((c.notes[1] ?? 7) - (c.notes[0] ?? 3)));
    const lengths: number[] = [];
    for (let k = 0; k < notes; k++) {
      lengths.push((c.note[0] ?? 0.2) + draw(3 + k) * ((c.note[1] ?? 0.3) - (c.note[0] ?? 0.2)));
    }
    const length =
      rec?.seconds ??
      (e.kind === 'bell'
        ? 2 * Math.max(...r.bell.decays)
        : e.kind === 'gull'
          ? lengths.reduce((s, l) => s + l + c.gap, 0)
          : 10 * r.mallets.decay);
    const family = e.kind === 'gull' ? 'gulls' : null;
    const pan = this.#shot(g, bus, e.pan, family, e.level, at, at + length);
    if (pan === null) {
      return;
    }
    this.harbourEvents++;
    if (rec !== null) {
      this.#start(g, rec, at, e.level, pan);
      return;
    }
    const level = e.level * v.gain;
    const nodes: AudioNode[] = [pan];
    let end = at;
    if (e.kind === 'bell') {
      // Its partials, each dying away over its own decay.
      bellPartials(r.bell).forEach((f, i) => {
        const o = ctx.createOscillator();
        o.frequency.value = f;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(level * (r.bell.levels[i] ?? 0.3), at + 0.004);
        const decay = r.bell.decays[i] ?? 1;
        gain.gain.setTargetAtTime(0, at + 0.004, decay / 3);
        o.connect(gain);
        gain.connect(pan);
        o.start(at);
        o.stop(at + decay * 2);
        end = Math.max(end, at + decay * 2);
        nodes.push(o, gain);
      });
    } else if (e.kind === 'gull') {
      // A long call: notes of a harmonic voice, each falling at its end.
      const pitch =
        ((c.pitch[0] ?? 1100) + draw(2) * ((c.pitch[1] ?? 1500) - (c.pitch[0] ?? 1100))) * v.rate;
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const bandp = ctx.createBiquadFilter();
      bandp.type = 'bandpass';
      bandp.frequency.value = pitch;
      bandp.Q.value = c.q;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, at);
      let t = at;
      for (const note of lengths) {
        o.frequency.setValueAtTime(pitch / 2, t);
        o.frequency.exponentialRampToValueAtTime((pitch / 2) * c.fall, t + note);
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(
          level,
          t + Math.min(this.#mix.tone.birds.attack, note / 3),
        );
        gain.gain.linearRampToValueAtTime(0, t + note);
        t += note + c.gap;
      }
      const soft = this.#soft(g, pitch);
      o.connect(bandp);
      bandp.connect(soft);
      soft.connect(gain);
      gain.connect(pan);
      o.start(at);
      o.stop(t);
      end = t;
      nodes.push(o, bandp, soft, gain);
    } else {
      // A mallet's blow: a falling tone and a crack.
      const m = r.mallets;
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(m.thump, at);
      o.frequency.exponentialRampToValueAtTime(m.thump * 0.6, at + 4 * m.decay);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(level, at);
      gain.gain.setTargetAtTime(0, at + 0.003, m.decay);
      const burst = ctx.createBufferSource();
      burst.buffer = g.noise.white;
      const bandp = ctx.createBiquadFilter();
      bandp.type = 'bandpass';
      bandp.frequency.value = m.crack;
      bandp.Q.value = m.q;
      const crack = ctx.createGain();
      crack.gain.setValueAtTime(0.6 * level, at);
      crack.gain.setTargetAtTime(0, at + 0.002, m.decay / 2);
      o.connect(gain);
      gain.connect(pan);
      burst.connect(bandp);
      bandp.connect(crack);
      crack.connect(pan);
      end = at + 10 * m.decay;
      o.start(at);
      o.stop(end);
      burst.start(at, (e.seed % 10) * 0.1);
      burst.stop(end);
      nodes.push(o, gain, burst, bandp, crack);
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
   * A blast: the device's tone, swelling in over the attack, held, and dying
   * away over the release after it ends, through a low-pass never above the
   * air's over its distance. The tone is the device's own recording where
   * it has one; else one recording of a horn played at the device's pitch,
   * its note moved as the device's moves; else the device's harmonics
   * through a low-pass that opens as the blast swells. A recording loops
   * the stretch its numbers give to sound as long as the blast. Never
   * varied: a signal is known by its sound. The nearest dips the sea.
   */
  #playBlast(g: Graph, e: FogSignalEvent, at: number): void {
    if (!(e.level > 0) || !(e.length > 0)) {
      return;
    }
    const ctx = g.ctx;
    const r = this.#fog;
    const device = r[e.device];
    const end = at + e.length;
    const stop = end + 2 * device.release;
    const own = this.#choose(g, `fog.${e.device}` as ShotVoice, 0);
    const pitched = own === null ? this.#choose(g, 'fog', 0) : null;
    const rec = own ?? (pitched !== null && pitched.note > 0 ? pitched : null);
    const pan = this.#shot(g, 'world', e.pan, 'fog', e.level, at, stop);
    if (pan === null) {
      return;
    }
    this.fogSignalEvents++;
    // Heard from within the duck's distance: a fog signal's level falls as
    // its near distance over the distance.
    if (e.level >= device.level * Math.min(1, device.near / this.#mix.duck.fog)) {
      this.#dip(g, at);
    }
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.Q.value = 0.7;
    const v = ctx.createGain();
    v.gain.setValueAtTime(0, at);
    v.gain.linearRampToValueAtTime(e.level, at + Math.min(device.attack, e.length / 3));
    v.gain.setValueAtTime(e.level, end);
    v.gain.setTargetAtTime(0, end, device.release / 3);
    low.connect(v);
    v.connect(pan);
    const nodes: AudioNode[] = [low, v, pan];
    // The tone's pitch, Hz, set on the oscillator, or on the recording's
    // rate as a share of its note.
    let source: AudioScheduledSourceNode;
    let tone: { param: AudioParam; per: number };
    if (rec !== null) {
      const played = this.#start(g, rec, at, 1, low);
      const s = played.source;
      if (rec.loop !== null) {
        s.loop = true;
        s.loopStart = rec.loop[0];
        s.loopEnd = rec.loop[1];
      }
      s.stop(stop);
      source = s;
      tone = { param: s.playbackRate, per: rec === own ? 0 : 1 / rec.note };
      low.frequency.value = e.cutoff;
    } else {
      const o = ctx.createOscillator();
      o.setPeriodicWave(this.#wave(g, e.device));
      o.connect(low);
      o.start(at);
      o.stop(stop);
      nodes.push(o);
      source = o;
      tone = { param: o.frequency, per: 1 };
    }
    const synth = rec === null;
    // A device's own recording keeps its own pitch.
    const f = {
      set: (hz: number, t: number): void => {
        if (tone.per > 0) {
          tone.param.setValueAtTime(hz * tone.per, t);
        }
      },
      exp: (hz: number, t: number): void => {
        if (tone.per > 0) {
          tone.param.exponentialRampToValueAtTime(hz * tone.per, t);
        }
      },
    };
    // A horn's low-pass opens as the blast swells: it brightens as it grows louder.
    const swell = (c: { from: number; to: number; open: number }): void => {
      if (!synth) {
        return;
      }
      low.frequency.setValueAtTime(Math.min(c.from, e.cutoff), at);
      low.frequency.exponentialRampToValueAtTime(
        Math.min(c.to, e.cutoff),
        at + Math.min(c.open, e.length),
      );
    };
    if (e.device === 'diaphone') {
      // Its pitch sags as the air runs out, then drops in the grunt.
      const c = r.diaphone;
      const grunt = Math.min(c.gruntTime, e.length / 3);
      f.set(c.pitch, at);
      f.exp(c.sag, end - grunt);
      f.exp(c.sag * c.grunt, end - grunt + Math.min(0.04, grunt));
      swell(c.cutoff);
    } else if (e.device === 'twotone') {
      // The high tone, then the low held to the end.
      const c = r.twotone;
      const high = e.tones[0] ?? c.pitch;
      const turn = at + c.high * e.length;
      f.set(high, at);
      f.set(high, turn);
      f.exp(e.tones[1] ?? c.low, turn + c.glide);
      swell(c.cutoff);
    } else if (e.device === 'siren') {
      // The wail: rising as the rotor spins up, falling at the end.
      const c = r.siren;
      const k = Math.min(1, e.length / (c.rise + c.fall));
      f.set(c.low, at);
      f.exp(e.tones[0] ?? c.pitch, at + c.rise * k);
      f.set(e.tones[0] ?? c.pitch, end - c.fall * k);
      f.exp(c.low, end);
      if (synth) {
        low.frequency.value = Math.min(c.cutoff, e.cutoff);
      }
    } else {
      // A reed's note, wavering a few cents.
      const c = r.reedhorn;
      const pitch = e.tones[0] ?? c.pitch;
      f.set(pitch, at);
      if (tone.per > 0) {
        const lfo = ctx.createOscillator();
        lfo.frequency.value = c.vibrato.rate;
        const depth = ctx.createGain();
        depth.gain.value = pitch * tone.per * (2 ** (c.vibrato.cents / 1200) - 1);
        lfo.connect(depth);
        depth.connect(tone.param);
        lfo.start(at);
        lfo.stop(stop);
        nodes.push(lfo, depth);
      }
      if (synth) {
        low.frequency.value = Math.min(c.cutoff, e.cutoff);
      }
    }
    this.#whenEnded(source, nodes);
  }

  /** Lets nodes go when source ends, after what its onended already does. */
  #whenEnded(source: AudioScheduledSourceNode, nodes: AudioNode[]): void {
    const before = source.onended;
    source.onended = (ev) => {
      if (typeof before === 'function') {
        before.call(source, ev);
      }
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
    const ctx = g.ctx;
    const r = this.#thunder;
    const unit = (k: number): number => this.#unit(e.seed, k);
    const hold = at + Math.max(e.length, 0.3);
    const stop = hold + 1.5 * r.roll;
    // Its recording, a near one's crack or a far one's roll, else the
    // other's, else the synthesis; louder or softer by its seed.
    const near = this.#choose(g, 'thunder.near', e.seed);
    const far = this.#choose(g, 'thunder.far', e.seed);
    const rec = e.crack ? (near ?? far) : (far ?? near);
    const vary = this.#vary('thunder.near', e.seed);
    const pan = this.#shot(
      g,
      'world',
      e.pan,
      'thunder',
      e.level,
      at,
      rec === null ? stop : at + rec.seconds,
    );
    if (pan === null) {
      return;
    }
    this.thunderEvents++;
    const lowpass = (frequency: number): BiquadFilterNode => {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = frequency;
      f.Q.value = 0.7;
      return f;
    };
    if (rec !== null) {
      // Dulled by the air over its distance.
      const air = lowpass(e.cutoff);
      air.connect(pan);
      const s = this.#start(g, rec, at, e.level, air).source;
      this.#whenEnded(s, [air, pan]);
      return;
    }
    const level = e.level * vary.gain;
    const burst = ctx.createBufferSource();
    burst.buffer = g.noise.white;
    burst.loop = true;
    const nodes: AudioNode[] = [burst, pan];

    // The rumble: its swells drawn from the flash's seed, each fainter as
    // the sound comes from farther along the channel.
    const rumbleLow = lowpass(Math.min(r.rumble.cutoff, e.cutoff));
    const rumble = ctx.createGain();
    const rumbleLevel = level * r.rumble.level;
    const step = 1 / r.rumble.swells;
    const nearest = Math.max(e.distance, r.near);
    rumble.gain.setValueAtTime(0, at);
    rumble.gain.linearRampToValueAtTime(rumbleLevel * (1 - r.rumble.depth * unit(0)), at + 0.15);
    for (let k = 1; at + k * step < hold; k++) {
      const fade = nearest / (nearest + this.#thunderRule.speed * k * step);
      rumble.gain.setTargetAtTime(
        rumbleLevel * fade * (1 - r.rumble.depth * unit(k)),
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
    deep.gain.linearRampToValueAtTime(level * r.deep.level, at + 0.3);
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
      crack.gain.setValueAtTime(level * r.crack.level, at);
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

  /** How many scrapes were played (tests). */
  scrapes = 0;

  /**
   * Plays a hull's scrape on the bottom once: its recording, or band-passed
   * noise swelling and dying away. Its seed is its own numbers, which every
   * phone hearing it has alike.
   */
  scrape(sc: Scrape): void {
    const g = this.#graph;
    if (g === null || !this.#live(g) || !(sc.level > 0)) {
      return;
    }
    const ctx = g.ctx;
    const at = ctx.currentTime;
    const seed = Math.round(sc.band * 7 + sc.level * 1000);
    const rec = this.#choose(g, 'scrape', seed);
    const end = at + sc.rise + 8 * sc.decay;
    const out = this.#shot(
      g,
      'boat',
      0,
      'knocks',
      sc.level,
      at,
      rec === null ? end : at + rec.seconds,
    );
    if (out === null) {
      return;
    }
    this.scrapes++;
    if (rec !== null) {
      this.#start(g, rec, at, sc.level, out);
      return;
    }
    const v = this.#vary('scrape', seed);
    const burst = ctx.createBufferSource();
    burst.buffer = g.noise.white;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = sc.band * v.rate;
    band.Q.value = sc.q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(sc.level * v.gain, at + sc.rise);
    gain.gain.setTargetAtTime(0, at + sc.rise, sc.decay);
    burst.connect(band);
    band.connect(gain);
    gain.connect(out);
    burst.start(at, 0.7);
    burst.stop(end);
    burst.onended = () => {
      for (const n of [burst, band, gain, out]) {
        n.disconnect();
      }
    };
  }

  /**
   * Plays a bump's knock once: its recording, or a thump falling in pitch
   * and a crack of noise, each dying away; placed left or right. Its seed is
   * the knock's own numbers (how hard the hulls closed), which every phone
   * hearing it has alike.
   */
  knock(k: Knock): void {
    const g = this.#graph;
    if (g === null || !this.#live(g) || !(k.level > 0)) {
      return;
    }
    const ctx = g.ctx;
    const at = ctx.currentTime;
    const seed = Math.round(k.thump * 13 + k.crack);
    const rec = this.#choose(g, 'knock', seed);
    const end = at + 8 * Math.max(k.thumpDecay, k.crackDecay);
    const pan = this.#shot(
      g,
      'boat',
      k.pan,
      'knocks',
      k.level,
      at,
      rec === null ? end : at + rec.seconds,
    );
    if (pan === null) {
      return;
    }
    this.knocks++;
    if (rec !== null) {
      this.#start(g, rec, at, k.level, pan);
      return;
    }
    const v = this.#vary('knock', seed);
    const level = k.level * v.gain;

    const tone = ctx.createOscillator();
    tone.type = 'sine';
    tone.frequency.setValueAtTime(k.thump * v.rate, at);
    tone.frequency.exponentialRampToValueAtTime(
      Math.max(20, k.thump * v.rate * k.fall),
      at + 4 * k.thumpDecay,
    );
    const thump = ctx.createGain();
    thump.gain.setValueAtTime(level, at);
    thump.gain.setTargetAtTime(0, at + 0.004, k.thumpDecay);
    tone.connect(thump);
    thump.connect(pan);

    const burst = ctx.createBufferSource();
    burst.buffer = g.noise.white;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = k.crack * v.rate;
    band.Q.value = k.q;
    const crack = ctx.createGain();
    crack.gain.setValueAtTime(0.8 * level, at);
    crack.gain.setTargetAtTime(0, at + 0.002, k.crackDecay);
    burst.connect(band);
    band.connect(crack);
    crack.connect(pan);

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
    const r = GUN;
    const ctx = g.ctx;
    const at = ctx.currentTime + g0.delay;
    const rec = this.#choose(g, 'gun', 0);
    const lastEcho = Math.max(0, ...g0.echoes.map((e) => e.delay));
    const length =
      rec === null
        ? Math.max(3 * r.thump.decay, lastEcho + 2 * r.boom.decay)
        : lastEcho + rec.seconds;
    const pan = this.#shot(g, 'races', g0.pan, null, g0.level, at, at + length);
    if (pan === null) {
      return;
    }
    this.guns++;
    if (g0.level >= this.#mix.duck.gun * r.level) {
      this.#dip(g, at);
    }
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    air.frequency.value = g0.cutoff;
    air.Q.value = 0.7;
    air.connect(pan);
    const nodes: AudioNode[] = [pan, air];
    if (rec !== null) {
      // Its recording, its crack shelved down: a report across the water,
      // not a snap at the ear; then its echoes, each a later copy of it,
      // fainter and duller.
      const shelf = ctx.createBiquadFilter();
      shelf.type = 'highshelf';
      shelf.frequency.value = this.#mix.tone.gunCrack;
      shelf.gain.value = this.#mix.tone.gunShelf;
      shelf.connect(air);
      nodes.push(shelf);
      this.#start(g, rec, at, g0.level, shelf);
      for (const e of g0.echoes) {
        const low = ctx.createBiquadFilter();
        low.type = 'lowpass';
        low.frequency.value = e.cutoff;
        low.Q.value = 0.7;
        low.connect(shelf);
        const s = ctx.createBufferSource();
        s.buffer = rec.buffer;
        const v = ctx.createGain();
        v.gain.value = g0.level * rec.trim * e.level;
        s.connect(v);
        v.connect(low);
        s.start(at + e.delay);
        nodes.push(low, s, v);
      }
      const done = ctx.createConstantSource();
      done.start(at);
      done.stop(at + length + 0.1);
      this.#whenEnded(done, nodes);
      return;
    }

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
   * heard. Where the crowds' recordings have come, the small, the medium
   * and the large are crossfaded by how many cheered, through the same
   * low-pass; and the player's own is its recording, near and short. The
   * crowd's cheer dips the sea.
   */
  cheer(c: CheerSound): void {
    const g = this.#graph;
    if (g === null || !this.#live(g) || !(c.level > 0)) {
      return;
    }
    const r = CHEER;
    const ctx = g.ctx;
    const t0 = ctx.currentTime + 0.02;
    const seed = c.count * 31 + (c.own ? 7 : 0);
    // The recordings: the player's own, or each crowd at its share.
    const recs: { rec: Chosen; share: number }[] = [];
    if (c.own) {
      const rec = this.#choose(g, 'cheer.own', seed);
      if (rec !== null) {
        recs.push({ rec, share: 1 });
      }
    } else {
      const sizes = (['crowd.small', 'crowd.medium', 'crowd.large'] as const)
        .map((voice, i) => ({ voice, at: Math.log2(this.#mix.crowd.at[i] ?? 1) }))
        .filter((s) => (g.takes.get(s.voice)?.buffers.length ?? 0) > 0);
      const each = shares(
        Math.log2(Math.max(1, c.count)),
        sizes.map((s) => s.at),
      );
      sizes.forEach((s, i) => {
        const share = each[i] ?? 0;
        const rec = share > 0.01 ? this.#choose(g, s.voice, seed) : null;
        if (rec !== null) {
          recs.push({ rec, share });
        }
      });
    }
    const length =
      recs.length > 0
        ? Math.max(...recs.map((x) => x.rec.seconds))
        : Math.max(
            r.roar.length * 1.6,
            ...c.voices.map((v) => v.at + r.breath.length * 0.7 + v.length + 0.3),
          );
    const out = this.#shot(g, 'races', 0, null, c.level, t0, t0 + length);
    if (out === null) {
      return;
    }
    this.cheers++;
    if (!c.own) {
      this.#dip(g, t0);
    }
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    air.frequency.value = c.cutoff;
    air.Q.value = 0.7;
    air.connect(out);
    if (recs.length > 0) {
      let last: AudioScheduledSourceNode | null = null;
      for (const x of recs) {
        last = this.#start(g, x.rec, t0, c.level * x.share, air).source;
      }
      if (last !== null) {
        this.#whenEnded(last, [air, out]);
      }
      return;
    }
    const level = ctx.createGain();
    level.gain.value = c.level;
    level.connect(air);
    const nodes: AudioNode[] = [out, air, level];
    let end = t0;
    for (const v of c.voices) {
      const at = t0 + v.at;
      const pan = ctx.createStereoPanner();
      pan.pan.value = v.pan;
      pan.connect(level);
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
      rg.connect(level);
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
      pan.connect(level);
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

  /** A number from 0 to 1 for a seed and a draw. */
  #unit(seed: number, k: number): number {
    return unit(seed, k);
  }

  /** How a voice played once is varied for a seed: none for a signal. */
  #vary(voice: ShotVoice, seed: number): Variation {
    const s = this.#mix.shots[voice];
    return vary(seed, s.pitch, s.level);
  }

  /**
   * The recording a voice played once plays for a seed, if it has any: the
   * take the seed picks (a signal's first), varied as the voice is.
   */
  #choose(g: Graph, voice: ShotVoice, seed: number): Chosen | null {
    const t = g.takes.get(voice);
    const n = t?.buffers.length ?? 0;
    if (t === undefined || n === 0) {
      return null;
    }
    const s = this.#mix.shots[voice];
    const signal = s.pitch === 0 && s.level === 0;
    const k = signal ? 0 : pickTake(seed, n, t.last);
    const buffer = t.buffers[k] as AudioBuffer;
    const v = this.#vary(voice, seed);
    return {
      voice,
      take: k,
      buffer,
      trim: t.trims[k] ?? 1,
      note: t.notes[k] ?? 0,
      loop: t.loops[k] ?? null,
      rate: v.rate,
      gain: v.gain,
      seconds: buffer.duration / v.rate,
    };
  }

  /** What was played of the voices' recordings, the latest last (tests, the sound room). */
  readonly heard: { voice: Voice; take: number; rate: number; gain: number }[] = [];

  /**
   * Plays a chosen recording into out from at, at level times its trim and
   * variation, at its rate times rate: the source, to be stopped or shaped,
   * and its gain.
   */
  #start(
    g: Graph,
    c: Chosen,
    at: number,
    level: number,
    out: AudioNode,
    rate = 1,
  ): { source: AudioBufferSourceNode; gain: GainNode } {
    const t = g.takes.get(c.voice);
    if (t !== undefined) {
      t.last = c.take;
    }
    this.heard.push({ voice: c.voice, take: c.take, rate: c.rate * rate, gain: c.gain });
    if (this.heard.length > 256) {
      this.heard.splice(0, 128);
    }
    const ctx = g.ctx;
    const source = ctx.createBufferSource();
    source.buffer = c.buffer;
    source.playbackRate.value = c.rate * rate;
    const gain = ctx.createGain();
    gain.gain.value = level * c.trim * c.gain;
    source.connect(gain);
    gain.connect(out);
    source.start(at);
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
    };
    return { source, gain };
  }

  /**
   * A slap of the bow on a wave, through the sea's bus: its recording, or a
   * burst of the noise through a band and a low thump, both dying fast.
   */
  #playSlap(g: Graph, sl: Slap): void {
    if (!(sl.level > 0)) {
      return;
    }
    const c = this.#mix.slaps;
    const ctx = g.ctx;
    const at = ctx.currentTime;
    const rec = this.#choose(g, 'slap', sl.seed);
    const out = this.#shot(
      g,
      'sea',
      0,
      'splashes',
      sl.level,
      at,
      at + (rec?.seconds ?? 8 * c.decay),
    );
    if (out === null) {
      return;
    }
    this.slaps++;
    if (rec !== null) {
      this.#start(g, rec, at, sl.level, out);
      return;
    }
    const v = this.#vary('slap', sl.seed);
    const k = v.rate;
    const level = sl.level * v.gain;
    const lo = c.band[0] ?? 380;
    const hi = c.band[1] ?? 900;
    const burst = ctx.createBufferSource();
    burst.buffer = g.noise.white;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = c.q;
    band.frequency.setValueAtTime(hi * k, at);
    band.frequency.exponentialRampToValueAtTime(lo * k, at + 2 * c.decay);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(level, at + 0.006);
    gain.gain.setTargetAtTime(0, at + 0.006, c.decay);
    const tone = ctx.createOscillator();
    tone.frequency.setValueAtTime(c.thump * k * 1.4, at);
    tone.frequency.exponentialRampToValueAtTime(c.thump * k, at + c.decay);
    const thump = ctx.createGain();
    thump.gain.setValueAtTime(0, at);
    thump.gain.linearRampToValueAtTime(level * c.thumpLevel, at + 0.008);
    thump.gain.setTargetAtTime(0, at + 0.008, c.decay / 1.5);
    burst.connect(band);
    band.connect(gain);
    gain.connect(out);
    tone.connect(thump);
    thump.connect(out);
    const end = at + 8 * c.decay;
    burst.start(at, this.#unit(sl.seed, 3) * 8);
    burst.stop(end);
    tone.start(at);
    tone.stop(end);
    burst.onended = () => {
      for (const n of [burst, band, gain, tone, thump, out]) {
        n.disconnect();
      }
    };
  }

  /**
   * The sail crossing, through the boat's bus: the sheet running out through
   * its block in a tack, a band of noise fluttering as the rope's lay runs
   * over the sheave and slowing; the boom's thump in a gybe, a low knock of
   * wood. Its recording where it has one.
   */
  #playSail(g: Graph, sc: SailSound): void {
    if (!(sc.level > 0)) {
      return;
    }
    const c = this.#mix.sail;
    const ctx = g.ctx;
    const at = ctx.currentTime;
    const voice = sc.kind === 'sheet' ? 'sheet' : 'boom';
    const rec = this.#choose(g, voice, sc.seed);
    const length = rec?.seconds ?? (sc.kind === 'sheet' ? 2 * c.sheet.length : 8 * c.boom.decay);
    const out = this.#shot(g, 'boat', 0, null, sc.level, at, at + length);
    if (out === null) {
      return;
    }
    const nodes: AudioNode[] = [out];
    let end = at;
    const v = this.#vary(voice, sc.seed);
    const level = sc.level * v.gain;
    if (sc.kind === 'sheet') {
      this.sheets++;
      if (rec !== null) {
        this.#start(g, rec, at, sc.level, out);
        return;
      }
      const r = c.sheet;
      const burst = ctx.createBufferSource();
      burst.buffer = g.noise.white;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.Q.value = r.q;
      band.frequency.setValueAtTime(r.band * v.rate, at);
      band.frequency.exponentialRampToValueAtTime(r.band * v.rate * 0.6, at + r.length);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(level, at + 0.04);
      gain.gain.setTargetAtTime(0, at + 0.4 * r.length, r.length / 4);
      // The flutter: half the level beaten at the sheave's rate, slowing.
      const flutter = ctx.createGain();
      flutter.gain.value = 0.6;
      const beat = ctx.createOscillator();
      beat.frequency.setValueAtTime(r.rate, at);
      beat.frequency.exponentialRampToValueAtTime(r.rate * 0.4, at + r.length);
      const depth = ctx.createGain();
      depth.gain.value = 0.4;
      beat.connect(depth);
      depth.connect(flutter.gain);
      burst.connect(band);
      band.connect(flutter);
      flutter.connect(gain);
      gain.connect(out);
      end = at + 2 * r.length;
      burst.start(at, this.#unit(sc.seed, 1) * 8);
      burst.stop(end);
      beat.start(at);
      beat.stop(end);
      nodes.push(burst, band, gain, flutter, beat, depth);
    } else {
      this.booms++;
      if (rec !== null) {
        this.#start(g, rec, at, sc.level, out);
        return;
      }
      const r = c.boom;
      const tone = ctx.createOscillator();
      tone.frequency.setValueAtTime(r.thump * v.rate * 1.3, at);
      tone.frequency.exponentialRampToValueAtTime(r.thump * v.rate, at + r.decay);
      const thump = ctx.createGain();
      thump.gain.setValueAtTime(0, at);
      thump.gain.linearRampToValueAtTime(level, at + 0.005);
      thump.gain.setTargetAtTime(0, at + 0.005, r.decay);
      const burst = ctx.createBufferSource();
      burst.buffer = g.noise.white;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = r.knock * v.rate;
      band.Q.value = r.q;
      const knock = ctx.createGain();
      knock.gain.setValueAtTime(0, at);
      knock.gain.linearRampToValueAtTime(0.5 * level, at + 0.003);
      knock.gain.setTargetAtTime(0, at + 0.003, r.decay / 2);
      tone.connect(thump);
      thump.connect(out);
      burst.connect(band);
      band.connect(knock);
      knock.connect(out);
      end = at + 8 * r.decay;
      tone.start(at);
      tone.stop(end);
      burst.start(at, this.#unit(sc.seed, 2) * 8);
      burst.stop(end);
      nodes.push(tone, thump, burst, band, knock);
    }
    const first = nodes[1] as AudioScheduledSourceNode;
    first.onended = () => {
      for (const n of nodes) {
        n.disconnect();
      }
    };
  }

  /** A halyard's tap on its mast: a soft knock of wood, a narrow band of the noise dying fast. */
  #playTap(g: Graph, tap: Tap, at: number): void {
    if (!(tap.level > 0)) {
      return;
    }
    this.taps++;
    const c = this.#mix.halyards;
    const ctx = g.ctx;
    const burst = ctx.createBufferSource();
    burst.buffer = g.noise.white;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = c.q;
    const lo = c.tone[0] ?? 430;
    const hi = c.tone[1] ?? 610;
    band.frequency.value = lo + (hi - lo) * this.#unit(tap.seed, 1);
    const v = ctx.createGain();
    v.gain.setValueAtTime(0, at);
    v.gain.linearRampToValueAtTime(tap.level, at + 0.004);
    v.gain.setTargetAtTime(0, at + 0.004, c.decay);
    burst.connect(band);
    band.connect(v);
    v.connect(g.halyardsPan);
    const end = at + 10 * c.decay;
    burst.start(at, this.#unit(tap.seed, 2) * 8);
    burst.stop(end);
    burst.onended = () => {
      for (const n of [burst, band, v]) {
        n.disconnect();
      }
    };
  }

  /**
   * Plays a recording as a voice's from now: a bed's in each family that
   * has it as a layer, taking over from the synthesis over crossfade
   * seconds, starting at a random place; a shot's as one more take, with
   * its note (Hz: a fog signal's recording pitched to each device's note)
   * and the stretch it loops to sound longer (a fog signal's blast), s.
   * gain is its own, dB, over the voice's. It replaces a bed's recording
   * already there.
   */
  useRecording(
    voice: Voice,
    buffer: AudioBuffer,
    gain = 0,
    crossfade = this.#mix.layers.crossfade,
    shape: { note?: number; loop?: readonly number[] } = {},
  ): void {
    const g = this.#graph;
    if (g === null) {
      return;
    }
    const ctx = g.ctx;
    const at = ctx.currentTime;
    if (VOICES[voice] === 'shot') {
      const t = g.takes.get(voice) ?? { buffers: [], trims: [], notes: [], loops: [], last: -1 };
      t.buffers.push(buffer);
      t.trims.push(gainOf(gain + this.#mix.shots[voice as ShotVoice].gain));
      t.notes.push(shape.note ?? 0);
      const [from, to] = shape.loop ?? [];
      t.loops.push(from !== undefined && to !== undefined && to > from ? [from, to] : null);
      g.takes.set(voice, t);
      this.recorded.add(voice);
      return;
    }
    for (const f of Object.values(g.families)) {
      const i = f.voices.indexOf(voice);
      if (i < 0) {
        continue;
      }
      f.layers[i]?.loop.stop(at + 0.2);
      const out = ctx.createGain();
      out.gain.value = 0;
      out.connect(f.out);
      f.layers[i] = {
        loop: new Loop(ctx, buffer, out, at, Math.random()),
        gain: out,
        from: at,
        seconds: crossfade,
        trim: gainOf(gain + f.match),
      };
    }
    this.recorded.add(voice);
  }

  /** Lets a voice's recordings go, its synthesis taking its place again (the sound room's A and B). */
  useSynthesis(voice: Voice): void {
    const g = this.#graph;
    if (g === null) {
      return;
    }
    const at = g.ctx.currentTime;
    g.takes.delete(voice);
    for (const f of Object.values(g.families)) {
      const i = f.voices.indexOf(voice);
      const l = f.layers[i];
      if (i < 0 || l === null || l === undefined) {
        continue;
      }
      l.gain.gain.setTargetAtTime(0, at, 0.05);
      l.loop.stop(at + 0.3);
      f.layers[i] = null;
    }
    this.recorded.delete(voice);
  }

  /** The voices playing recordings. */
  readonly recorded = new Set<Voice>();

  /** Each family as last set: its synthesis's share, and each layer's share and how far its recording has taken over (tests, the sound room). */
  families(): Record<
    FamilyName,
    { level: number; synth: number; layers: Record<string, { share: number; take: number }> }
  > {
    const out = {} as ReturnType<SoundEngine['families']>;
    const g = this.#graph;
    if (g === null) {
      return out;
    }
    const at = g.ctx.currentTime;
    for (const [name, f] of Object.entries(g.families) as [FamilyName, Family][]) {
      const layers: Record<string, { share: number; take: number }> = {};
      f.voices.forEach((v, i) => {
        const l = f.layers[i];
        layers[v] = { share: f.shares[i] ?? 0, take: l ? takeOf(at - l.from, l.seconds) : 0 };
      });
      out[name] = { level: f.level, synth: f.synth, layers };
    }
    return out;
  }

  #loading: Promise<Loaded> | null = null;
  #wanted: {
    list: readonly Recording[];
    probe: Recording | null;
    host: Partial<LoaderHost>;
  } | null = null;

  /**
   * Loads recordings (the game's, unless given) as the engine's voices, once
   * its context is made: called when the game's first download is done.
   * Each takes over from its synthesis as it arrives; what fails leaves its
   * synthesis. host may stand in for the page's fetch and frames (tests).
   */
  record(
    list: readonly Recording[] = RECORDED.voices,
    probe: Recording | null = RECORDED.probe,
    host: Partial<LoaderHost> = {},
  ): Promise<Loaded> | null {
    this.#wanted = { list, probe, host };
    return this.#startLoading();
  }

  /** The loading started by record, once there is a context to decode on. */
  get loading(): Promise<Loaded> | null {
    return this.#loading;
  }

  #startLoading(): Promise<Loaded> | null {
    const g = this.#graph;
    const w = this.#wanted;
    if (g === null || w === null || this.#loading !== null) {
      return this.#loading;
    }
    const ctx = g.ctx;
    const host: LoaderHost = {
      decode: (data) => ctx.decodeAudioData(data),
      fetch: fetchBytes,
      frame: betweenFrames,
      need: (r) => this.#need(g, r),
      loaded: (r, buffer) =>
        this.useRecording(r.voice as Voice, buffer, r.gain, undefined, {
          ...(r.note === undefined ? {} : { note: r.note }),
          ...(r.loop === undefined ? {} : { loop: r.loop }),
        }),
      failed: (r, why) => console.warn(`sound: ${r.name} plays synthesised`, why),
      ...w.host,
    };
    this.#loading = load(host, w.list, w.probe);
    return this.#loading;
  }

  /** How much a recording is needed now: its layer's level in its family as last set. */
  #need(g: Graph, r: Recording): number {
    let need = 0;
    for (const f of Object.values(g.families)) {
      const i = f.voices.indexOf(r.voice as Voice);
      if (i >= 0) {
        need = Math.max(need, f.level * (f.shares[i] ?? 0));
      }
    }
    return need;
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
   * Where a sound played once goes: a panner, then the gain that lets it go
   * fast, into its bus. Every one-shot goes through here, its family (null
   * for none), its level and when it starts and ends (s) asked of the voice
   * limits first: null where it is not to play, the quietest of too many.
   */
  #shot(
    g: Graph,
    bus: BusName,
    pan: number,
    family: string | null,
    level: number,
    start: number,
    end: number,
  ): StereoPannerNode | null {
    const ctx = g.ctx;
    const fade = ctx.createGain();
    const release = this.#mix.voices.release;
    const ok = g.voices.admit(
      {
        family,
        level,
        start,
        end,
        letGo: (at) => {
          fade.gain.setTargetAtTime(0, at, release / 3);
        },
      },
      ctx.currentTime,
    );
    if (!ok) {
      return null;
    }
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(fade);
    fade.connect(g.mix.input(bus));
    return p;
  }

  /** How many sounds played once were let go, or not started, for the voice limits (tests, the sound room). */
  get letGo(): number {
    return this.#graph?.voices.letGo ?? 0;
  }

  /** How many sounds played once play now. */
  get playingOnce(): number {
    const g = this.#graph;
    return g === null ? 0 : g.voices.count(g.ctx.currentTime);
  }

  /** Dips the sea's bus from at under a signal that matters. */
  #dip(g: Graph, at: number): void {
    this.ducks++;
    g.mix.dip('sea', at, this.#mix.duck);
  }

  /** How many times the sea's bus was dipped (tests). */
  ducks = 0;

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
