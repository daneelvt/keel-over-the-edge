// SPDX-License-Identifier: AGPL-3.0-only

// The mix: one place where how loud each sound is heard is decided. Every
// voice plays into a bus by its family: the sea (the wind, the rigging, the
// flogging cloth, the water, the sea, rain, the falls, the lapping, a
// fall's roar), the world (the harbour, the sea's life, the features, the
// fog signals, thunder), the boat (knocks and scrapes), the races (the gun
// and the cheer) and notices (the certificate's bell). Each bus has a
// balance of the mix's own (art/sound/mix.json, which only the page reads:
// what the server's lookout hears stays the recipes'), under the player's
// slider; the buses run into the master, the player's volume, then a fade
// that starts and stops the sound without a click, then a limiter, a
// safety net the mix is staged to keep away from, then the speaker.
//
// The player's sliders are cubed: loudness goes as the logarithm of power,
// so a slider that set the gain itself would be dead at the top and abrupt
// at the bottom; the cube spans about 50 dB, 70% is −9.3 dB, half −18.

import mix from '../../../art/sound/mix.json';

export type MixRecipe = typeof mix;

export const MIX: MixRecipe = mix;

/** The buses, by the families of sounds that play into them. */
export const BUSES = ['sea', 'world', 'boat', 'races', 'notices'] as const;
export type BusName = (typeof BUSES)[number];

/** The buses the Sounds slider moves: every one but the sea's. */
const SOUNDS: readonly BusName[] = ['world', 'boat', 'races', 'notices'];

/** A slider's gain, 0 to 1: its value cubed. */
export function sliderGain(x: number): number {
  const v = Math.min(Math.max(Number.isFinite(x) ? x : 0, 0), 1);
  return v * v * v;
}

/** A level in dB as a gain. */
export function gainOf(db: number): number {
  return 10 ** (db / 20);
}

/**
 * The gain a bed's voice plays at for the level its recipe gives, most at
 * its loudest: most times (level / most) to the power curve. A curve under
 * one rises fast from silence and slowly at the top, so that the voices'
 * range in dB is curve times the recipes'.
 */
export function curved(level: number, most: number, curve: number): number {
  if (!(level > 0) || !(most > 0)) {
    return 0;
  }
  return most * (level / most) ** curve;
}

/** 0 below from, rising smoothly to 1 at full. */
function ramp(from: number, full: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - from) / (full - from)));
  return t * t * (3 - 2 * t);
}

/**
 * The calm's lapping at the hull now: as loud as the recipe's level while
 * the boat drifts, gone as it gathers way, each lap swelling from rest and
 * falling back over its periods, which beat so no two laps are alike.
 */
export function calmLevel(c: MixRecipe['calm'], speed: number, time: number): number {
  const drift = 1 - ramp(c.speed[0] ?? 0.4, c.speed[1] ?? 1.4, Math.abs(speed));
  if (!(drift > 0)) {
    return 0;
  }
  const a = Math.sin((2 * Math.PI * time) / (c.period[0] ?? 2.6));
  const b = Math.sin((2 * Math.PI * time) / (c.period[1] ?? 4.3) + 1);
  const lap = Math.max(0, 0.6 * a + 0.4 * b);
  return c.level * drift * (0.25 + 0.75 * lap);
}

/** What the player has set: the volume, the sea and wind's and every other sound's, each 0 to 1. */
export interface Volumes {
  volume: number;
  sea: number;
  sounds: number;
}

/** One bus: what its voices play into, and what follows. */
interface Bus {
  /** Where the bus's voices connect. */
  input: GainNode;
  /** Held at one; what dips the bus under a signal that matters moves it. */
  duck: GainNode;
  /** The balance times the player's slider. */
  level: GainNode;
}

/**
 * The mixer on a context: its buses, the master, the fade and the limiter,
 * into destination.
 */
export class Mixer {
  readonly ctx: BaseAudioContext;
  readonly #buses: Record<BusName, Bus>;
  readonly master: GainNode;
  readonly fade: GainNode;
  readonly limiter: DynamicsCompressorNode;
  readonly #r: MixRecipe;
  #volumes: Volumes = { volume: 1, sea: 1, sounds: 1 };

  constructor(ctx: BaseAudioContext, destination: AudioNode, r: MixRecipe = MIX) {
    this.ctx = ctx;
    this.#r = r;
    const l = r.limiter;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = l.threshold;
    this.limiter.knee.value = l.knee;
    this.limiter.ratio.value = l.ratio;
    this.limiter.attack.value = l.attack;
    this.limiter.release.value = l.release;
    this.limiter.connect(destination);
    this.fade = ctx.createGain();
    this.fade.gain.value = 0;
    this.fade.connect(this.limiter);
    this.master = ctx.createGain();
    this.master.connect(this.fade);
    const buses = {} as Record<BusName, Bus>;
    for (const name of BUSES) {
      const input = ctx.createGain();
      const duck = ctx.createGain();
      const level = ctx.createGain();
      const shelf = (r.buses[name] as { shelf?: { frequency: number; gain: number } }).shelf;
      if (shelf !== undefined) {
        const f = ctx.createBiquadFilter();
        f.type = 'highshelf';
        f.frequency.value = shelf.frequency;
        f.gain.value = shelf.gain;
        input.connect(f);
        f.connect(duck);
      } else {
        input.connect(duck);
      }
      duck.connect(level);
      level.connect(this.master);
      buses[name] = { input, duck, level };
    }
    this.#buses = buses;
    this.#set(0);
  }

  /** Where a voice of a family connects. */
  input(bus: BusName): AudioNode {
    return this.#buses[bus].input;
  }

  /** A bus's duck: held at one; a signal that matters dips the bus by it. */
  duck(bus: BusName): AudioParam {
    return this.#buses[bus].duck.gain;
  }

  /** A bus's output, after its balance and slider: for a meter to listen to. */
  output(bus: BusName): AudioNode {
    return this.#buses[bus].level;
  }

  /** The limiter's gain reduction now, dB, as a negative number or 0. */
  get reduction(): number {
    return this.limiter.reduction;
  }

  /** Sets the player's volumes, gliding there over the slider's glide. */
  volumes(v: Volumes): void {
    this.#volumes = { ...v };
    this.#set(this.#r.fades.slider);
  }

  #set(glide: number): void {
    const at = this.ctx.currentTime;
    const to = (p: AudioParam, value: number): void => {
      if (glide > 0) {
        hold(p, at);
        p.linearRampToValueAtTime(value, at + glide);
      } else {
        p.value = value;
      }
    };
    const v = this.#volumes;
    to(this.master.gain, sliderGain(v.volume));
    for (const name of BUSES) {
      const slider = name === 'sea' ? v.sea : SOUNDS.includes(name) ? v.sounds : 1;
      to(this.#buses[name].level.gain, gainOf(this.#r.buses[name].level) * sliderGain(slider));
    }
  }

  /** Fades the sound in from silence over seconds. */
  fadeIn(seconds: number): void {
    const p = this.fade.gain;
    const at = this.ctx.currentTime;
    p.cancelScheduledValues(at);
    p.setValueAtTime(0, at);
    p.linearRampToValueAtTime(1, at + seconds);
  }

  /** Fades the sound out to silence over seconds, from where it is. */
  fadeOut(seconds: number): void {
    this.fadeTo(0, seconds);
  }

  /** Fades the sound to a gain over seconds, from where it is. */
  fadeTo(gain: number, seconds: number): void {
    const p = this.fade.gain;
    const at = this.ctx.currentTime;
    hold(p, at);
    p.linearRampToValueAtTime(gain, at + seconds);
  }
}

/** Holds a parameter where it is at at, its later changes let go: the start of a new ramp. */
function hold(p: AudioParam, at: number): void {
  if (typeof p.cancelAndHoldAtTime === 'function') {
    p.cancelAndHoldAtTime(at);
  } else {
    const v = p.value;
    p.cancelScheduledValues(at);
    p.setValueAtTime(v, at);
  }
}
