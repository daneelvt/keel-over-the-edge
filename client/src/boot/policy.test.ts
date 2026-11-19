// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  addressOf,
  defaultAllows,
  keelAllows,
  makePolicies,
  type PolicyFactory,
  scriptURL,
  violationOf,
} from './policy';
import { Reports, VIOLATIONS } from './report';

const ORIGIN = 'https://play.keelovertheedge.com';
const TURNSTILE = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

describe('the keel policy: the page’s own scripts', () => {
  test('its files, the service worker and the human check', () => {
    for (const a of [
      '/assets/main-Bx1qT7.js',
      `${ORIGIN}/assets/worker-Bq2.js`,
      '/sw.js',
      TURNSTILE,
      'https://challenges.cloudflare.com/turnstile/v0/g/4a1b/api.js',
      '/turnstile/api.js',
      `${ORIGIN}/turnstile/api.js?render=explicit`,
    ]) {
      expect(keelAllows(a, ORIGIN), a).toBe(true);
    }
  });

  test('nothing else', () => {
    for (const a of [
      '/index.js',
      '/sw.js.map',
      '/assets/../sw2.js',
      '/assetsx/main.js',
      'https://example.com/assets/main.js',
      '//example.com/assets/main.js',
      'http://play.keelovertheedge.com/assets/main.js',
      'http://challenges.cloudflare.com/turnstile/v0/api.js',
      'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x.js',
      'https://challenges.cloudflare.com.example.com/turnstile/v0/api.js',
      'https://user:pw@challenges.cloudflare.com/turnstile/v0/api.js',
      'data:text/javascript,1',
      `blob:${ORIGIN}/0b9e8c1d-1f5e-4b8a-9d1c-2e3f4a5b6c7d`,
      'javascript:alert(1)',
      '',
    ]) {
      expect(keelAllows(a, ORIGIN), a).toBe(false);
    }
  });
});

describe('the default policy: what libraries pass as strings', () => {
  test('this origin, its own blobs and the human check', () => {
    for (const a of [
      '/assets/worker-Bq2.js',
      `${ORIGIN}/anything.js`,
      `blob:${ORIGIN}/0b9e8c1d-1f5e-4b8a-9d1c-2e3f4a5b6c7d`,
      TURNSTILE,
    ]) {
      expect(defaultAllows(a, ORIGIN), a).toBe(true);
    }
  });

  test('no other origin, no other origin’s blobs, no data or javascript', () => {
    for (const a of [
      'https://example.com/x.js',
      'blob:https://example.com/0b9e8c1d-1f5e-4b8a-9d1c-2e3f4a5b6c7d',
      'blob:null/0b9e8c1d',
      'data:,',
      'data:text/javascript,alert(1)',
      'javascript:alert(1)',
      'https://challenges.cloudflare.com/other/x.js',
    ]) {
      expect(defaultAllows(a, ORIGIN), a).toBe(false);
    }
  });
});

/** A factory as the browser's: each policy's functions, named, called as the browser calls them. */
function fakeFactory() {
  const made = new Map<string, Record<string, ((s: string) => string | null) | undefined>>();
  const factory: PolicyFactory = {
    createPolicy(name, options) {
      made.set(name, options as Record<string, (s: string) => string | null>);
      return {
        name,
        createScriptURL: (s: string) => {
          const out = options.createScriptURL?.(s);
          if (out === null || out === undefined) {
            throw new TypeError('refused');
          }
          return { toString: () => out };
        },
      };
    },
  };
  return { factory, made };
}

describe('the policies made', () => {
  test('keel and default, named as the page’s policy allows', () => {
    const { factory, made } = fakeFactory();
    const p = makePolicies(factory, ORIGIN);
    expect([...made.keys()]).toEqual(['keel', 'default']);
    expect(p.keel.createScriptURL('/sw.js').toString()).toBe('/sw.js');
    expect(() => p.keel.createScriptURL('https://example.com/x.js')).toThrow(/Not a script/);
    expect(p.default.createScriptURL(`blob:${ORIGIN}/abc`).toString()).toBe(`blob:${ORIGIN}/abc`);
  });

  test('the default refuses every address not allowed, and all HTML and script', () => {
    const { factory, made } = fakeFactory();
    makePolicies(factory, ORIGIN);
    const d = made.get('default');
    expect(d?.createScriptURL?.('data:,')).toBeNull();
    expect(d?.createScriptURL?.('https://example.com/x.js')).toBeNull();
    expect(d?.createHTML?.('<img src=x onerror=alert(1)>')).toBeNull();
    expect(d?.createHTML?.('<b>plain</b>')).toBeNull();
    expect(d?.createScript?.('alert(1)')).toBeNull();
    // The keel policy makes no HTML or script at all.
    expect(made.get('keel')?.createHTML).toBeUndefined();
    expect(made.get('keel')?.createScript).toBeUndefined();
  });
});

describe('scriptURL without Trusted Types', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('a plain string, for an address the page loads', () => {
    vi.stubGlobal('location', { origin: ORIGIN });
    expect(scriptURL('/sw.js')).toBe('/sw.js');
    expect(scriptURL(TURNSTILE)).toBe(TURNSTILE);
  });

  test('refused for any other', () => {
    vi.stubGlobal('location', { origin: ORIGIN });
    expect(() => scriptURL('https://example.com/x.js')).toThrow(/Not a script/);
    expect(() => scriptURL('data:text/javascript,1')).toThrow(/Not a script/);
  });
});

describe('a violation as it is reported', () => {
  test('an address’s origin and path, no query or fragment; a scheme alone for others', () => {
    expect(addressOf('https://example.com/a/b.js?token=secret#x')).toBe(
      'https://example.com/a/b.js',
    );
    expect(addressOf('wss://play.keelovertheedge.com/ws?t=1')).toBe(
      'wss://play.keelovertheedge.com/ws',
    );
    expect(addressOf('data:application/wasm;base64,AGFzbQ')).toBe('data');
    expect(addressOf(`blob:${ORIGIN}/abc`)).toBe('blob');
    expect(addressOf('inline')).toBe('inline');
    expect(addressOf('trusted-types-sink')).toBe('trusted-types-sink');
    expect(addressOf('Ann Bonny said hello')).toBe('');
  });

  test('its directive, what was refused, the asset and line, never the sample', () => {
    const v = violationOf({
      effectiveDirective: 'worker-src',
      blockedURI: 'data',
      sourceFile: `${ORIGIN}/assets/main-Bx1qT7.js?v=1`,
      lineNumber: 102,
      sample: 'Worker constructor|data:,',
    } as never);
    expect(v).toEqual({
      directive: 'worker-src',
      blocked: 'data',
      source: 'main-Bx1qT7.js',
      line: 102,
    });
    expect(JSON.stringify(v)).not.toContain('constructor');
    expect(
      violationOf({
        effectiveDirective: 'Script Src',
        blockedURI: '',
        sourceFile: '',
        lineNumber: -3,
      }),
    ).toEqual({ directive: 'other', blocked: '', source: '', line: 0 });
  });

  test('sent as a report of kind policy, five a page, each once', () => {
    const sent: string[] = [];
    const r = new Reports((b) => sent.push(b));
    r.open();
    const v = {
      directive: 'connect-src',
      blocked: 'https://example.com/x',
      source: 'main.js',
      line: 3,
    };
    r.policy(v);
    r.policy(v);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0] ?? '')).toEqual({ build: 'dev', kind: 'policy', ...v });
    for (let i = 0; i < 10; i++) {
      r.policy({ ...v, line: 10 + i });
    }
    expect(sent).toHaveLength(VIOLATIONS);
    // Errors keep their own count.
    r.error('x is not a function', '');
    expect(sent).toHaveLength(VIOLATIONS + 1);
  });

  test('held until there is a session, empty fields left out', () => {
    const sent: string[] = [];
    const r = new Reports((b) => sent.push(b));
    r.policy({
      directive: 'require-trusted-types-for',
      blocked: 'trusted-types-sink',
      source: '',
      line: 0,
    });
    expect(sent).toHaveLength(0);
    r.open();
    expect(JSON.parse(sent[0] ?? '')).toEqual({
      build: 'dev',
      kind: 'policy',
      directive: 'require-trusted-types-for',
      blocked: 'trusted-types-sink',
    });
  });
});
