// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, test } from 'vitest';
import { codeFailed, updated, watchForUpdates } from './updated';

describe('the game updated under the page', () => {
  beforeEach(() => {
    updated.value = false;
  });

  test('a file failed and the server is on another build: the line shows', async () => {
    await codeFailed({ build: 'b1', serverBuild: async () => 'b2' });
    expect(updated.value).toBe(true);
  });

  test('the server on this page’s build: nothing shows', async () => {
    await codeFailed({ build: 'b1', serverBuild: async () => 'b1' });
    expect(updated.value).toBe(false);
  });

  test('the network down: nothing shows, and the next failure asks again', async () => {
    let asked = 0;
    const down = {
      build: 'b1',
      serverBuild: async () => {
        asked++;
        throw new TypeError('Failed to fetch');
      },
    };
    await codeFailed(down);
    expect(updated.value).toBe(false);
    await codeFailed(down);
    expect(asked).toBe(2);
  });

  test('asked once at a time, and never for a development page', async () => {
    let asked = 0;
    const check = {
      build: 'b1',
      serverBuild: async () => {
        asked++;
        return 'b2';
      },
    };
    await Promise.all([codeFailed(check), codeFailed(check), codeFailed(check)]);
    expect(asked).toBe(1);
    await codeFailed(check);
    expect(asked).toBe(1);
    updated.value = false;
    await codeFailed({ ...check, build: 'dev' });
    expect(asked).toBe(1);
    expect(updated.value).toBe(false);
  });

  test('a preload failing is listened for', () => {
    const heard: string[] = [];
    watchForUpdates({ addEventListener: (type: string) => heard.push(type) });
    expect(heard).toEqual(['vite:preloadError']);
  });
});
