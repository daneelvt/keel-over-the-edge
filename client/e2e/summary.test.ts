// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { minutes, type Row, summarize } from './summary';

const row = (
  title: string,
  outcome: Row['outcome'],
  tries: number[],
  errors: string[] = [],
): Row => ({
  where: `x.spec.ts:${tries.length}`,
  title,
  project: 'webgl2',
  outcome,
  tries,
  errors,
});

describe('the run summary', () => {
  it('writes times as minutes and seconds', () => {
    expect(minutes(0)).toBe('0:00');
    expect(minutes(59_400)).toBe('0:59');
    expect(minutes(61_000)).toBe('1:01');
    expect(minutes(3_600_000)).toBe('60:00');
  });

  it('counts the outcomes and lists the slowest ten that ran, slowest first', () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, i) => row(`t${i}`, 'expected', [1000 * (i + 1)])),
      row('skipped', 'skipped', [0]),
    ];
    const md = summarize('browser (webgl2)', rows, 125_000, 'passed');
    expect(md).toContain('### browser (webgl2)');
    expect(md).toContain('13 tests in 2:05, passed: 12 passed, 0 flaky, 0 failed, 1 skipped.');
    const listed = md.split('\n').filter((l) => l.startsWith('| x.spec.ts'));
    expect(listed).toHaveLength(10);
    expect(listed[0]).toContain('t11');
    expect(listed[9]).toContain('t2');
    expect(md).not.toContain('Flaky');
  });

  it('names each flaky and failed test with its tries and first error', () => {
    const md = summarize(
      'run',
      [
        row('a | b', 'flaky', [90_000, 20_000], ['Test timeout of 90000ms exceeded.']),
        row('c', 'unexpected', [5000], ['expect(received).toBe(expected)']),
      ],
      1000,
      'failed',
    );
    expect(md).toContain('| x.spec.ts:2 a \\| b | webgl2 | 1:50 | 2 |');
    expect(md).toContain(
      '- x.spec.ts:2 a | b (webgl2; tries 1:30, 0:20): Test timeout of 90000ms exceeded.',
    );
    expect(md).toContain('**Failed:**\n\n- x.spec.ts:1 c (webgl2; tries 0:05): expect(received)');
  });

  it('counts a test run again and again as one, flaky if it passed in some runs and not others', () => {
    const md = summarize(
      'hunt',
      [
        ...Array.from({ length: 4 }, () => row('steady', 'expected', [1000])),
        row('steady', 'unexpected', [90_000], ['Test timeout of 90000ms exceeded.']),
        ...Array.from({ length: 5 }, () => ({
          ...row('fine', 'expected', [2000]),
          where: 'y.spec.ts:3',
        })),
      ],
      200_000,
      'failed',
    );
    expect(md).toContain(
      '2 tests, each run up to 5 times, in 3:20, failed: 1 passed, 1 flaky, 0 failed, 0 skipped.',
    );
    expect(md).toContain(
      '- x.spec.ts:1 steady (webgl2; passed 4 of 5 runs): Test timeout of 90000ms exceeded.',
    );
    expect(md).toContain('| x.spec.ts | 1:34 |\n| y.spec.ts | 0:10 |');
  });
});
