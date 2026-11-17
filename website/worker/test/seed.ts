// SPDX-License-Identifier: AGPL-3.0-only

// keel's status as recorded from seed 1's world, every subject charted, at
// a busy moment with twelve boats (internal/status/testdata): each test's
// own copy, to change as it likes.

import recorded from '../../../internal/status/testdata/seed1.json';
import type { Status } from '../src/status';

export function seed1(): Status {
  return structuredClone(recorded) as unknown as Status;
}
