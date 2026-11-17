// SPDX-License-Identifier: AGPL-3.0-only

// three.js's KTX2Loader starts its transcoder's workers from a blob it
// builds of the transcoder and its own worker code. A worker started from a
// blob keeps the page's Content Security Policy, which runs no string as
// code (internal/api/policy.go), and the transcoder makes its functions
// from strings: under the policy, every texture would fail. So each worker
// is started from a file of the page's own instead (transcoderworker.js),
// which runs the same blob and is not under the page's policy, and is told
// what three.js tells its own: the transcoder's settings and WebAssembly.

import transcoderWorker from './transcoderworker.js?url&no-inline';

/** The parts of a KTX2Loader its workers are made from. */
export interface Transcoding {
  workerPool: { setWorkerCreator(create: () => Worker): void };
  workerSourceURL: string;
  transcoderBinary: ArrayBuffer | null;
  workerConfig: unknown;
}

/** The worker's address for a blob: the file, the blob after its #. */
export function workerAddress(file: string, blob: string): string {
  return `${file}#${encodeURIComponent(blob)}`;
}

/**
 * Has the loader start its workers from the file rather than its blob:
 * whenever it sets how its workers are made, they are made so instead.
 */
export function transcodeFromFile(
  loader: Transcoding,
  file: string = transcoderWorker,
  make: (address: string) => Worker = (address) => new Worker(address),
): void {
  const pool = loader.workerPool;
  const set = pool.setWorkerCreator.bind(pool);
  pool.setWorkerCreator = () => {
    set(() => {
      const worker = make(workerAddress(file, loader.workerSourceURL));
      const binary = (loader.transcoderBinary ?? new ArrayBuffer(0)).slice(0);
      worker.postMessage({ type: 'init', config: loader.workerConfig, transcoderBinary: binary }, [
        binary,
      ]);
      return worker;
    });
  };
}
