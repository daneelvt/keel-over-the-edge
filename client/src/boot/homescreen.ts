// SPDX-License-Identifier: AGPL-3.0-only

// The game on the home screen. A player who keeps coming back is offered,
// once, to play from their home screen: from their third day of play, on
// their own panel under Set sail, where the browser can install the game
// (Chrome has offered to, by its beforeinstallprompt, kept here) or on an
// iPhone (where the menu's three steps do it). A day of play is a Set sail
// on a date not counted before, kept on the device. Add Keel asks Chrome
// to install the game, or shows the iPhone's steps; Not now, or the game
// installed, puts the offer away for good. In the menu, Chrome's own way
// becomes an Install key once the browser has offered to install it.
// Never at sea: nothing here is a key on the screen at sea.

import { computed, type ReadonlySignal, signal } from '@preact/signals';
import type { Store } from '../ui/settings';
import { browserEnv, installed, offer, type ScreenEnv } from './fullscreen';

/** Chrome's offer to install, as beforeinstallprompt gives it. */
export interface InstallPrompt {
  prompt(): Promise<unknown>;
  readonly userChoice: Promise<{ outcome: string }>;
  preventDefault(): void;
}

/** The days counted, the last, and whether the offer is put away: what the device keeps. */
interface Kept {
  days: number;
  last: string;
  done: boolean;
}

const KEY = 'keel.homeScreen';

/** The day of play the offer comes on. */
export const OFFER_DAY = 3;

/** A date as the player's own calendar has it, YYYY-MM-DD. */
export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function read(store: Store | null): Kept {
  const out: Kept = { days: 0, last: '', done: false };
  try {
    const raw: unknown = JSON.parse(store?.getItem(KEY) ?? 'null');
    if (raw !== null && typeof raw === 'object') {
      const r = raw as Record<string, unknown>;
      if (typeof r.days === 'number' && Number.isInteger(r.days) && r.days >= 0) {
        out.days = r.days;
      }
      if (typeof r.last === 'string') {
        out.last = r.last;
      }
      out.done = r.done === true;
    }
  } catch {
    // Unreadable: counted afresh.
  }
  return out;
}

export interface HomeEnv {
  screen: ScreenEnv;
  store: Store | null;
  /** Today, as localDate gives it. */
  today: () => string;
}

export class HomeScreen {
  /** Chrome's offer to install, kept until it is used; null where none came. */
  readonly prompt = signal<InstallPrompt | null>(null);
  /** The iPhone's steps, shown in the offer's place once Add Keel is tapped. */
  readonly steps = signal(false);
  /** Whether the start screen offers it now. */
  readonly offered: ReadonlySignal<boolean>;
  readonly #env: HomeEnv;
  readonly #kept = signal<Kept>({ days: 0, last: '', done: false });
  readonly #installed = signal(false);

  constructor(env: HomeEnv) {
    this.#env = env;
    this.#kept.value = read(env.store);
    this.#installed.value = installed(env.screen);
    const iphone = offer(env.screen).install === 'home-screen';
    this.offered = computed(() => {
      const k = this.#kept.value;
      return (
        !k.done &&
        !this.#installed.value &&
        (this.prompt.value !== null || iphone) &&
        this.day() >= OFFER_DAY
      );
    });
  }

  /** The day of play this is: those counted, and today if it is not yet. */
  day(): number {
    const k = this.#kept.value;
    return k.days + (k.last === this.#env.today() ? 0 : 1);
  }

  /** Set sail: today is counted, once. */
  sailed(): void {
    const k = this.#kept.value;
    const today = this.#env.today();
    if (k.last !== today) {
      this.#keep({ ...k, days: k.days + 1, last: today });
    }
  }

  /** Chrome offered to install: kept for Add Keel and the menu's key, its own banner held back. */
  saved(p: InstallPrompt): void {
    p.preventDefault();
    this.prompt.value = p;
  }

  /** Add Keel: Chrome asked to install; or the iPhone's steps shown. Either way, never offered again. */
  async add(): Promise<void> {
    const p = this.prompt.value;
    this.#keep({ ...this.#kept.value, done: true });
    if (p === null) {
      this.steps.value = true;
      return;
    }
    await this.install();
  }

  /** The menu's Install key, or Add Keel in Chrome: the browser's own question, once. */
  async install(): Promise<void> {
    const p = this.prompt.value;
    if (p === null) {
      return;
    }
    // A prompt answers once.
    this.prompt.value = null;
    try {
      await p.prompt();
      const { outcome } = await p.userChoice;
      if (outcome === 'accepted') {
        this.installedNow();
      }
    } catch {
      // Refused by the browser: nothing to do.
    }
  }

  /** Not now: never offered again. */
  notNow(): void {
    this.#keep({ ...this.#kept.value, done: true });
  }

  /** The game installed: nothing more to offer, here or in the menu. */
  installedNow(): void {
    this.#installed.value = true;
    this.prompt.value = null;
    this.#keep({ ...this.#kept.value, done: true });
  }

  #keep(k: Kept): void {
    this.#kept.value = k;
    try {
      this.#env.store?.setItem(KEY, JSON.stringify(k));
    } catch {
      // Storage refused: kept for this page only.
    }
  }
}

let shared: HomeScreen | null = null;

/**
 * The page's own, listening for Chrome's offer and the game installed from
 * its first call; none outside a browser.
 */
export function homeScreen(): HomeScreen | null {
  if (shared !== null || typeof window === 'undefined') {
    return shared;
  }
  let store: Store | null = null;
  try {
    store = localStorage;
  } catch {
    // Storage refused.
  }
  const h = new HomeScreen({ screen: browserEnv(), store, today: () => localDate(new Date()) });
  window.addEventListener('beforeinstallprompt', (e) => h.saved(e as unknown as InstallPrompt));
  window.addEventListener('appinstalled', () => h.installedNow());
  shared = h;
  return h;
}
