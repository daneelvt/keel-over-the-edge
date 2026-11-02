// SPDX-License-Identifier: AGPL-3.0-only

// The runner a job landed on, for its summary: its CPU, how many cores, and
// how fast they are, by the time a fixed sum of floating-point work takes
// on one core and on every core at once. GitHub's runners are drawn from
// machines of different generations, and the same tests take up to 2.5×
// as long from one run to the next: a slow run on a slow runner is seen as
// one.
//
//	node e2e/runner.ts >> "$GITHUB_STEP_SUMMARY"

import { availableParallelism, cpus } from 'node:os';
import { isMainThread, parentPort, Worker } from 'node:worker_threads';

/** The work: a sum of sines and roots, 0.17 s of one core of an Apple M5. */
function work(): number {
  let sum = 0;
  for (let i = 1; i <= 30_000_000; i++) {
    sum += Math.sin(i * 1e-3) * Math.sqrt(i);
  }
  return sum;
}

/** Milliseconds for the work on a worker. */
function timed(): Promise<number> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url));
    w.once('message', resolve);
    w.once('error', reject);
  });
}

if (isMainThread) {
  const cores = availableParallelism();
  const one = await timed();
  const all = await Promise.all(Array.from({ length: cores }, timed));
  const worst = Math.max(...all);
  const model = cpus()[0]?.model.trim() ?? 'unknown';
  process.stdout.write(
    `**The runner:** ${model}, ${cores} cores. The fixed work took ` +
      `${(one / 1000).toFixed(2)} s on one core, ${(worst / 1000).toFixed(2)} s on all ${cores} at once.\n\n`,
  );
} else {
  const start = performance.now();
  const sum = work();
  // The sum is read, so the work is not optimised away.
  parentPort?.postMessage(Number.isFinite(sum) ? performance.now() - start : -1);
}
