// SPDX-License-Identifier: AGPL-3.0-only

// The page's one way to add a script to itself: its address made by the
// keel Trusted Types policy, each script loaded once, one that failed
// asked for again, and an address the page never loads refused before any
// element is made.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ScriptDocument } from './scripts';

const ORIGIN = 'https://play.keelovertheedge.com';
const TURNSTILE = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** What a policy made: an object, not the string, as the browser's TrustedScriptURL is. */
class Made {
  constructor(
    readonly policy: string,
    readonly address: string,
  ) {}
  toString(): string {
    return this.address;
  }
}

/** The browser's trustedTypes, its policies' addresses made as Made. */
function trustedTypes() {
  const made: string[] = [];
  return {
    made,
    createPolicy(
      name: string,
      options: { createScriptURL?: (input: string) => string | null },
    ): { name: string; createScriptURL(input: string): Made } {
      return {
        name,
        createScriptURL(input: string) {
          const out = options.createScriptURL?.(input);
          if (out === null || out === undefined) {
            throw new TypeError('refused');
          }
          made.push(`${name} ${input}`);
          return new Made(name, out);
        },
      };
    },
  };
}

/** A script element's parts the loader uses: its address, and its load or error. */
class FakeScript {
  src: unknown = '';
  async = false;
  removed = false;
  #listeners = new Map<string, () => void>();
  addEventListener(type: string, f: () => void): void {
    this.#listeners.set(type, f);
  }
  fire(type: 'load' | 'error'): void {
    this.#listeners.get(type)?.();
  }
  remove(): void {
    this.removed = true;
  }
}

function fakeDocument(): ScriptDocument & { scripts: FakeScript[] } {
  const scripts: FakeScript[] = [];
  return {
    scripts,
    createElement: () => {
      const s = new FakeScript();
      scripts.push(s);
      return s as unknown as HTMLScriptElement;
    },
    head: { append: () => {} },
  };
}

describe('a script the page adds to itself', () => {
  let tt: ReturnType<typeof trustedTypes>;

  beforeEach(() => {
    vi.resetModules();
    tt = trustedTypes();
    vi.stubGlobal('location', { origin: ORIGIN });
    vi.stubGlobal('trustedTypes', tt);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('its address made by the keel policy, loaded once', async () => {
    const { loadScript } = await import('./scripts');
    const doc = fakeDocument();
    const first = loadScript(TURNSTILE, doc);
    const again = loadScript(TURNSTILE, doc);
    expect(again).toBe(first);
    expect(doc.scripts).toHaveLength(1);
    const s = doc.scripts[0] as FakeScript;
    // The element's address is the policy's, not a plain string.
    expect(s.src).toBeInstanceOf(Made);
    expect((s.src as Made).policy).toBe('keel');
    expect(String(s.src)).toBe(TURNSTILE);
    expect(s.async).toBe(true);
    expect(tt.made).toEqual([`keel ${TURNSTILE}`]);
    s.fire('load');
    await expect(first).resolves.toBeUndefined();
    // Loaded: asked again, the same, no element made.
    await loadScript(TURNSTILE, doc);
    expect(doc.scripts).toHaveLength(1);
  });

  test('the stand-in on the page’s own origin, through the same policy', async () => {
    const { loadScript } = await import('./scripts');
    const doc = fakeDocument();
    const loaded = loadScript('/turnstile/api.js?render=explicit', doc);
    (doc.scripts[0] as FakeScript).fire('load');
    await loaded;
    expect(tt.made).toEqual(['keel /turnstile/api.js?render=explicit']);
  });

  test('one that failed is removed, and asked for anew', async () => {
    const { loadScript } = await import('./scripts');
    const doc = fakeDocument();
    const failed = loadScript(TURNSTILE, doc);
    (doc.scripts[0] as FakeScript).fire('error');
    await expect(failed).rejects.toThrow(/did not load/);
    expect((doc.scripts[0] as FakeScript).removed).toBe(true);
    const again = loadScript(TURNSTILE, doc);
    expect(again).not.toBe(failed);
    expect(doc.scripts).toHaveLength(2);
    (doc.scripts[1] as FakeScript).fire('load');
    await again;
  });

  test('an address the page never loads: refused, no element made', async () => {
    const { loadScript } = await import('./scripts');
    const doc = fakeDocument();
    for (const a of [
      'https://example.com/api.js',
      'https://challenges.cloudflare.com/cdn-cgi/x.js',
      'data:text/javascript,1',
      '/src/boot/main.ts',
    ]) {
      await expect(loadScript(a, doc), a).rejects.toThrow(/Not a script/);
    }
    expect(doc.scripts).toEqual([]);
    expect(tt.made).toEqual([]);
  });
});
