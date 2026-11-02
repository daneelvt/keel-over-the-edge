// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { type Store, settingsSignal } from '../ui/settings';
import {
  enter,
  fullScreen,
  offer,
  type ScreenDoc,
  type ScreenEnv,
  sailFullScreen,
} from './fullscreen';

const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36';
const SAMSUNG =
  'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36';
const WEBVIEW =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const INSTAGRAM_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 360.0.0.30.109';
const IPAD =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15';
const DESKTOP_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

/** A document that goes full screen when asked, unless told to refuse, and says so as a browser does. */
class FakeDoc implements ScreenDoc {
  fullscreenEnabled = true;
  webkitFullscreenEnabled?: boolean;
  fullscreenElement: Element | null = null;
  visibilityState: DocumentVisibilityState = 'visible';
  asked: (FullscreenOptions | undefined)[] = [];
  refuse = false;
  private listeners = new Map<string, (() => void)[]>();
  readonly documentElement = {
    requestFullscreen: async (options?: FullscreenOptions) => {
      this.asked.push(options);
      if (this.refuse) {
        throw new TypeError('Permissions check failed');
      }
      this.fullscreenElement = {} as Element;
      this.fire('fullscreenchange');
    },
  };
  exitFullscreen = async () => {
    this.leave();
  };
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string) {
    for (const l of this.listeners.get(type) ?? []) {
      l();
    }
  }
  /** The full screen ends, as by back or by the browser. */
  leave() {
    this.fullscreenElement = null;
    this.fire('fullscreenchange');
  }
  /** The page out of sight, or back. */
  show(state: DocumentVisibilityState) {
    this.visibilityState = state;
    this.fire('visibilitychange');
  }
}

function env(doc: ScreenDoc, over: Partial<Omit<ScreenEnv, 'doc'>> = {}): ScreenEnv {
  return { doc, matches: () => false, standalone: undefined, userAgent: CHROME_ANDROID, ...over };
}

function memory(): Store {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const settled = () => new Promise((r) => setTimeout(r, 0));

describe('what the menu offers', () => {
  const iphone = (prefixed = false) => {
    const doc = new FakeDoc();
    doc.fullscreenEnabled = false;
    if (prefixed) {
      doc.webkitFullscreenEnabled = true;
    }
    return doc;
  };

  test('Chrome on Android: the switch, and how to install from its menu', () => {
    expect(offer(env(new FakeDoc()))).toEqual({ switch: true, install: 'chrome' });
  });

  test('another browser on Android, or a computer: the switch alone', () => {
    expect(offer(env(new FakeDoc(), { userAgent: SAMSUNG }))).toEqual({
      switch: true,
      install: null,
    });
    expect(offer(env(new FakeDoc(), { userAgent: DESKTOP_CHROME }))).toEqual({
      switch: true,
      install: null,
    });
  });

  test('Safari on an iPhone: no switch, the steps to the Home Screen', () => {
    expect(offer(env(iphone(), { userAgent: SAFARI_IPHONE, standalone: false }))).toEqual({
      switch: false,
      install: 'home-screen',
    });
  });

  test('an iPad, its full screen prefixed: the switch', () => {
    const doc = iphone(true);
    expect(offer(env(doc, { userAgent: IPAD, standalone: false }))).toEqual({
      switch: true,
      install: null,
    });
  });

  test('installed, on Android or the Home Screen: nothing', () => {
    expect(
      offer(env(new FakeDoc(), { matches: (q) => q === '(display-mode: fullscreen)' })),
    ).toEqual({ switch: false, install: null });
    expect(
      offer(env(new FakeDoc(), { matches: (q) => q === '(display-mode: standalone)' })),
    ).toEqual({ switch: false, install: null });
    expect(offer(env(iphone(), { userAgent: SAFARI_IPHONE, standalone: true }))).toEqual({
      switch: false,
      install: null,
    });
  });

  test('a page full screen by the switch is not taken for one installed', () => {
    const doc = new FakeDoc();
    doc.fullscreenElement = {} as Element;
    expect(offer(env(doc, { matches: (q) => q === '(display-mode: fullscreen)' }))).toEqual({
      switch: true,
      install: 'chrome',
    });
  });

  test('an app’s own browser: no steps, the switch only where it can', () => {
    expect(offer(env(new FakeDoc(), { userAgent: WEBVIEW }))).toEqual({
      switch: true,
      install: null,
    });
    expect(offer(env(iphone(), { userAgent: INSTAGRAM_IPHONE, standalone: false }))).toEqual({
      switch: false,
      install: null,
    });
  });
});

describe('the full screen', () => {
  test('is asked for with the navigation bar hidden; a refusal is no fault', async () => {
    const doc = new FakeDoc();
    expect(await enter(doc)).toBe(true);
    expect(doc.asked).toEqual([{ navigationUI: 'hide' }]);
    doc.fullscreenElement = null;
    doc.refuse = true;
    expect(await enter(doc)).toBe(false);
  });

  test('is asked for the prefixed way where that is the only way', async () => {
    let asked = 0;
    const doc = (documentElement: ScreenDoc['documentElement']): ScreenDoc => ({
      visibilityState: 'visible',
      documentElement,
      addEventListener: () => {},
    });
    expect(await enter(doc({ webkitRequestFullscreen: () => void asked++ }))).toBe(true);
    expect(asked).toBe(1);
    expect(await enter(doc({}))).toBe(false);
  });

  test('the switch enters it and keeps the choice; off leaves it', async () => {
    const doc = new FakeDoc();
    const store = memory();
    const settings = settingsSignal(store);
    const full = fullScreen(env(doc), settings);
    expect(full.on.value).toBe(false);
    full.turn(true);
    await settled();
    expect(full.active.value).toBe(true);
    expect(full.on.value).toBe(true);
    expect(settingsSignal(store).value.value.fullScreen).toBe(true);
    full.turn(false);
    await settled();
    expect(full.active.value).toBe(false);
    expect(settings.value.value.fullScreen).toBe(false);
    expect(full.key.value).toBe(false);
  });

  test('a switch the browser refuses shows off', async () => {
    const doc = new FakeDoc();
    doc.refuse = true;
    const settings = settingsSignal(memory());
    const full = fullScreen(env(doc), settings);
    full.turn(true);
    expect(full.on.value).toBe(true);
    await settled();
    expect(full.on.value).toBe(false);
    expect(settings.value.value.fullScreen).toBe(false);
    expect(full.key.value).toBe(false);
  });

  test('left while in sight, as by back, turns the switch off', async () => {
    const doc = new FakeDoc();
    const settings = settingsSignal(memory());
    const full = fullScreen(env(doc), settings);
    full.turn(true);
    await settled();
    doc.leave();
    expect(full.active.value).toBe(false);
    expect(settings.value.value.fullScreen).toBe(false);
    expect(full.key.value).toBe(false);
  });

  test('left as another app comes up keeps the switch and shows the key, whichever is heard first', async () => {
    for (const order of ['hidden first', 'left first, once back'] as const) {
      const doc = new FakeDoc();
      const settings = settingsSignal(memory());
      const full = fullScreen(env(doc), settings);
      full.turn(true);
      await settled();
      if (order === 'hidden first') {
        doc.show('hidden');
        doc.leave();
        doc.show('visible');
      } else {
        // The page hidden, then heard of the full screen's end only once back.
        doc.show('hidden');
        doc.show('visible');
        doc.leave();
      }
      expect(settings.value.value.fullScreen, order).toBe(true);
      expect(full.key.value, order).toBe(true);
      expect(full.on.value, order).toBe(false);
      // The key's tap brings it back, and puts the key away.
      full.resume();
      await settled();
      expect(full.active.value, order).toBe(true);
      expect(full.key.value, order).toBe(false);
      // Back is the player's again.
      doc.leave();
      expect(settings.value.value.fullScreen, order).toBe(false);
    }
  });

  test('the menu opened puts the key away; the switch then shows off, to be turned on', async () => {
    const doc = new FakeDoc();
    const settings = settingsSignal(memory());
    const full = fullScreen(env(doc), settings);
    full.turn(true);
    await settled();
    doc.show('hidden');
    doc.leave();
    doc.show('visible');
    expect(full.key.value).toBe(true);
    full.menuOpened();
    expect(full.key.value).toBe(false);
    expect(full.on.value).toBe(false);
    expect(settings.value.value.fullScreen).toBe(true);
    full.turn(true);
    await settled();
    expect(full.active.value).toBe(true);
  });

  test('a page at sea with the switch on, not yet full screen, offers the key', async () => {
    const store = memory();
    settingsSignal(store).set({ fullScreen: true });
    const doc = new FakeDoc();
    const full = fullScreen(env(doc), settingsSignal(store));
    expect(full.key.value).toBe(true);
    // Set sail's own request, heard a moment later, puts it away.
    await enter(doc);
    expect(full.key.value).toBe(false);
  });

  test('with no switch to offer, no key', () => {
    const store = memory();
    settingsSignal(store).set({ fullScreen: true });
    const doc = new FakeDoc();
    doc.fullscreenEnabled = false;
    const full = fullScreen(env(doc, { standalone: false }), settingsSignal(store));
    expect(full.key.value).toBe(false);
  });
});

describe('Set sail', () => {
  test('enters the full screen when the switch is on, and only then', () => {
    const store = memory();
    const doc = new FakeDoc();
    sailFullScreen(env(doc), store);
    expect(doc.asked).toEqual([]);
    settingsSignal(store).set({ fullScreen: true });
    sailFullScreen(env(doc), store);
    expect(doc.asked).toEqual([{ navigationUI: 'hide' }]);
  });

  test('installed, it is full screen already, and asks for nothing', () => {
    const store = memory();
    settingsSignal(store).set({ fullScreen: true });
    const doc = new FakeDoc();
    sailFullScreen(env(doc, { matches: () => true }), store);
    expect(doc.asked).toEqual([]);
  });
});
