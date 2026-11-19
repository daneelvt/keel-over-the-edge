// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { type Transcoding, transcodeFromFile, workerAddress } from './transcoder';

const BLOB = 'blob:https://play.keelovertheedge.com/0b9e8c1d-1f5e-4b8a-9d1c-2e3f4a5b6c7d';

describe('the transcoder’s workers', () => {
  test('started from the page’s own file, the blob after its #', () => {
    const address = workerAddress('/assets/transcoderworker-Bq2.js', BLOB);
    expect(address).toBe(`/assets/transcoderworker-Bq2.js#${encodeURIComponent(BLOB)}`);
    expect(decodeURIComponent(new URL(address, 'https://x.example').hash.slice(1))).toBe(BLOB);
  });

  test('made so whenever the loader sets how, and told what three.js tells its own', () => {
    let creator: (() => Worker) | null = null;
    const binary = new Uint8Array([0, 97, 115, 109]).buffer;
    const loader: Transcoding = {
      workerPool: {
        setWorkerCreator(create) {
          creator = create;
        },
      },
      workerSourceURL: '',
      transcoderBinary: null,
      workerConfig: { astcSupported: true },
    };
    const made: { address: string; sent: unknown[]; moved: unknown[] }[] = [];
    transcodeFromFile(loader, '/assets/transcoderworker-Bq2.js', (address) => {
      const w = { address, sent: [] as unknown[], moved: [] as unknown[] };
      made.push(w);
      return {
        postMessage: (m: unknown, t: unknown[]) => {
          w.sent.push(m);
          w.moved.push(...t);
        },
      } as unknown as Worker;
    });
    // As three.js does once the transcoder's files are in.
    loader.workerSourceURL = BLOB;
    loader.transcoderBinary = binary;
    loader.workerPool.setWorkerCreator(() => {
      throw new Error('the blob’s worker');
    });
    expect(creator).not.toBeNull();
    (creator as unknown as () => Worker)();
    (creator as unknown as () => Worker)();
    expect(made.map((w) => w.address)).toEqual([
      workerAddress('/assets/transcoderworker-Bq2.js', BLOB),
      workerAddress('/assets/transcoderworker-Bq2.js', BLOB),
    ]);
    const first = made[0]?.sent[0] as {
      type: string;
      config: unknown;
      transcoderBinary: ArrayBuffer;
    };
    expect(first.type).toBe('init');
    expect(first.config).toEqual({ astcSupported: true });
    expect(new Uint8Array(first.transcoderBinary)).toEqual(new Uint8Array(binary));
    // Each worker its own copy, the loader's kept.
    expect(first.transcoderBinary).not.toBe(binary);
    expect(binary.byteLength).toBe(4);
  });
});
