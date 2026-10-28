// SPDX-License-Identifier: AGPL-3.0-only

// The menu: who is sailing, their account and machine sailors, and this
// device's settings. The frame rate (60, or 30 to save battery), how much
// the sea is drawn with (as much as the device runs well, or the least),
// sound, the beginners' overlays, and whether the helm returns to the
// centre when let go. Online, a sailor to watch, and who may watch the
// player's own boat.

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
}) {
  const s = settings.value.value;
  return (
    <section class="panel menu" aria-label="Settings">
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
      <h2>Settings</h2>
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
      <Toggle name="sound" label="Sound" on={s.sound} set={(sound) => settings.set({ sound })} />
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
    </section>
  );
}
