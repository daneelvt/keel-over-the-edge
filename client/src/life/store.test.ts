// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import type { LifeSeen } from '../net/messages';
import { LifeStore } from './store';

const rec = (id: string, rev: number, end = 1000): LifeSeen => ({
  id,
  over: '',
  rev,
  kind: 0,
  start: 0,
  end,
  east: 0,
  north: 0,
  heading: 0,
  speed: 10,
  count: 1,
  seed: 1,
  with: 0,
});

describe('LifeStore', () => {
  test('keeps the latest revision, drops by id and all, expires at the end', () => {
    const s = new LifeStore();
    s.set([rec('1', 0), rec('2', 0, 500)], []);
    s.set([rec('1', 2)], []);
    s.set([rec('1', 1)], []);
    expect(s.get('1')?.rev).toBe(2);
    s.expire(500);
    expect(s.size).toBe(1);
    s.set([], ['1']);
    expect(s.size).toBe(0);
    s.set([rec('3', 0)], []);
    s.set([], 'all');
    expect(s.size).toBe(0);
  });
});
