// SPDX-License-Identifier: AGPL-3.0-only

// What the browser offers that the game needs. Shown on the developer page,
// so a new phone can be checked at a glance.

export interface Capability {
  name: string;
  ok: boolean;
  detail: string;
}

/** The browser features the checks read, so tests can stand in for them. */
export interface CapabilityEnv {
  isSecureContext: boolean;
  requestGPUAdapter: (() => Promise<unknown>) | undefined;
  hasWakeLock: boolean;
  hasPublicKeyCredential: boolean;
  supportsModuleWorkers: () => boolean;
}

export async function readCapabilities(env: CapabilityEnv): Promise<Capability[]> {
  return [
    {
      name: 'Secure context',
      ok: env.isSecureContext,
      detail: env.isSecureContext ? 'HTTPS' : 'not HTTPS: WebGPU, wake lock and passkeys are off',
    },
    await gpu(env),
    {
      name: 'Screen wake lock',
      ok: env.hasWakeLock,
      detail: env.hasWakeLock ? 'available' : 'missing',
    },
    {
      name: 'Passkeys',
      ok: env.hasPublicKeyCredential,
      detail: env.hasPublicKeyCredential ? 'available' : 'missing',
    },
    {
      name: 'Module workers',
      ok: env.supportsModuleWorkers(),
      detail: env.supportsModuleWorkers() ? 'available' : 'missing',
    },
  ];
}

async function gpu(env: CapabilityEnv): Promise<Capability> {
  const name = 'WebGPU';
  if (!env.requestGPUAdapter) {
    return { name, ok: false, detail: 'missing: WebGL 2 will be used' };
  }
  try {
    const adapter = await env.requestGPUAdapter();
    return adapter
      ? { name, ok: true, detail: 'adapter found' }
      : { name, ok: false, detail: 'no adapter: WebGL 2 will be used' };
  } catch {
    return { name, ok: false, detail: 'adapter request failed: WebGL 2 will be used' };
  }
}

interface GPULike {
  requestAdapter(): Promise<unknown>;
}

/** The checks' inputs, read from this browser. */
export function browserEnv(): CapabilityEnv {
  const gpu = (navigator as Navigator & { gpu?: GPULike }).gpu;
  return {
    isSecureContext: globalThis.isSecureContext,
    requestGPUAdapter: gpu ? () => gpu.requestAdapter() : undefined,
    hasWakeLock: 'wakeLock' in navigator,
    hasPublicKeyCredential: 'PublicKeyCredential' in globalThis,
    supportsModuleWorkers,
  };
}

// A browser that supports module workers reads the type option; one that
// does not ignores it. No worker is started: the empty script fails at once.
function supportsModuleWorkers(): boolean {
  let read = false;
  const options = {
    get type(): WorkerType {
      read = true;
      return 'module';
    },
  };
  try {
    new Worker('data:,', options).terminate();
  } catch {
    // Reading the option is all that matters.
  }
  return read;
}
