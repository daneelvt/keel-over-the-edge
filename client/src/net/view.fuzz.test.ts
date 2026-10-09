// SPDX-License-Identifier: AGPL-3.0-only

// The view decoder against what a server, or anything between it and the
// page, might send: random bytes, and the golden snapshots' entries with
// bits flipped, bytes cut and added, against random bases. It never throws:
// each stream is read, or refused with its reason. Run for KEEL_FUZZ_SECONDS
// (CI runs 30), or a moment.

import { describe, expect, test } from 'vitest';
import snapshots from '../../../shared/protocol/testdata/snapshots.json';
import { HEADER_SIZE } from './snapshot';
import { applyEntries, Q, VIEW_SLOTS, VIEW_STRIDE, View } from './view';

const seconds = Number(process.env.KEEL_FUZZ_SECONDS ?? 1);

function bytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

/** A small, seeded generator (Park and Miller's minimal standard). */
function generator(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

describe('the view decoder, fuzzed', () => {
  test(
    'never throws, whatever it is given',
    () => {
      const random = generator(12345);
      const streams = snapshots.map((g) => bytes(g.bytes).subarray(HEADER_SIZE));
      const changes = new Uint8Array(VIEW_SLOTS);
      const view = new View();
      const end = Date.now() + seconds * 1000;
      let tried = 0;
      let read = 0;
      while (Date.now() < end) {
        // A base of random boats.
        view.clear();
        for (let slot = 0; slot < VIEW_SLOTS; slot++) {
          if (random() < 0.5) {
            view.used[slot] = 1;
            for (let f = 0; f < VIEW_STRIDE; f++) {
              view.q[slot * VIEW_STRIDE + f] = Math.floor(random() * 65536) - 32768;
            }
            view.q[slot * VIEW_STRIDE + Q.flags] = Math.floor(random() * 8);
          }
        }
        let b: Uint8Array;
        if (random() < 0.3) {
          b = new Uint8Array(Math.floor(random() * 64));
          for (let i = 0; i < b.length; i++) {
            b[i] = Math.floor(random() * 256);
          }
        } else {
          const src = streams[Math.floor(random() * streams.length)] ?? new Uint8Array(0);
          b = new Uint8Array(src.length + 4);
          b.set(src);
          const len = Math.floor(random() * b.length);
          for (let k = 0; k < 3; k++) {
            if (len > 0) {
              const at = Math.floor(random() * len);
              b[at] = (b[at] ?? 0) ^ (1 << Math.floor(random() * 8));
            }
          }
          b = b.subarray(0, len);
        }
        const n = Math.floor(random() * 70);
        const err = applyEntries(
          new DataView(b.buffer, b.byteOffset, b.byteLength),
          0,
          n,
          view,
          changes,
        );
        expect(err === null || typeof err === 'string').toBe(true);
        tried++;
        read += err === null ? 1 : 0;
      }
      expect(tried).toBeGreaterThan(1000);
      expect(read).toBeGreaterThan(0);
    },
    (seconds + 30) * 1000,
  );
});
