// SPDX-License-Identifier: AGPL-3.0-only

// The screen kept on at sea. A boat on the autopilot, or a sailor watched,
// runs untouched for minutes, and a phone would turn its screen off after
// its own timeout. So while the scene is shown at sea (sailing, aboard or
// watching) and the page is in sight, the page holds a screen wake lock.
// The browser lets it go when the page is hidden, so it is taken again on
// every return to sight, and after every reveal. A refusal (low battery,
// a browser without the API) is normal and silent. It is let go on the
// start screen, while the connection is not at sea (the world's end, a
// connection lost), and when the full chart or the menu has been open and
// untouched for two minutes, so a phone left with the chart open still
// sleeps; a touch takes it again.

/** The lock the browser gives: the part of WakeLockSentinel used here. */
export interface Sentinel {
  readonly released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

/** navigator.wakeLock, as far as it is used; tests stand in for it. */
export interface LockApi {
  request(type: 'screen'): Promise<Sentinel>;
}

/** How long the chart or the menu may stand open untouched with the screen kept on, ms. */
export const IDLE = 2 * 60 * 1000;

/** The page about the lock: whether it is in sight, and the clock. */
export interface LockEnv {
  api: LockApi | null;
  visible: () => boolean;
  now: () => number;
}

export function browserLockEnv(): LockEnv {
  const api = (navigator as { wakeLock?: LockApi }).wakeLock ?? null;
  return {
    api,
    visible: () => document.visibilityState === 'visible',
    now: () => performance.now(),
  };
}

export class ScreenLock {
  /** Whether the full chart or the menu stands open: two minutes untouched, and the lock goes. */
  open: () => boolean = () => false;
  readonly #env: LockEnv;
  #atSea = false;
  #sailing = false;
  #wasOpen = false;
  #touched = 0;
  #held: Sentinel | null = null;
  #asking = false;

  constructor(env: LockEnv) {
    this.#env = env;
    this.#touched = env.now();
  }

  /** Whether the lock is held now. */
  get held(): boolean {
    return this.#held !== null && !this.#held.released;
  }

  /** Whether the screen is to be kept on now. */
  get wanted(): boolean {
    const open = this.open();
    if (open && !this.#wasOpen) {
      // Opened: the two minutes count from now.
      this.#touched = this.#env.now();
    }
    this.#wasOpen = open;
    return (
      this.#atSea &&
      this.#sailing &&
      this.#env.visible() &&
      !(open && this.#env.now() - this.#touched >= IDLE)
    );
  }

  /** The scene shown at sea (a reveal), or the start screen (false). */
  atSea(on: boolean): void {
    this.#atSea = on;
    this.check();
  }

  /** Whether the connection is at sea: sailing, aboard or watching. */
  sailing(on: boolean): void {
    this.#sailing = on;
    this.check();
  }

  /** The player touched the screen or a key. */
  touched(): void {
    this.#touched = this.#env.now();
    this.check();
  }

  /** Takes the lock if it is wanted and not held, lets it go if held and not wanted: on every change, and on a timer. */
  check(): void {
    const want = this.wanted;
    if (want && !this.held && !this.#asking && this.#env.api !== null) {
      this.#asking = true;
      this.#env.api.request('screen').then(
        (s) => {
          this.#asking = false;
          this.#held = s;
          s.addEventListener('release', () => {
            if (this.#held === s) {
              this.#held = null;
            }
          });
          // Let go meanwhile.
          if (!this.wanted) {
            this.#let();
          }
        },
        () => {
          // Refused: the screen sleeps as the phone has it.
          this.#asking = false;
        },
      );
    } else if (!want && this.held) {
      this.#let();
    }
  }

  #let(): void {
    const s = this.#held;
    this.#held = null;
    if (s !== null && !s.released) {
      void s.release().catch(() => {});
    }
  }
}

/** How often the lock is looked at: the two minutes' end, and a lock the browser let go. */
const EVERY = 5000;

/**
 * The lock, following the page: taken again whenever the page comes back
 * in sight, a touch or a key counted, and looked at every few seconds.
 */
export function screenLock(env: LockEnv = browserLockEnv()): ScreenLock {
  const lock = new ScreenLock(env);
  if (env.api === null) {
    return lock;
  }
  document.addEventListener('visibilitychange', () => lock.check());
  for (const type of ['pointerdown', 'keydown', 'wheel'] as const) {
    document.addEventListener(type, () => lock.touched(), { capture: true, passive: true });
  }
  setInterval(() => lock.check(), EVERY);
  return lock;
}
