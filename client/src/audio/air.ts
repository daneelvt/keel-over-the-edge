// SPDX-License-Identifier: AGPL-3.0-only

// The air between a far sound and the listener: it absorbs the highs more
// than the lows, so a far horn or far thunder is duller than a near one.
// The absorption, in dB per km at a few frequencies, is ISO 9613-1's (1993)
// for the air of a cool, damp sea: at 10 °C and 70% humidity about 0.4 dB/km
// at 125 Hz, 1 at 250, 1.9 at 500, 3.7 at 1 kHz, 9.7 at 2 kHz and 32.8 at
// 4 kHz. A low-pass at the frequency where the absorption over the distance
// reaches 3 dB stands for it, as the falls' does (audio/voices.ts).

/** An absorption table: dB per km at each of its frequencies, Hz, rising. */
export interface Absorption {
  at: readonly number[];
  dbPerKm: readonly number[];
}

/**
 * The low-pass at d m: the frequency at which the air has absorbed 3 dB
 * over d, read from the table between its points on log scales, and as the
 * frequency below its first or the square root beyond its last, within
 * least and most.
 */
export function airCutoff(a: Absorption, least: number, most: number, d: number): number {
  const { at, dbPerKm } = a;
  const want = (3 * 1000) / Math.max(d, 1);
  const first = dbPerKm[0] ?? 0.4;
  const last = dbPerKm[dbPerKm.length - 1] ?? 32.8;
  let f: number;
  if (want <= first) {
    f = (at[0] ?? 125) * (want / first);
  } else if (want >= last) {
    f = (at[at.length - 1] ?? 4000) * Math.sqrt(want / last);
  } else {
    let i = 0;
    while (i + 2 < dbPerKm.length && (dbPerKm[i + 1] ?? 0) < want) {
      i++;
    }
    const a0 = Math.log(dbPerKm[i] ?? 1);
    const a1 = Math.log(dbPerKm[i + 1] ?? 1);
    const f0 = Math.log(at[i] ?? 1);
    const f1 = Math.log(at[i + 1] ?? 1);
    f = Math.exp(f0 + ((Math.log(want) - a0) / (a1 - a0)) * (f1 - f0));
  }
  return Math.min(Math.max(f, least), most);
}
