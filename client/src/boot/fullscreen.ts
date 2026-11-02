// SPDX-License-Identifier: AGPL-3.0-only

// The whole screen. A page in Chrome on Android may take it, hiding the
// address bar, the status bar and the navigation bar, but only on a tap:
// the menu's switch, Set sail with the switch on, or the key shown after
// the phone has been away. The switch is kept with the device's other
// settings. How the full screen ends decides it: left while the page is in
// sight (back, or the bars swiped in and closed) is the player's choice
// and turns the switch off; left while the page is out of sight (another
// app, the screen locked) keeps it, and the key shows until it is tapped
// or the menu opens. Nothing else enters the full screen: a tap on the sea
// or a control that did would resize the screen under the finger.
//
// A page on an iPhone cannot take the whole screen; added to the Home
// Screen it opens as an app without Safari's bars, and the menu says how.
// Installed, on either, there is nothing to offer.

import { computed, type ReadonlySignal, type Signal, signal } from '@preact/signals';
import { inAppBrowser } from '../account/inapp';
import { loadSettings, type SettingsSignal, type Store } from '../ui/settings';

/** The document as the full screen reads and asks it, so tests can stand in for it. */
export interface ScreenDoc {
  fullscreenEnabled?: boolean;
  /** iPadOS's Safari, which names it so. */
  webkitFullscreenEnabled?: boolean;
  fullscreenElement?: Element | null;
  webkitFullscreenElement?: Element | null;
  visibilityState: DocumentVisibilityState;
  documentElement: {
    requestFullscreen?: (options?: FullscreenOptions) => Promise<void>;
    webkitRequestFullscreen?: () => void;
  };
  exitFullscreen?: () => Promise<void>;
  webkitExitFullscreen?: () => void;
  addEventListener(type: string, listener: () => void): void;
}

/** The page and the browser around it. */
export interface ScreenEnv {
  doc: ScreenDoc;
  /** Whether a media query matches. */
  matches(query: string): boolean;
  /** An iPhone's or iPad's navigator.standalone: true in a Home Screen app, false in the browser, undefined elsewhere. */
  standalone: boolean | undefined;
  userAgent: string;
}

export function browserEnv(): ScreenEnv {
  return {
    doc: document,
    matches: (q) => globalThis.matchMedia?.(q).matches ?? false,
    standalone: (navigator as { standalone?: boolean }).standalone,
    userAgent: navigator.userAgent,
  };
}

/** What the menu offers for more of the screen. */
export interface Offer {
  /** The switch: the page can take the whole screen. */
  switch: boolean;
  /** How to install the game, where that gives more: from Chrome's menu on Android, to the Home Screen on an iPhone. */
  install: 'chrome' | 'home-screen' | null;
}

export function canFullScreen(doc: ScreenDoc): boolean {
  return doc.fullscreenEnabled === true || doc.webkitFullscreenEnabled === true;
}

function fullElement(doc: ScreenDoc): Element | null {
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/**
 * Whether the game runs installed: opened from its icon on Android, or from
 * the Home Screen on an iPhone. A page full screen by the switch may match
 * the full screen display mode too, so it is not asked then.
 */
export function installed(env: ScreenEnv): boolean {
  return (
    env.standalone === true ||
    (fullElement(env.doc) === null &&
      (env.matches('(display-mode: fullscreen)') || env.matches('(display-mode: standalone)')))
  );
}

/** Chrome on Android, whose own menu installs the game: not another browser built on it, nor an app's webview. */
function androidChrome(ua: string): boolean {
  return (
    ua.includes('Android') &&
    /Chrome\/\d/.test(ua) &&
    !/; wv\)|SamsungBrowser|EdgA\/|OPR\/|YaBrowser|UCBrowser|MiuiBrowser|HuaweiBrowser/.test(ua)
  );
}

export function offer(env: ScreenEnv): Offer {
  if (installed(env)) {
    return { switch: false, install: null };
  }
  const can = canFullScreen(env.doc);
  if (inAppBrowser(env.userAgent) !== null) {
    return { switch: can, install: null };
  }
  if (can) {
    return { switch: true, install: androidChrome(env.userAgent) ? 'chrome' : null };
  }
  // An iPhone's browser: no full screen, but the Home Screen.
  return { switch: false, install: env.standalone === false ? 'home-screen' : null };
}

/**
 * Asks for the whole screen, with the browser's bars and the phone's
 * hidden; called in a tap's handler, which the browser requires. Whether
 * it was given; a refusal is no fault.
 */
export async function enter(doc: ScreenDoc): Promise<boolean> {
  const el = doc.documentElement;
  try {
    if (el.requestFullscreen !== undefined) {
      await el.requestFullscreen({ navigationUI: 'hide' });
    } else if (el.webkitRequestFullscreen !== undefined) {
      el.webkitRequestFullscreen();
    } else {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function leave(doc: ScreenDoc): Promise<void> {
  if (fullElement(doc) === null) {
    return;
  }
  try {
    if (doc.exitFullscreen !== undefined) {
      await doc.exitFullscreen();
    } else {
      doc.webkitExitFullscreen?.();
    }
  } catch {
    // Left already.
  }
}

/** Set sail's tap: the whole screen, when the switch is on. */
export function sailFullScreen(env?: ScreenEnv, store?: Store | null): void {
  if (!loadSettings(store).fullScreen) {
    return;
  }
  const e = env ?? browserEnv();
  if (offer(e).switch) {
    void enter(e.doc);
  }
}

/** The full screen at sea: the menu's switch, and the key that brings it back. */
export interface FullScreen {
  offer: Offer;
  /** Whether the page has the whole screen. */
  active: ReadonlySignal<boolean>;
  /** What the switch shows: on, and the screen whole or being asked for. */
  on: ReadonlySignal<boolean>;
  /** Whether the key shows: the switch on, and the full screen lost while the page was out of sight. */
  key: Signal<boolean>;
  /** The menu's switch: on enters the full screen, off leaves it. */
  turn(on: boolean): void;
  /** The key's tap. */
  resume(): void;
  /** The menu opened: the key is put away. */
  menuOpened(): void;
}

export function fullScreen(env: ScreenEnv, settings: SettingsSignal): FullScreen {
  const { doc } = env;
  const o = offer(env);
  const setting = () => o.switch && settings.value.value.fullScreen;
  const active = signal(fullElement(doc) !== null);
  const asking = signal(false);
  // A page loaded with the switch on but not full screen, or whose Set
  // sail was refused, offers the key.
  const key = signal(setting() && !active.value);
  // Whether the page went out of sight while full screen. A phone leaves
  // the full screen as another app comes up, and the page may hear of it
  // only once it is back in sight; so this holds until the full screen next
  // ends or begins.
  let away = false;

  const ask = (): void => {
    asking.value = true;
    void enter(doc).then((ok) => {
      asking.value = false;
      if (!ok && fullElement(doc) === null) {
        key.value = false;
        settings.set({ fullScreen: false });
      }
    });
  };

  const changed = () => {
    const now = fullElement(doc) !== null;
    if (now === active.value) {
      return;
    }
    active.value = now;
    if (now) {
      away = false;
      key.value = false;
      return;
    }
    if (away || doc.visibilityState === 'hidden') {
      key.value = setting();
    } else if (settings.value.value.fullScreen) {
      settings.set({ fullScreen: false });
    }
    away = false;
  };
  doc.addEventListener('fullscreenchange', changed);
  doc.addEventListener('webkitfullscreenchange', changed);
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'hidden' && active.value) {
      away = true;
    }
  });

  return {
    offer: o,
    active,
    on: computed(() => settings.value.value.fullScreen && (active.value || asking.value)),
    key,
    turn(on) {
      key.value = false;
      settings.set({ fullScreen: on });
      if (on) {
        ask();
      } else {
        void leave(doc);
      }
    },
    resume() {
      key.value = false;
      ask();
    },
    menuOpened() {
      key.value = false;
    },
  };
}
