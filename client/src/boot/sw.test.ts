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
  /** The caches by name, a registration, and a wait during which the worker before may keep a file. */
  const kept = (names: string[], during: () => void = () => {}) => {
    const state = { names: [...names], unregistered: 0, waited: [] as number[] };
    return {
      state,
      registrations: async () => [
        {
          unregister: async () => {
            state.unregistered++;
            return true;
          },
        },
      ],
      caches: {
        keys: async () => [...state.names],
        delete: async (name: string) => {
          state.names = state.names.filter((n) => n !== name);
          return true;
        },
      },
      wait: async (ms: number) => {
        state.waited.push(ms);
        during();
      },
    };
  };

  test('the page takes the registration and the worker’s caches away itself, and no other cache', async () => {
    const k = kept(['keel-code-1', 'keel-art', 'another']);
    await switchOff(k);
    expect(k.state.unregistered).toBe(1);
    expect(k.state.names).toEqual(['another']);
  });

  test('a cache the worker before made again as it finished an answer is taken away too', async () => {
    const k = kept(['keel-code-1', 'keel-art'], () => {
      k.state.names.push('keel-art');
    });
    await switchOff(k);
    expect(k.state.waited).toEqual([3000]);
    expect(k.state.names).toEqual([]);
  });

  test('storage refused is no error', async () => {
    const k = kept([]);
    await expect(
      switchOff({ ...k, registrations: () => Promise.reject(new Error('refused')) }),
    ).resolves.toBeUndefined();
  });
});
