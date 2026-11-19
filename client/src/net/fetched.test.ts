// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest';
import { Fetched } from './fetched';

test('the bytes over the wire, the land’s with them, each counted once', () => {
  const f = new Fetched();
  let land = 0;
  f.land = () => land;
  // The page, a script, and a model the cache served (0 over the wire).
  f.add([{ transferSize: 9_000 }, { transferSize: 700_000 }, { transferSize: 0 }, {}]);
  land = 40_000;
  expect(f.total).toBe(749_000);
  expect(f.take()).toBe(749_000);
  expect(f.take()).toBe(0);
  f.add([{ transferSize: 1_000 }]);
  land = 41_000;
  expect(f.take()).toBe(2_000);
  expect(f.total).toBe(751_000);
});
