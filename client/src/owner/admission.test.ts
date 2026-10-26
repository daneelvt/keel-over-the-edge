// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { agentWords, ago, machinesLine, rulesLine } from './admission';
import type { Admission } from './api';

const admission: Admission = {
  humans: 40,
  machines: 3,
  humansWaiting: 2,
  machinesWaiting: 1,
  aiCap: 500,
  aiReserve: 250,
  aiSilence: 0,
};

describe('admission by kind', () => {
  test('tells how long ago in its largest unit', () => {
    expect(ago(12.4)).toBe('12 s ago');
    expect(ago(185)).toBe('3 min ago');
    expect(ago(7300)).toBe('2 h ago');
    expect(ago(null)).toBe('no call yet');
  });

  test('tells a machine boat’s agent: its app, last call, wait and refusals', () => {
    expect(agentWords({ app: 'claude-ai', sinceCall: 12, waiting: 20, refusals: 0 })).toBe(
      'claude-ai, called 12 s ago, waiting 20 s',
    );
    expect(agentWords({ app: 'codex', sinceCall: 70, waiting: 0, refusals: 3 })).toBe(
      'codex, called 1 min ago, 3 refused',
    );
    expect(agentWords(undefined)).toBe('no agent known');
  });

  test('tells the machine sailors against their cap and reserve', () => {
    expect(machinesLine(admission)).toBe(
      'Machine sailors: 3 at sea of a cap of 500, 250 kept for them',
    );
  });

  test('tells the agents’ rules only as told them', () => {
    expect(rulesLine(admission)).toBe('');
    expect(
      rulesLine({
        ...admission,
        aiSilence: 180,
        aiOrders: '2 a second, a burst of 5',
        aiLooks: '4 a second, a burst of 10',
      }),
    ).toBe(
      'An agent silent 3 min sends its boat into its grace; orders: 2 a second, a burst of 5; looks: 4 a second, a burst of 10.',
    );
  });
});
