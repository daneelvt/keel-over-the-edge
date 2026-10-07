// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { catalogsMatch, fetchVersion, parseVersion } from './version';

describe('parseVersion', () => {
  it('reads a version', () => {
    expect(parseVersion({ build: 'abc', catalog: '0123', extra: 1 })).toEqual({
      build: 'abc',
      catalog: '0123',
    });
  });
  it.each([null, 'v1', 3, {}, { build: 'abc' }, { build: 1, catalog: '0123' }])(
    'rejects %j',
    (value) => {
      expect(parseVersion(value)).toBeNull();
    },
  );
});

describe('catalogsMatch', () => {
  it('compares catalog versions', () => {
    expect(catalogsMatch({ build: 'a', catalog: 'x' }, 'x')).toBe(true);
    expect(catalogsMatch({ build: 'a', catalog: 'x' }, 'y')).toBe(false);
  });
});

describe('fetchVersion', () => {
  const answer = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

  it('returns the server version', async () => {
    await expect(fetchVersion(answer(200, { build: 'b', catalog: 'c' }))).resolves.toEqual({
      build: 'b',
      catalog: 'c',
    });
  });
  it('fails on an error status', async () => {
    await expect(fetchVersion(answer(502, {}))).rejects.toThrow('502');
  });
  it('fails on a body that is not a version', async () => {
    await expect(fetchVersion(answer(200, { hello: 1 }))).rejects.toThrow('version');
  });
});
