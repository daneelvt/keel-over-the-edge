// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { keepStorage, switchOff, type WorkerEnv, wantsWorker } from './sw';

describe('whether the page registers the worker', () => {
  const env: WorkerEnv = { built: true, on: true, supported: true };
  const q = (s: string) => new URLSearchParams(s);

  test('a built page, at a link or not', () => {
    expect(wantsWorker(env, q(''))).toBe(true);
    expect(wantsWorker(env, q('w=abc'))).toBe(true);
    expect(wantsWorker(env, q('s=abc'))).toBe(true);
  });

  test('never under the development server, a test, the sandbox, or switched off', () => {
    expect(wantsWorker({ ...env, built: false }, q(''))).toBe(false);
    expect(wantsWorker(env, q('test'))).toBe(false);
    expect(wantsWorker(env, q('sandbox'))).toBe(false);
    expect(wantsWorker({ ...env, on: false }, q(''))).toBe(false);
    expect(wantsWorker({ ...env, supported: false }, q(''))).toBe(false);
  });
});

describe('the game’s storage kept', () => {
  const marks = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    };
  };
  const storage = (persisted = false) => {
    const asked: string[] = [];
    return {
      asked,
      persisted: async () => persisted,
      persist: async () => {
        asked.push('persist');
        return true;
      },
    };
  };

  test('asked once, only where the game runs installed', async () => {
    const s = storage();
    const m = marks();
    expect(await keepStorage(s, false, m)).toBe(false);
    expect(s.asked).toEqual([]);
    expect(await keepStorage(s, true, m)).toBe(true);
    expect(await keepStorage(s, true, m)).toBe(false);
    expect(s.asked).toEqual(['persist']);
  });

  test('not asked when already kept, or with no storage manager', async () => {
    const s = storage(true);
    expect(await keepStorage(s, true, marks())).toBe(false);
    expect(s.asked).toEqual([]);
    expect(await keepStorage(undefined, true, marks())).toBe(false);
  });
});

describe('the worker switched off', () => {
  const kept = (names: string[]) => {
    const gone: string[] = [];
    let unregistered = 0;
    return {
      gone,
      unregistered: () => unregistered,
      registrations: async () => [
        {
          unregister: async () => {
            unregistered++;
            return true;
          },
        },
      ],
      caches: {
        keys: async () => names,
        delete: async (name: string) => {
          gone.push(name);
          return true;
        },
      },
    };
  };

  test('the page takes the registration and the worker’s caches away itself, and no other cache', async () => {
    const k = kept(['keel-code-1', 'keel-art', 'another']);
    await switchOff(k);
    expect(k.unregistered()).toBe(1);
    expect(k.gone).toEqual(['keel-code-1', 'keel-art']);
  });

  test('storage refused is no error', async () => {
    const k = kept([]);
    await expect(
      switchOff({ ...k, registrations: () => Promise.reject(new Error('refused')) }),
    ).resolves.toBeUndefined();
  });
});
