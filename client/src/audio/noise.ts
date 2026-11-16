// SPDX-License-Identifier: AGPL-3.0-only

// The noises the voices are made from: white, pink (equal energy in every
// octave, falling 3 dB an octave: the wind) and brown (falling 6 dB an
// octave: the sea and the water), each a long loop from a fixed sequence so
// every page sounds alike. Each voice reads its own noise at its own
// offset, so no two are one source: they add in power, not in amplitude,
// and the loop is too long to learn. The loop's end runs into its start
// over a crossfade from the noise's own continuation, so it has no seam.

export type NoiseColour = 'white' | 'pink' | 'brown';

/** Each noise's RMS level: white's, uniform at 0.7 of full scale. */
const RMS = 0.7 / Math.sqrt(3);

/** The seam's crossfade, s. */
const SEAM = 0.25;

/**
 * seconds of a noise at rate, Hz: the samples, scaled to RMS, from the
 * colour's own filtering of one fixed white sequence.
 */
export function noiseSamples(colour: NoiseColour, seconds: number, rate: number): Float32Array {
  const n = Math.max(1, Math.floor(seconds * rate));
  const fade = Math.min(Math.floor(SEAM * rate), Math.floor(n / 2));
  const raw = new Float64Array(n + fade);
  let seed = colour === 'white' ? 22222 : colour === 'pink' ? 33333 : 44444;
  // Pink by Paul Kellet's filter; brown by a leaky integrator.
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  let brown = 0;
  for (let i = 0; i < raw.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const w = seed / 2147483648 - 1;
    if (colour === 'white') {
      raw[i] = w;
    } else if (colour === 'pink') {
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      raw[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    } else {
      brown = (brown + 0.02 * w) / 1.02;
      raw[i] = brown;
    }
  }
  // Seamless: the first samples fade in from the noise past the end.
  for (let i = 0; i < fade; i++) {
    const a = (Math.PI / 2) * (i / fade);
    raw[i] = (raw[n + i] ?? 0) * Math.cos(a) + (raw[i] ?? 0) * Math.sin(a);
  }
  let mean = 0;
  for (let i = 0; i < n; i++) {
    mean += raw[i] ?? 0;
  }
  mean /= n;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += ((raw[i] ?? 0) - mean) ** 2;
  }
  const k = RMS / Math.sqrt(sum / n || 1);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = ((raw[i] ?? 0) - mean) * k;
  }
  return out;
}

/** A noise as an audio buffer of the context's. */
export function noiseBuffer(
  ctx: BaseAudioContext,
  colour: NoiseColour,
  seconds: number,
): AudioBuffer {
  const samples = noiseSamples(colour, seconds, ctx.sampleRate);
  const b = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  b.getChannelData(0).set(samples);
  return b;
}
