// SPDX-License-Identifier: AGPL-3.0-only

// This device's settings: preferences, not progress. Losing them costs a
// tap, never anything in the game. They are kept in localStorage, read and
// written defensively, since a private window may refuse it; without it
// they last until the page closes.

import { signal } from '@preact/signals';

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
  /** The barometer among the instruments. */
  barometer: boolean;
  /** The pocket chart's weather: rain, fog and the systems over the disk. */
  pocketWeather: boolean;
}

export const DEFAULTS: Settings = {
  frameRate: 60,
  sound: true,
  windOverlay: false,
  forcesOverlay: false,
  rightOfWay: false,
  centreHelm: false,
  detail: 'auto',
  barometer: true,
  pocketWeather: true,
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
  for (const k of [
    'sound',
    'windOverlay',
    'forcesOverlay',
    'rightOfWay',
    'centreHelm',
    'barometer',
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

/** The settings as a signal: the menu writes it, the game reads it. */
export function settingsSignal(store: Store | null = defaultStore()) {
  const s = signal(loadSettings(store));
  return {
    value: s,
    set(change: Partial<Settings>): void {
      s.value = { ...s.value, ...change };
      saveSettings(s.value, store);
    },
  };
}

export type SettingsSignal = ReturnType<typeof settingsSignal>;
