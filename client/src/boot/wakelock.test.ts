// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { IDLE, type LockApi, ScreenLock, type Sentinel } from './wakelock';

/** A wake lock that records what was asked of it; the browser's own let go by release(). */
function recorder(refuse = false) {
  const log: string[] = [];
  const held: { s: Sentinel; drop: () => void }[] = [];
  const api: LockApi = {
    request(type) {
      log.push(`request ${type}`);
      if (refuse) {
        return Promise.reject(new Error('low battery'));
      }
      const listeners: (() => void)[] = [];
      const s = {
        released: false,
        release() {
          if (!s.released) {
            s.released = true;
            log.push('release');
            for (const l of listeners) {
              l();
            }
          }
          return Promise.resolve();
        },
        addEventListener(_t: 'release', l: () => void) {
          listeners.push(l);
        },
      };
      // The browser lets it go itself, as when the page is hidden.
      held.push({
        s,
        drop: () => {
          s.released = true;
          for (const l of listeners) {
            l();
          }
        },
      });
      return Promise.resolve(s);
    },
  };
  return { api, log, held };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the screen kept on at sea', () => {
  test('taken at the reveal while sailing, and let go back at the start screen', async () => {
    const r = recorder();
    let now = 0;
    const lock = new ScreenLock({ api: r.api, visible: () => true, now: () => now });
    lock.sailing(true);
    await settle();
    // The start screen: not yet.
    expect(r.log).toEqual([]);
    lock.atSea(true);
    await settle();
    expect(r.log).toEqual(['request screen']);
    expect(lock.held).toBe(true);
    // Asked again while held: nothing more.
    lock.check();
    now += 1000;
    lock.touched();
    await settle();
    expect(r.log).toEqual(['request screen']);
    lock.atSea(false);
    await settle();
    expect(r.log).toEqual(['request screen', 'release']);
    expect(lock.held).toBe(false);
  });

  test('let go while the connection is not at sea, as at the world’s end, and taken again after', async () => {
    const r = recorder();
    const lock = new ScreenLock({ api: r.api, visible: () => true, now: () => 0 });
    lock.atSea(true);
    lock.sailing(true);
    await settle();
    lock.sailing(false);
    await settle();
    lock.sailing(true);
    await settle();
    expect(r.log).toEqual(['request screen', 'release', 'request screen']);
  });

  test('let go by the browser as the page hides, taken again once it is in sight', async () => {
    const r = recorder();
    let visible = true;
    const lock = new ScreenLock({ api: r.api, visible: () => visible, now: () => 0 });
    lock.atSea(true);
    lock.sailing(true);
    await settle();
    visible = false;
    r.held[0]?.drop();
    lock.check();
    await settle();
    expect(lock.held).toBe(false);
    expect(r.log).toEqual(['request screen']);
    visible = true;
    lock.check();
    await settle();
    expect(r.log).toEqual(['request screen', 'request screen']);
    expect(lock.held).toBe(true);
  });

  test('the chart open two minutes untouched lets it go; a touch takes it again', async () => {
    const r = recorder();
    let now = 0;
    let open = false;
    const lock = new ScreenLock({ api: r.api, visible: () => true, now: () => now });
    lock.open = () => open;
    lock.atSea(true);
    lock.sailing(true);
    await settle();
    // Untouched at sea with nothing open: kept on however long.
    now += 10 * IDLE;
    lock.check();
    await settle();
    expect(r.log).toEqual(['request screen']);
    // The chart opened: two minutes from then.
    open = true;
    lock.check();
    now += IDLE - 1;
    lock.check();
    await settle();
    expect(lock.held).toBe(true);
    now += 1;
    lock.check();
    await settle();
    expect(r.log).toEqual(['request screen', 'release']);
    lock.touched();
    await settle();
    expect(r.log).toEqual(['request screen', 'release', 'request screen']);
    // Closed: no limit again.
    open = false;
    now += 10 * IDLE;
    lock.check();
    await settle();
    expect(lock.held).toBe(true);
  });

  test('a refusal is silent, and asked again later', async () => {
    const r = recorder(true);
    const lock = new ScreenLock({ api: r.api, visible: () => true, now: () => 0 });
    lock.atSea(true);
    lock.sailing(true);
    await settle();
    expect(lock.held).toBe(false);
    lock.check();
    await settle();
    expect(r.log).toEqual(['request screen', 'request screen']);
  });

  test('no wake lock in the browser: nothing asked, nothing thrown', () => {
    const lock = new ScreenLock({ api: null, visible: () => true, now: () => 0 });
    lock.atSea(true);
    lock.sailing(true);
    expect(lock.held).toBe(false);
  });
});
