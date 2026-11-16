// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { cleanMessage, cleanStack, ERRORS, HELD, Reports, visitOf } from './report';

function sent() {
  const out: Record<string, unknown>[] = [];
  return { out, send: (b: string) => void out.push(JSON.parse(b) as Record<string, unknown>) };
}

describe('the page’s reports', () => {
  test('held until there is a session, then sent, and at once after', () => {
    const s = sent();
    const r = new Reports(s.send);
    r.error(
      'x is not a function',
      'TypeError\n    at f (http://localhost/assets/index-B1.js:1:200)',
    );
    r.startup({
      stages: { shell: 180.4, cover: 230, tap: 0 },
      bytes: 2_400_000.6,
      visit: 'first',
      tier: 2,
    });
    expect(s.out).toEqual([]);
    expect(r.held).toBe(2);
    r.open();
    expect(s.out).toEqual([
      { build: 'dev', kind: 'error', message: 'x is not a function', stack: 'index-B1.js:1:200' },
      {
        build: 'dev',
        kind: 'startup',
        stages: { shell: 180, cover: 230 },
        bytes: 2_400_001,
        visit: 'first',
        tier: 2,
      },
    ]);
    r.error('another', '');
    expect(s.out).toHaveLength(3);
    expect(r.held).toBe(0);
  });

  test('the queue is capped while no session comes', () => {
    const s = sent();
    const r = new Reports(s.send);
    for (let i = 0; i < 20; i++) {
      r.startup({ stages: { shell: i + 1 }, bytes: 0, visit: 'first', tier: 0 });
    }
    expect(r.held).toBe(HELD);
  });

  test('five errors a page at most, the same one once', () => {
    const s = sent();
    const r = new Reports(s.send);
    r.open();
    r.error('the same', 'a.js:1:1');
    r.error('the same', 'a.js:1:1');
    for (let i = 0; i < 10; i++) {
      r.error(`error ${i}`, '');
    }
    expect(s.out).toHaveLength(ERRORS);
    expect(s.out.filter((e) => e.message === 'the same')).toHaveLength(1);
  });
});

describe('no player’s words leave the page', () => {
  test('a message is cut before anything quoted', () => {
    expect(cleanMessage(`Cannot read properties of undefined (reading 'Ann Bonny')`)).toBe(
      'Cannot read properties of undefined (reading',
    );
    expect(cleanMessage('Unexpected token "Blackbeard"')).toBe('Unexpected token');
    expect(cleanMessage('no “Jolly Roger” here')).toBe('no');
    expect(cleanMessage('`name` is wrong')).toBe('');
  });

  test('an address becomes its file’s name, its query gone', () => {
    expect(
      cleanMessage(
        'Failed to fetch dynamically imported module: https://play.example/assets/log-Ab1.js?s=secret#x',
      ),
    ).toBe('Failed to fetch dynamically imported module: log-Ab1.js');
    expect(cleanMessage('WebSocket wss://play.example/ws?x=1 failed')).toBe('WebSocket ws failed');
  });

  test('a message is 300 characters at most, its spaces made one', () => {
    expect(cleanMessage(`a\n\n  b ${'x'.repeat(400)}`)).toHaveLength(300);
    expect(cleanMessage('a\n\n  b')).toBe('a b');
  });

  test('a stack is asset names and line numbers only, 2 KB at most', () => {
    const chrome = [
      'TypeError: Cannot read properties of null',
      '    at Ann.sail (https://play.example/assets/index-B1x.js:12:345)',
      '    at https://play.example/assets/chart-9a.js?v=2:4:5',
      '    at new Promise (<anonymous>)',
    ].join('\n');
    expect(cleanStack(chrome)).toBe('index-B1x.js:12:345\nchart-9a.js:4:5');
    const safari =
      'sail@https://play.example/assets/index-B1x.js:12:345\n@https://play.example/src/ui/menu.tsx:3';
    expect(cleanStack(safari)).toBe('index-B1x.js:12:345\nmenu.tsx:3');
    const long = Array.from(
      { length: 200 },
      (_, i) => `at f (https://x/assets/a-${i}.js:${i}:1)`,
    ).join('\n');
    expect(cleanStack(long).length).toBeLessThanOrEqual(2048);
    expect(cleanStack(long)).toMatch(/^[A-Za-z0-9._:\n-]+$/);
  });
});

describe('the visit', () => {
  const nav = (workerStart: number, deliveryType = '') => ({
    responseEnd: 100,
    workerStart,
    transferSize: 900,
    deliveryType,
  });
  test('served by the worker, from the browser’s cache, or a first', () => {
    expect(visitOf(nav(12), { transferSize: 0, decodedBodySize: 5000 })).toBe('worker');
    expect(visitOf(nav(0), { transferSize: 0, decodedBodySize: 5000 })).toBe('return');
    expect(visitOf(nav(0), { transferSize: 700_000, decodedBodySize: 2_000_000 })).toBe('first');
    expect(visitOf(nav(0, 'cache'), null)).toBe('return');
    expect(visitOf(null, null)).toBe('first');
  });
});
