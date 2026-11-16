// SPDX-License-Identifier: AGPL-3.0-only

// The sounds played once: which of a voice's recordings plays, how it is
// varied, and how many play at once.
//
// A sound heard often wearies the ear when it is the same each time. So a
// voice with several recordings (takes) plays one chosen by its event's own
// seed, which every phone hearing the event has alike, and never the take it
// played last: where the seed names that one, the seed names another. Each
// is a little higher or lower and louder or softer, by the seed too: a
// knock or a splash by up to a semitone, a bird by up to two, each by up to
// 2 dB. Signals are never varied, since they are known by their sound: the
// fog signals, the gun and the bell play their first take as it is.
//
// A phone's audio thread runs only so many voices. So at most so many sounds
// play at once, and so many of a family (gulls, seabirds, knocks, splashes
// and slaps, fog signals, thunder); when one more would pass a limit, the
// quietest of them, the new one too, is let go, faded out fast. A sound's
// loudness is taken as its level when it starts, falling to nothing by its
// end.

/** A number from 0 to 1 for a seed and a draw: the same everywhere for the same two. */
export function unit(seed: number, k: number): number {
  const v = Math.sin(seed * 3.7 + k * 1.3) * 43758.5453;
  return v - Math.floor(v);
}

/**
 * The take of n a sound plays for its seed, after last (−1 for none yet):
 * the seed's own, unless that was the last, then another the seed names.
 */
export function pickTake(seed: number, n: number, last: number): number {
  if (n <= 1) {
    return 0;
  }
  const k = Math.min(n - 1, Math.floor(unit(seed, 7) * n));
  if (k !== last) {
    return k;
  }
  return (k + 1 + Math.min(n - 2, Math.floor(unit(seed, 11) * (n - 1)))) % n;
}

/** How a sound is varied: its playback rate (its pitch) and its gain. */
export interface Variation {
  rate: number;
  gain: number;
}

/** The variation a seed gives, up to pitch semitones and level dB either way. */
export function vary(seed: number, pitch: number, level: number): Variation {
  return {
    rate: 2 ** ((pitch * (2 * unit(seed, 8) - 1)) / 12),
    gain: 10 ** ((level * (2 * unit(seed, 9) - 1)) / 20),
  };
}

/** A sound playing: its family (null for none), its level and when it starts and ends, s; how it is let go. */
export interface Playing {
  family: string | null;
  level: number;
  start: number;
  end: number;
  letGo(at: number): void;
}

/** How loud a sound playing is at a time: its level falling to nothing by its end. */
export function loudnessAt(p: Pick<Playing, 'level' | 'start' | 'end'>, at: number): number {
  if (at >= p.end) {
    return 0;
  }
  if (at <= p.start || !(p.end > p.start)) {
    return p.level;
  }
  return (p.level * (p.end - at)) / (p.end - p.start);
}

/** The voice limits: at most most at once, and per family its own. */
export interface Limits {
  most: number;
  families: Record<string, number>;
}

/**
 * The sounds playing once, held to their limits. admit is asked before each
 * plays: it frees the ended, then makes room in the family and in all, the
 * quietest let go; false where the new one is the quietest.
 */
export class Voices {
  readonly #limits: Limits;
  readonly #playing: Playing[] = [];
  /** How many were let go, or not let start, for the limits (tests, the sound room). */
  letGo = 0;

  constructor(limits: Limits) {
    this.#limits = limits;
  }

  /** How many play at now, and of a family. */
  count(now: number, family?: string): number {
    this.#free(now);
    return family === undefined
      ? this.#playing.length
      : this.#playing.filter((p) => p.family === family).length;
  }

  admit(p: Playing, now: number): boolean {
    this.#free(now);
    const family = p.family;
    const cap = family === null ? undefined : this.#limits.families[family];
    if (cap !== undefined && !this.#room(p, now, cap, (q) => q.family === family)) {
      return false;
    }
    if (!this.#room(p, now, this.#limits.most, () => true)) {
      return false;
    }
    this.#playing.push(p);
    return true;
  }

  /** Makes room for p among those that match, to at most cap: whether p may play. */
  #room(p: Playing, now: number, cap: number, match: (q: Playing) => boolean): boolean {
    for (;;) {
      const those = this.#playing.filter(match);
      if (those.length < cap) {
        return true;
      }
      let quietest: Playing | null = null;
      let least = loudnessAt(p, now);
      for (const q of those) {
        const l = loudnessAt(q, now);
        if (l < least) {
          least = l;
          quietest = q;
        }
      }
      this.letGo++;
      if (quietest === null) {
        return false;
      }
      this.#playing.splice(this.#playing.indexOf(quietest), 1);
      quietest.letGo(now);
    }
  }

  #free(now: number): void {
    for (let i = this.#playing.length - 1; i >= 0; i--) {
      if ((this.#playing[i]?.end ?? 0) <= now) {
        this.#playing.splice(i, 1);
      }
    }
  }
}
