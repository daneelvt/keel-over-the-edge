// SPDX-License-Identifier: AGPL-3.0-only

// The human check on the start screen: the widget rendered with the
// options the server and the screen need and run at once; Set sail's token
// waited for; a fresh token after every answer from the first step, and
// after one expired; the widget's error, a browser that cannot run it and
// a script that did not load each a failure with Try again; and nothing
// left running once the form has gone.

import { describe, expect, test } from 'vitest';
import {
  CHECK_ACTION,
  type LoadTurnstile,
  NewSailorCheck,
  type Turnstile,
  type WidgetOptions,
} from './humancheck';

const CHECK = { siteKey: '1x00000000000000000000AA', script: '/turnstile/api.js?render=explicit' };
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

/** A widget standing in for Turnstile's: every call written down, its callbacks at the test's call. */
function widget() {
  const calls: string[] = [];
  let options: WidgetOptions | null = null;
  let expired = false;
  const t: Turnstile = {
    render(_el, o) {
      calls.push('render');
      options = o;
      return 'w1';
    },
    execute: (id) => void calls.push(`execute ${id}`),
    reset: (id) => {
      calls.push(`reset ${id}`);
      expired = false;
    },
    remove: (id) => void calls.push(`remove ${id}`),
    isExpired: () => expired,
  };
  const opts = (): WidgetOptions => {
    if (options === null) {
      throw new Error('not rendered');
    }
    return options;
  };
  return {
    t,
    calls,
    opts,
    expire: () => {
      expired = true;
    },
    loads: [] as string[],
  };
}

function loader(w: ReturnType<typeof widget>): LoadTurnstile {
  return async (script) => {
    w.loads.push(script);
    return w.t;
  };
}

const slot = () =>
  ({ scrollIntoView: () => {} }) as unknown as HTMLElement & { scrollIntoView(): void };

/** Lets the promises waiting settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the human check', () => {
  test('rendered with its options and run at once, its script loaded from the server’s address', async () => {
    const w = widget();
    const c = new NewSailorCheck(CHECK, loader(w), 'en');
    expect(c.state.value).toBe('idle');
    await c.mount(slot());
    expect(w.loads).toEqual([CHECK.script]);
    expect(w.calls).toEqual(['render', 'execute w1']);
    expect(w.opts()).toMatchObject({
      sitekey: CHECK.siteKey,
      action: CHECK_ACTION,
      execution: 'execute',
      appearance: 'interaction-only',
      size: 'flexible',
      'refresh-expired': 'auto',
      language: 'en',
    });
    expect(CHECK_ACTION).toBe('new-sailor');
    expect(c.state.value).toBe('checking');
  });

  test('Set sail waits for the token, then has it at once', async () => {
    const w = widget();
    const c = new NewSailorCheck(CHECK, loader(w), 'en');
    await c.mount(slot());
    let got: string | null | undefined;
    void c.token().then((t) => {
      got = t;
    });
    await settle();
    expect(got).toBeUndefined();
    w.opts().callback(TOKEN);
    await settle();
    expect(got).toBe(TOKEN);
    expect(c.state.value).toBe('ready');
    expect(await c.token()).toBe(TOKEN);
  });

  test('after every answer from the first step, a fresh token', async () => {
    const w = widget();
    const c = new NewSailorCheck(CHECK, loader(w), 'en');
    await c.mount(slot());
    w.opts().callback(TOKEN);
    let held = TOKEN;
    for (let i = 0; i < 3; i++) {
      expect(await c.token()).toBe(held);
      w.calls.length = 0;
      c.spent();
      expect(w.calls).toEqual(['reset w1', 'execute w1']);
      expect(c.state.value).toBe('checking');
      // Not the spent one: the next the widget gives.
      let got: string | null | undefined;
      void c.token().then((t) => {
        got = t;
      });
      await settle();
      expect(got).toBeUndefined();
      w.opts().callback(`${TOKEN}${i}`);
      await settle();
      expect(got).toBe(`${TOKEN}${i}`);
      held = `${TOKEN}${i}`;
    }
  });

  test('an expired token is run again, by the widget’s word or found at Set sail', async () => {
    const w = widget();
    const c = new NewSailorCheck(CHECK, loader(w), 'en');
    await c.mount(slot());
    w.opts().callback(TOKEN);
    // Told by the widget.
    w.calls.length = 0;
    w.opts()['expired-callback']();
    expect(w.calls).toEqual(['reset w1', 'execute w1']);
    expect(c.state.value).toBe('checking');
    w.opts().callback('second');
    // Found expired when Set sail asks for it.
    w.expire();
    w.calls.length = 0;
    const next = c.token();
    expect(w.calls).toEqual(['reset w1', 'execute w1']);
    w.opts().callback('third');
    expect(await next).toBe('third');
  });

  test('the widget’s error and a browser that cannot run it: failed, and Try again runs it again', async () => {
    for (const fail of ['error-callback', 'unsupported-callback'] as const) {
      const w = widget();
      const c = new NewSailorCheck(CHECK, loader(w), 'en');
      await c.mount(slot());
      const waiting = c.token();
      if (fail === 'error-callback') {
        expect(w.opts()[fail]('110200')).toBe(true);
      } else {
        w.opts()[fail]();
      }
      expect(await waiting).toBeNull();
      expect(c.state.value).toBe('failed');
      expect(await c.token()).toBeNull();
      w.calls.length = 0;
      c.retry();
      expect(w.calls).toEqual(['reset w1', 'execute w1']);
      expect(c.state.value).toBe('checking');
      w.opts().callback(TOKEN);
      expect(await c.token()).toBe(TOKEN);
    }
  });

  test('a script that did not load: failed, and Try again loads it again', async () => {
    const w = widget();
    let tries = 0;
    const c = new NewSailorCheck(
      CHECK,
      async () => {
        if (tries++ === 0) {
          throw new Error('offline');
        }
        return w.t;
      },
      'en',
    );
    await c.mount(slot());
    expect(c.state.value).toBe('failed');
    expect(await c.token()).toBeNull();
    c.retry();
    await settle();
    expect(tries).toBe(2);
    expect(w.calls).toEqual(['render', 'execute w1']);
    w.opts().callback(TOKEN);
    expect(await c.token()).toBe(TOKEN);
  });

  test('the form gone: the widget removed, a late script ignored, Set sail told there is none', async () => {
    const w = widget();
    const c = new NewSailorCheck(CHECK, loader(w), 'en');
    await c.mount(slot());
    const waiting = c.token();
    c.unmount();
    expect(w.calls).toEqual(['render', 'execute w1', 'remove w1']);
    expect(await waiting).toBeNull();
    expect(c.state.value).toBe('idle');

    let release: (t: Turnstile) => void = () => {};
    const late = new NewSailorCheck(
      CHECK,
      () =>
        new Promise<Turnstile>((r) => {
          release = r;
        }),
      'en',
    );
    const mounting = late.mount(slot());
    late.unmount();
    const w2 = widget();
    release(w2.t);
    await mounting;
    expect(w2.calls).toEqual([]);
    expect(late.state.value).toBe('idle');
  });
});
