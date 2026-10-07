// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { type CapabilityEnv, readCapabilities } from './capabilities';

const everything: CapabilityEnv = {
  isSecureContext: true,
  requestGPUAdapter: async () => ({}),
  hasWakeLock: true,
  hasPublicKeyCredential: true,
  supportsModuleWorkers: () => true,
};

async function check(env: Partial<CapabilityEnv>, name: string) {
  const all = await readCapabilities({ ...everything, ...env });
  const found = all.find((c) => c.name === name);
  if (!found) {
    throw new Error(`no check named ${name}`);
  }
  return found;
}

describe('readCapabilities', () => {
  it('passes every check on a capable browser', async () => {
    const all = await readCapabilities(everything);
    expect(all.map((c) => c.name)).toEqual([
      'Secure context',
      'WebGPU',
      'Screen wake lock',
      'Passkeys',
      'Module workers',
    ]);
    expect(all.every((c) => c.ok)).toBe(true);
  });

  it('tells core features from compatibility mode', async () => {
    const core = await check(
      { requestGPUAdapter: async () => ({ features: new Set(['core-features-and-limits']) }) },
      'WebGPU',
    );
    expect(core.detail).toBe('adapter found, core features');
    const compat = await check(
      { requestGPUAdapter: async () => ({ features: new Set() }) },
      'WebGPU',
    );
    expect(compat.ok).toBe(true);
    expect(compat.detail).toBe('adapter found, compatibility mode');
  });

  it('flags a page not served over HTTPS', async () => {
    expect((await check({ isSecureContext: false }, 'Secure context')).ok).toBe(false);
  });

  it.each([
    ['no WebGPU', { requestGPUAdapter: undefined }, 'missing'],
    ['no adapter', { requestGPUAdapter: async () => null }, 'no adapter'],
    [
      'failed request',
      {
        requestGPUAdapter: async () => {
          throw new Error('lost');
        },
      },
      'failed',
    ],
  ])('falls back to WebGL 2 with %s', async (_, env, detail) => {
    const gpu = await check(env, 'WebGPU');
    expect(gpu.ok).toBe(false);
    expect(gpu.detail).toContain(detail);
  });

  it.each([
    ['Screen wake lock', { hasWakeLock: false }],
    ['Passkeys', { hasPublicKeyCredential: false }],
    ['Module workers', { supportsModuleWorkers: () => false }],
  ])('flags missing %s', async (name, env) => {
    expect((await check(env, name)).ok).toBe(false);
  });
});
