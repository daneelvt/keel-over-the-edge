// SPDX-License-Identifier: AGPL-3.0-only

// The menu: who is sailing, their account and machine sailors, and this
// device's settings. How light the night is drawn, first, the sea showing
// the change behind the menu as the slider moves; the frame rate (60, or 30
// to save battery), how much the sea is drawn with (as much as the device
// runs well, or the least), sound, the beginners' overlays, whether
// the helm returns to the centre when let go, and whether the camera comes
// back behind the boat by itself. The full screen where the
// page can take it, with how to install the game where that gives more of
// the screen. Online, a sailor to watch,
// and who may watch the player's own boat. It stands over everything at
// sea, within the screen held either way, its head and its close at the
// top while the rest scrolls; a tap beside it closes it.

import { useLayoutEffect } from 'preact/hooks';
import type { FullScreen } from '../boot/fullscreen';
import type { ChartMode } from '../chart/chart';
import { NoticeSwitches } from './chart';
import { type ConnectionView, RoundTrip } from './connection';
import type { Countdown } from './countdown';
import type { Notices } from './notices';
import { PlayerText } from './player';
import type { SettingsSignal } from './settings';
import { useWatch, type WatchView } from './watchlazy';
import { STOP_WATCHING, WATCH_A_SAILOR } from './watchwords';

/** "Allow spectators", once its module is loaded. */
function LazySpectators() {
  const m = useWatch();
  return m === null ? null : <m.SpectatorsChoice />;
}

function Toggle({
  label,
  on,
  set,
  name,
}: {
  label: string;
  on: boolean;
  set: (on: boolean) => void;
  name: string;
}) {
  return (
    <label class="menu-row">
      <span>{label}</span>
      <input
        type="checkbox"
        name={name}
        checked={on}
        onChange={(e) => set(e.currentTarget.checked)}
      />
    </label>
  );
}

/** Takes focus into the menu as it opens, and back to its button as it closes. */
function FocusIn() {
  useLayoutEffect(() => {
    document.querySelector<HTMLElement>('.menu')?.focus();
    return () => {
      // Unless the focus has gone elsewhere, as to a panel the menu opened.
      const a = document.activeElement;
      const b = document.querySelector<HTMLElement>('.menu-button');
      if (b !== null && (a === null || a === document.body || a.closest('.menu') !== null)) {
        b.focus();
      }
    };
  }, []);
  return null;
}

/** The night light's value in words, for a screen reader. */
export function nightLightText(v: number): string {
  if (v <= 0) {
    return 'Dark, the night as it is';
  }
  if (v >= 1) {
    return 'Light, as at dusk';
  }
  return `${Math.round(v * 100)}% lighter`;
}

/** How light the night is drawn: a slider from the night as it is to dusk's light, applied as it moves. */
function NightLight({ settings }: { settings: SettingsSignal }) {
  const v = settings.value.value.nightLight;
  return (
    <div class="menu-range">
      <label for="night-light">Night light</label>
      <div class="menu-range-row">
        <span aria-hidden="true">Dark</span>
        <input
          id="night-light"
          type="range"
          name="night-light"
          min={0}
          max={1}
          step={0.1}
          value={v}
          aria-valuetext={nightLightText(v)}
          onInput={(e) => settings.set({ nightLight: Number(e.currentTarget.value) })}
        />
        <span aria-hidden="true">Light</span>
      </div>
    </div>
  );
}

/** How to install the game from Chrome's menu on Android, where it then opens full screen every time. */
export const INSTALL_CHROME = 'Every time, without the bars: ⋮ → Add to home screen → Install.';

/** How to add the game to an iPhone's Home Screen, where it opens without Safari's bars. */
export const INSTALL_HOME_SCREEN =
  'Tap Share, then Add to Home Screen; keep Open as Web App on; open Keel from its icon. Your sailor comes with you; this phone’s settings start fresh.';

/**
 * The full screen: the switch where the page can take it, and how to
 * install the game where that gives more; on an iPhone, which has no
 * switch, the steps to the Home Screen, folded under their row.
 */
function FullScreenRows({ full }: { full: FullScreen }) {
  const { offer } = full;
  if (offer.switch) {
    return (
      <>
        <Toggle name="full-screen" label="Full screen" on={full.on.value} set={full.turn} />
        {offer.install === 'chrome' ? <p class="menu-note">{INSTALL_CHROME}</p> : null}
      </>
    );
  }
  if (offer.install === 'home-screen') {
    return (
      <details class="menu-steps">
        <summary class="menu-row">
          <span>Full screen</span>
          <span class="menu-steps-mark" aria-hidden="true">
            ›
          </span>
        </summary>
        <p class="menu-note">{INSTALL_HOME_SCREEN}</p>
      </details>
    );
  }
  return null;
}

/** "Sailing as" and the sailor's name; nothing in the offline sandbox. */
export function SailingAs({ sailor }: { sailor: string | null }) {
  return sailor === null ? null : (
    <p class="menu-sailor">
      Sailing as <PlayerText text={sailor} />
    </p>
  );
}

export function Menu({
  settings,
  sailor,
  connection = null,
  close,
  fly = null,
  notices = null,
  chart = null,
  end = null,
  account = null,
  machines = null,
  watch = null,
  fullScreen = null,
}: {
  settings: SettingsSignal;
  sailor: string | null;
  connection?: ConnectionView | null;
  close: () => void;
  /** Flies the free camera, where it is offered; null where it is not. */
  fly?: (() => void) | null;
  /** The notices, whose kinds are switched here. */
  notices?: Notices | null;
  /** Opens the chart, its list or the news; null where there is none. */
  chart?: ((mode: ChartMode) => void) | null;
  /** The countdown to the world's end; null where there is none. */
  end?: Countdown | null;
  /** Opens the account page; null in the offline sandbox. */
  account?: (() => void) | null;
  /** Opens the machine sailors' panel; null in the offline sandbox. */
  machines?: (() => void) | null;
  /** Watching another sailor's boat; null in the offline sandbox. */
  watch?: WatchView | null;
  /** The full screen's switch; null where it is not run. */
  fullScreen?: FullScreen | null;
}) {
  const s = settings.value.value;
  return (
    <>
      <FocusIn />
      <div class="menu-scrim" aria-hidden="true" onClick={close} />
      <section
        class="panel menu"
        role="dialog"
        aria-label="Settings"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            close();
          }
        }}
      >
        <header class="menu-head">
          <h2>Settings</h2>
          <button type="button" class="menu-x" aria-label="Close the menu" onClick={close}>
            ✕
          </button>
        </header>
        <div class="menu-body">
          <SailingAs sailor={sailor} />
          {account !== null || machines !== null ? (
            <div class="menu-accounts">
              {account !== null ? (
                <button type="button" onClick={account}>
                  Account
                </button>
              ) : null}
              {machines !== null ? (
                <button type="button" onClick={machines}>
                  Machine sailors
                </button>
              ) : null}
            </div>
          ) : null}
          {watch !== null ? (
            <div class="menu-chart">
              <button
                type="button"
                onClick={() => {
                  watch.list.value = true;
                  close();
                }}
              >
                {WATCH_A_SAILOR}
              </button>
              {watch.watching.value !== null ? (
                <button
                  type="button"
                  onClick={() => {
                    watch.unwatch();
                    close();
                  }}
                >
                  {STOP_WATCHING}
                </button>
              ) : null}
            </div>
          ) : null}
          {connection !== null ? <RoundTrip view={connection} /> : null}
          {end !== null && end.when.value !== '' ? (
            <p class="menu-end" data-readout="ends">
              The falls take this world on {end.when.value}
            </p>
          ) : null}
          {chart !== null ? (
            <div class="menu-chart">
              <button type="button" onClick={() => chart('chart')}>
                Chart
              </button>
              <button type="button" onClick={() => chart('news')}>
                News
              </button>
            </div>
          ) : null}
          <h3>On this device</h3>
          {fullScreen !== null ? <FullScreenRows full={fullScreen} /> : null}
          <NightLight settings={settings} />
          <Toggle
            name="battery"
            label="Save battery (30 frames a second)"
            on={s.frameRate === 30}
            set={(on) => settings.set({ frameRate: on ? 30 : 60 })}
          />
          <label class="menu-row">
            <span>Detail</span>
            <select
              name="detail"
              value={s.detail}
              onChange={(e) =>
                settings.set({ detail: e.currentTarget.value === 'low' ? 'low' : 'auto' })
              }
            >
              <option value="auto">Automatic</option>
              <option value="low">Low</option>
            </select>
          </label>
          <Toggle
            name="sound"
            label="Sound"
            on={s.sound}
            set={(sound) => settings.set({ sound })}
          />
          <Toggle
            name="wind-overlay"
            label="Show the wind"
            on={s.windOverlay}
            set={(windOverlay) => settings.set({ windOverlay })}
          />
          <Toggle
            name="forces-overlay"
            label="Show the sail’s forces"
            on={s.forcesOverlay}
            set={(forcesOverlay) => settings.set({ forcesOverlay })}
          />
          <Toggle
            name="right-of-way"
            label="Show right of way"
            on={s.rightOfWay}
            set={(rightOfWay) => settings.set({ rightOfWay })}
          />
          <Toggle
            name="centre-helm"
            label="Centre the helm when let go"
            on={s.centreHelm}
            set={(centreHelm) => settings.set({ centreHelm })}
          />
          <Toggle
            name="camera-back"
            label="Bring the camera back behind the boat"
            on={s.cameraBack}
            set={(cameraBack) => settings.set({ cameraBack })}
          />
          {notices !== null ? <NoticeSwitches notices={notices} /> : null}
          {watch !== null ? <LazySpectators /> : null}
          {fly !== null ? (
            <button type="button" class="menu-fly" onClick={fly}>
              Free camera (F)
            </button>
          ) : null}
          <button type="button" class="menu-close" onClick={close}>
            Close
          </button>
        </div>
      </section>
    </>
  );
}
