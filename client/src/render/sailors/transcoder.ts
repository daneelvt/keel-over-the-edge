// SPDX-License-Identifier: AGPL-3.0-only

// three.js's KTX2Loader starts its transcoder's workers from a blob it
// builds of the transcoder and its own worker code. A worker started from a
// blob keeps the page's Content Security Policy, which runs no string as
// code (internal/api/policy.go), and the transcoder makes its functions
// from strings: under the policy, every texture would fail. So each worker
// is started from a file of the page's own instead (transcoderworker.js),
// which runs the same blob and is not under the page's policy, and is told
// what three.js tells its own: the transcoder's settings and WebAssembly.
//
// The blob is named to the worker in a first message, before those. The
// worker's address cannot carry it: the service worker answers the file
// from its cache on every visit after the first, and a worker so answered
// has the kept answer's address, without what followed its #.

import transcoderWorker from './transcoderworker.js?url&no-inline';

/** The parts of a KTX2Loader its workers are made from. */
export interface Transcoding {
  workerPool: { setWorkerCreator(create: () => Worker): void };
  workerSourceURL: string;
  transcoderBinary: ArrayBuffer | null;
  workerConfig: unknown;
}

/** The first message to a worker: the blob it is to run. */
export function startMessage(blob: string): { type: 'start'; source: string } {
  return { type: 'start', source: blob };
}

/**
 * Has the loader start its workers from the file rather than its blob:
 * whenever it sets how its workers are made, they are made so instead.
 */
export function transcodeFromFile(
  loader: Transcoding,
  file: string = transcoderWorker,
  make: (file: string) => Worker = (f) => new Worker(f),
): void {
  const pool = loader.workerPool;
  const set = pool.setWorkerCreator.bind(pool);
  pool.setWorkerCreator = () => {
    set(() => {
      const worker = make(file);
      worker.postMessage(startMessage(loader.workerSourceURL));
      const binary = (loader.transcoderBinary ?? new ArrayBuffer(0)).slice(0);
      worker.postMessage({ type: 'init', config: loader.workerConfig, transcoderBinary: binary }, [
        binary,
      ]);
      return worker;
    });
  };
}
