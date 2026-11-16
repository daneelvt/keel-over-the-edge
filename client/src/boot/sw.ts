// SPDX-License-Identifier: AGPL-3.0-only

// The page's side of the service worker (src/sw/): registered once the
// world is revealed, or after a while on the start screen, whichever comes
// first, so that it never competes with the first download; only in a
// built page, never under the development server, a page under test or
// the sandbox. Installed, the game asks the browser once to keep its
// storage. A build with the worker switched off (KEEL_SW=off) registers
// nothing and takes away any worker and caches it finds.

import { PREFIX } from '../sw/worker';
import { browserEnv, installed } from './fullscreen';

declare const __KEEL_SW__: boolean;

/** The worker's address, at the top of the site so its scope is the whole game. */
export const WORKER_URL = '/sw.js';
/** How long the start screen may stand before the worker is registered all the same, ms. */
export const REGISTER_AFTER = 20_000;
/** How long a page waits for a waiting worker to take over before it reloads anyway, ms. */
export const TAKE_OVER_WAIT = 3000;
/** Marked once the browser has been asked to keep the game's storage. */
const PERSIST_KEY = 'keel-persist-asked';

/** What a page needs to have the worker. */
export interface WorkerEnv {
  /** A built page, not the development server. */
  built: boolean;
  /** The build has the worker (not KEEL_SW=off). */
  on: boolean;
  /** The browser has service workers (a secure origin). */
  supported: boolean;
}

/** Whether this page registers the worker: built, on, supported, and neither under test nor the sandbox. */
export function wantsWorker(env: WorkerEnv, query: URLSearchParams): boolean {
  return env.built && env.on && env.supported && !query.has('test') && !query.has('sandbox');
}

function pageEnv(): WorkerEnv {
  return {
    built: import.meta.env.PROD,
    on: __KEEL_SW__,
    supported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
  };
}

/**
 * Registers the worker: the one place the page does, so that a policy on
 * script addresses (Trusted Types) has one call to cover.
 */
export function register(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register(WORKER_URL, { scope: '/', updateViaCache: 'none' });
}

/** The parts of the storage manager asked. */
export interface Keeping {
  persisted(): Promise<boolean>;
  persist(): Promise<boolean>;
}

/**
 * Asks the browser once to keep the game's storage, only where the game
 * runs installed: there it is granted without a question, and it matters
 * most. Elsewhere a browser might ask the player, which the game never
 * causes. Whether it was asked.
 */
export async function keepStorage(
  storage: Keeping | undefined,
  isInstalled: boolean,
  marks: Pick<Storage, 'getItem' | 'setItem'> | null,
): Promise<boolean> {
  if (storage === undefined || !isInstalled) {
    return false;
  }
  try {
    if (marks !== null && marks.getItem(PERSIST_KEY) !== null) {
      return false;
    }
    if (await storage.persisted()) {
      return false;
    }
    marks?.setItem(PERSIST_KEY, '1');
    await storage.persist();
    return true;
  } catch {
    // Storage refused: nothing kept, and nothing lost.
    return false;
  }
}

function localMarks(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

async function registerAndKeep(): Promise<void> {
  try {
    await register();
  } catch (err) {
    console.warn('The service worker was not registered:', err);
    return;
  }
  await keepStorage(navigator.storage, installed(browserEnv()), localMarks());
}

/** The worker switched off: any worker unregistered, and the caches it kept deleted. */
async function switchOff(): Promise<void> {
  try {
    for (const reg of await navigator.serviceWorker.getRegistrations()) {
      await reg.unregister();
    }
    for (const name of await caches.keys()) {
      if (name.startsWith(PREFIX)) {
        await caches.delete(name);
      }
    }
  } catch {
    // Nothing to take away, or storage refused.
  }
}

/** The worker's start on this page: revealed() registers it at once, if the wait has not already. */
export interface WorkerStart {
  revealed(): void;
}

/**
 * Starts the worker's wait on a page at sea: registered at the reveal or
 * after REGISTER_AFTER, whichever is first; nothing where the page does
 * not want it, and the worker taken away in a build that has it off.
 */
export function startWorker(query: URLSearchParams): WorkerStart {
  const env = pageEnv();
  if (env.built && env.supported && !env.on) {
    void switchOff();
  }
  if (!wantsWorker(env, query)) {
    return { revealed: () => {} };
  }
  let done = false;
  const go = (): void => {
    if (done) {
      return;
    }
    done = true;
    clearTimeout(timer);
    void registerAndKeep();
  };
  const timer = setTimeout(go, REGISTER_AFTER);
  return { revealed: go };
}

/**
 * Before the page reloads for a new build (the server closed it as out of
 * date): a new worker waiting is told to take over, and the reload waits
 * until it has, or TAKE_OVER_WAIT, so the page comes back under it.
 */
export async function takeOverFirst(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }
  const sw = navigator.serviceWorker;
  let waiting: ServiceWorker | null = null;
  try {
    waiting = (await sw.getRegistration())?.waiting ?? null;
  } catch {
    return;
  }
  if (waiting === null) {
    return;
  }
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, TAKE_OVER_WAIT);
    sw.addEventListener(
      'controllerchange',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
    waiting.postMessage({ type: 'take-over' });
  });
}
