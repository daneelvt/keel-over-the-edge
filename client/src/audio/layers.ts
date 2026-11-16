// SPDX-License-Identifier: AGPL-3.0-only

// The bed as layers: a family of the bed's sounds (the wind, the water on
// the hull, the sea, rain) is a few recorded loops, each for a span of the
// physics (the wind's light, moderate, strong and gale; the hull's
// chuckle, wash and bow wave), crossfaded at equal power as the physics
// moves between them, all at the family's level. A layer plays its
// recording once one has loaded, else the family's synthesis plays its
// share: the synthesis's gain is what the loaded layers leave of the
// family's power. A recording takes over from the synthesis over a
// crossfade at equal power too, so the family is as loud throughout.
//
// A loop plays as two copies of its recording half its length apart, each
// heard most in its middle and not at all at its seam, the two at equal
// power: neither the seam nor the loop's length is heard. Each starts at a
// random place in the recording.

/** 0 below from, rising smoothly to 1 at full. */
function ramp(from: number, full: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - from) / (full - from)));
  return t * t * (3 - 2 * t);
}

/**
 * Each layer's share of its family at x, for layers centred at at (rising):
 * at a layer's centre it is all of it, and between two centres they are
 * crossfaded at equal power, their shares' squares summing to one. Below
 * the first and above the last, the first or the last alone.
 */
export function shares(x: number, at: readonly number[], into: number[] = []): number[] {
  into.length = at.length;
  into.fill(0);
  const n = at.length;
  if (n === 0) {
    return into;
  }
  if (!(x > (at[0] ?? 0))) {
    into[0] = 1;
    return into;
  }
  if (x >= (at[n - 1] ?? 0)) {
    into[n - 1] = 1;
    return into;
  }
  let k = 0;
  while (k + 2 < n && x >= (at[k + 1] ?? 0)) {
    k++;
  }
  const t = ramp(at[k] ?? 0, at[k + 1] ?? 1, x);
  into[k] = Math.cos((Math.PI / 2) * t);
  into[k + 1] = Math.sin((Math.PI / 2) * t);
  return into;
}

/** How far a recording has taken over, 0 to 1, seconds after it began over a crossfade of seconds: the take's gain at equal power. */
export function takeOf(elapsed: number, seconds: number): number {
  if (!(elapsed > 0)) {
    return 0;
  }
  if (!(seconds > 0) || elapsed >= seconds) {
    return 1;
  }
  return Math.sin((Math.PI / 2) * (elapsed / seconds));
}

/**
 * The synthesis's gain in a family: what is left of its power by the layers
 * that play recordings, each its share times how far it has taken over.
 */
export function synthShare(layerShares: readonly number[], takes: readonly number[]): number {
  let left = 1;
  for (let i = 0; i < layerShares.length; i++) {
    const s = (layerShares[i] ?? 0) * (takes[i] ?? 0);
    left -= s * s;
  }
  return Math.sqrt(Math.max(0, left));
}

/** A curve that takes the absolute value: a sine turned into its arches. */
function absCurve(): Float32Array<ArrayBuffer> {
  const n = 1025;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    c[i] = Math.abs((2 * i) / (n - 1) - 1);
  }
  return c;
}

/**
 * A recording looped as two copies half its length apart, into out, from
 * at, starting at where (0 to 1) of it. Each copy's gain is the arch of a
 * sine with the loop's period, nothing at the copy's seam and all of it
 * half way between: |sin| for one, |cos| for the other, whose squares sum
 * to one.
 */
export class Loop {
  readonly #nodes: AudioNode[] = [];
  readonly #sources: AudioScheduledSourceNode[] = [];

  constructor(
    ctx: BaseAudioContext,
    buffer: AudioBuffer,
    out: AudioNode,
    at: number,
    where: number,
  ) {
    const length = buffer.duration;
    const shape = absCurve();
    for (let copy = 0; copy < 2; copy++) {
      const offset = ((where + copy / 2) % 1) * length;
      const s = ctx.createBufferSource();
      s.buffer = buffer;
      s.loop = true;
      const g = ctx.createGain();
      g.gain.value = 0;
      // The envelope: sin(π·(offset + t)/length) from at, its phase set by
      // a wave of one harmonic: sin(ωt + φ) = sin φ·cos ωt + cos φ·sin ωt.
      const phase = (Math.PI * offset) / length;
      const wave = ctx.createPeriodicWave(
        new Float32Array([0, Math.sin(phase)]),
        new Float32Array([0, Math.cos(phase)]),
        { disableNormalization: true },
      );
      const o = ctx.createOscillator();
      o.setPeriodicWave(wave);
      o.frequency.value = 1 / (2 * length);
      const abs = ctx.createWaveShaper();
      abs.curve = shape;
      o.connect(abs);
      abs.connect(g.gain);
      s.connect(g);
      g.connect(out);
      s.start(at, offset);
      o.start(at);
      this.#sources.push(s, o);
      this.#nodes.push(s, g, o, abs);
    }
  }

  /** Stops the copies at at, and lets them go. */
  stop(at: number): void {
    for (const s of this.#sources) {
      s.stop(at);
    }
    const first = this.#sources[0];
    if (first !== undefined) {
      first.onended = () => {
        for (const n of this.#nodes) {
          n.disconnect();
        }
      };
    }
  }
}
