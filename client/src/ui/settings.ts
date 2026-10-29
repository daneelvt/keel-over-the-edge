// SPDX-License-Identifier: AGPL-3.0-only

// This device's settings: preferences, not progress. Losing them costs a
// tap, never anything in the game. They are kept in localStorage, read and
// written defensively, since a private window may refuse it; without it
// they last until the page closes.

import { signal } from '@preact/signals';

/** The orders the list of sailors to watch can be in, as the server names them. */
export const WATCH_SORTS = ['liveliest', 'watched', 'edge', 'weather', 'fast', 'name'] as const;
export type WatchSort = (typeof WATCH_SORTS)[number];

/** Whom the list of sailors to watch shows, as the server names them. */
export const WATCH_WHOS = ['all', 'following', 'machine', 'human'] as const;
export type WatchWho = (typeof WATCH_WHOS)[number];

export interface Settings {
  /** The most frames a second: 60, or 30 to save battery. */
  frameRate: 60 | 30;
  sound: boolean;
  /** The beginners' overlays. */
  windOverlay: boolean;
  forcesOverlay: boolean;
  /** Marks the boats to keep clear of, and those that must keep clear, by the Articles. */
  rightOfWay: boolean;
  /** Return the helm to the centre when the thumb lifts or the key comes up. */
  centreHelm: boolean;
  /** How much the sea is drawn with: as much as the device runs well, or the least, to save battery. */
  detail: 'auto' | 'low';
  /** The barometer out of the instruments' case. */
  barometer: boolean;
  /** The world clock out of the instruments' case. */
  worldClock: boolean;
  /** The autopilot's control head open, not folded to its button. */
  pilotHead: boolean;
  /** The pocket chart's weather: rain, fog and the systems over the disk. */
  pocketWeather: boolean;
  /** The list of sailors to watch: its order, and whom it shows. */
  watchSort: WatchSort;
  watchWho: WatchWho;
}

export const DEFAULTS: Settings = {
  frameRate: 60,
  sound: true,
  windOverlay: false,
  forcesOverlay: false,
  rightOfWay: false,
  centreHelm: false,
  detail: 'auto',
  barometer: false,
  worldClock: false,
  pilotHead: false,
  pocketWeather: true,
  watchSort: 'liveliest',
  watchWho: 'all',
};

const KEY = 'keel.settings';

/** What localStorage offers; tests stand in for it. */
export interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStore(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Reads the settings, keeping only values of the right kind. */
export function loadSettings(store: Store | null = defaultStore()): Settings {
  const out = { ...DEFAULTS };
  let raw: unknown = null;
  try {
    const text = store?.getItem(KEY) ?? null;
    raw = text === null ? null : JSON.parse(text);
  } catch {
    raw = null;
  }
  if (raw === null || typeof raw !== 'object') {
    return out;
  }
  const r = raw as Record<string, unknown>;
  if (r.frameRate === 60 || r.frameRate === 30) {
    out.frameRate = r.frameRate;
  }
  if (r.detail === 'auto' || r.detail === 'low') {
    out.detail = r.detail;
  }
  if (WATCH_SORTS.includes(r.watchSort as WatchSort)) {
    out.watchSort = r.watchSort as WatchSort;
  }
  if (WATCH_WHOS.includes(r.watchWho as WatchWho)) {
    out.watchWho = r.watchWho as WatchWho;
  }
  for (const k of [
    'sound',
    'windOverlay',
    'forcesOverlay',
    'rightOfWay',
    'centreHelm',
    'barometer',
    'worldClock',
    'pilotHead',
    'pocketWeather',
  ] as const) {
    if (typeof r[k] === 'boolean') {
      out[k] = r[k];
    }
  }
  return out;
}

/** Writes the settings; returns whether the store took them. */
export function saveSettings(s: Settings, store: Store | null = defaultStore()): boolean {
  try {
    if (store === null) {
      return false;
    }
    store.setItem(KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

/** The list of sailors to watch's own two settings, written to the store beside the others. */
export function saveWatchChoice(
  change: Partial<Pick<Settings, 'watchSort' | 'watchWho'>>,
  store: Store | null = defaultStore(),
): boolean {
  return saveSettings({ ...loadSettings(store), ...change }, store);
}

/**
 * The settings as a signal: the menu writes it, the game reads it. The
 * list of sailors to watch writes its two to the store alone, from screens
 * that have no signal, so they are taken from there before each write.
 */
export function settingsSignal(store: Store | null = defaultStore()) {
  const s = signal(loadSettings(store));
  return {
    value: s,
    set(change: Partial<Settings>): void {
      const { watchSort, watchWho } = loadSettings(store);
      s.value = { ...s.value, watchSort, watchWho, ...change };
      saveSettings(s.value, store);
    },
  };
}

export type SettingsSignal = ReturnType<typeof settingsSignal>;
