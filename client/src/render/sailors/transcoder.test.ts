// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { startMessage, type Transcoding, transcodeFromFile } from './transcoder';

const BLOB = 'blob:https://play.keelovertheedge.com/0b9e8c1d-1f5e-4b8a-9d1c-2e3f4a5b6c7d';

describe('the transcoder’s workers', () => {
  test('made from the page’s own file whenever the loader sets how, told the blob first, then what three.js tells its own', () => {
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
        postMessage: (m: unknown, t?: unknown[]) => {
          w.sent.push(m);
          w.moved.push(...(t ?? []));
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
    // The file alone: an address the service worker's answer keeps whole.
    expect(made.map((w) => w.address)).toEqual([
      '/assets/transcoderworker-Bq2.js',
      '/assets/transcoderworker-Bq2.js',
    ]);
    expect(made.map((w) => w.sent[0])).toEqual([startMessage(BLOB), startMessage(BLOB)]);
    expect(made[0]?.sent).toHaveLength(2);
    const first = made[0]?.sent[1] as {
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
