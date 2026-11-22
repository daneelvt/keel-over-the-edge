// SPDX-License-Identifier: AGPL-3.0-only

// The menu: who is sailing, their account and machine sailors, and this
// device's settings. How light the night is drawn, first, the sea showing
// the change behind the menu as the slider moves; the frame rate (60, or 30
// to save battery), how much the sea is drawn with (as much as the device
// runs well, or the least), the sound (its switch, and how loud it all is,
// the sea and wind, and every other sound), the beginners' overlays, whether
// the helm returns to the centre when let go, and whether the camera comes
// back behind the boat by itself. The full screen where the
// page can take it, with how to install the game where that gives more of
// the screen, an Install key once the browser has offered to. Online, at
// the top with the other keys, the player's shipmates; Invite friends, the
// one page of links to share, for what is on the screen (to watch the
// player, alone or with a picture of the view, and, while their own boat
// is in the water, to sail with them; or, watching a machine sailor of
// theirs, to watch it and to sail with it); a sailor to watch; Back to Port Royal and Change boat, while the
// player sails their own boat, which ask first; Make a race, and the
// player's races ahead, each a tap from its card. It stands over everything at
// sea, within the screen held either way, its head and its close at the
// top while the rest scrolls; a tap beside it closes it.

import type { FullScreen } from '../boot/fullscreen';
import { type HomeScreen, homeScreen } from '../boot/homescreen';
import type { ChartMode } from '../chart/chart';
import { NoticeSwitches } from './chart';
import { type ConnectionView, RoundTrip } from './connection';
import type { Countdown } from './countdown';
import { type DeckView, machineShared } from './decklazy';
import { INVITE_FRIENDS, WHO_IS_ABOARD } from './deckwords';
import type { HomeView } from './home';
import { BACK_TO_PORT_ROYAL, CHANGE_BOAT } from './homewords';
import { INSTALL, INSTALL_CHROME, INSTALL_HOME_SCREEN } from './installwords';
import { Modal } from './modal';
import type { Notices } from './notices';
import { PlayerText } from './player';
import type { RacesView } from './raceslazy';
import { MAKE_A_RACE, whenLine } from './racewords';
import type { SettingsSignal } from './settings';
import { SHIPMATES } from './shipmatewords';
import { percentText, SEA_AND_WIND, SOUND, SOUNDS, VOLUME } from './soundwords';
import type { WatchView } from './watchlazy';
import { STOP_WATCHING, WATCH_A_SAILOR } from './watchwords';

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

/** A slider of the Sound block, as Night light's, its value shown as a percentage, applied as it moves. */
function SoundSlider({
  id,
  label,
  value,
  set,
}: {
  id: string;
  label: string;
  value: number;
  set: (v: number) => void;
}) {
  return (
    <div class="menu-range">
      <label for={id}>{label}</label>
      <div class="menu-range-row">
        <input
          id={id}
          type="range"
          name={id}
          min={0}
          max={1}
          step={0.05}
          value={value}
          aria-valuetext={percentText(value)}
          onInput={(e) => set(Number(e.currentTarget.value))}
        />
        <span class="menu-range-value" aria-hidden="true">
          {percentText(value)}
        </span>
      </div>
    </div>
  );
}

/** The sound: its switch, the mute, and how loud it all is, the sea and wind, and every other sound. */
function SoundBlock({ settings }: { settings: SettingsSignal }) {
  const s = settings.value.value;
  return (
    <fieldset class="menu-sound" aria-label={SOUND}>
      <Toggle name="sound" label={SOUND} on={s.sound} set={(sound) => settings.set({ sound })} />
      <SoundSlider
        id="volume"
        label={VOLUME}
        value={s.volume}
        set={(volume) => settings.set({ volume })}
      />
      <SoundSlider
        id="sea-volume"
        label={SEA_AND_WIND}
        value={s.seaVolume}
        set={(seaVolume) => settings.set({ seaVolume })}
      />
      <SoundSlider
        id="sounds-volume"
        label={SOUNDS}
        value={s.soundsVolume}
        set={(soundsVolume) => settings.set({ soundsVolume })}
      />
    </fieldset>
  );
}

/** Install, once the browser has offered to install the game: its own question. */
function InstallKey({ home }: { home: HomeScreen }) {
  return (
    <div class="menu-chart">
      <button type="button" onClick={() => void home.install()}>
        {INSTALL}
      </button>
    </div>
  );
}

/**
 * The full screen: the switch where the page can take it, and how to
 * install the game where that gives more, an Install key once the browser
 * has offered to; on an iPhone, which has no switch, the steps to the Home
 * Screen, folded under their row.
 */
function FullScreenRows({
  full,
  home = homeScreen(),
}: {
  full: FullScreen;
  home?: HomeScreen | null;
}) {
  const { offer } = full;
  const install = home?.prompt.value != null ? <InstallKey home={home} /> : null;
  if (offer.switch) {
    return (
      <>
        <Toggle name="full-screen" label="Full screen" on={full.on.value} set={full.turn} />
        {install ?? (offer.install === 'chrome' ? <p class="menu-note">{INSTALL_CHROME}</p> : null)}
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
  return install;
}

/** Make a race, and the player's own races ahead under it, each opening its card. */
function MenuRaces({ races, close }: { races: RacesView; close: () => void }) {
  const mine = races.board.value?.mine ?? [];
  const now = races.now();
  return (
    <div class="menu-races">
      <button
        type="button"
        class="menu-race"
        onClick={() => {
          races.make.value = true;
          close();
        }}
      >
        {MAKE_A_RACE}
      </button>
      {mine.slice(0, 3).map((r) => (
        <button
          type="button"
          key={r.code}
          class="menu-race menu-race-mine"
          data-race={r.code}
          onClick={() => {
            races.card.value = r.code;
            close();
          }}
        >
          <span class="menu-race-name">{r.name}</span>
          <span class="menu-race-when">{whenLine(r.startsAt, now)}</span>
        </button>
      ))}
    </div>
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
  invite = null,
  watch = null,
  deck = null,
  fullScreen = null,
  races = null,
  home = null,
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
  /** Opens Invite friends; null where there is no link to share. */
  invite?: (() => void) | null;
  /** Watching another sailor's boat; null in the offline sandbox. */
  watch?: WatchView | null;
  /** Sailing together; null in the offline sandbox. */
  deck?: DeckView | null;
  /** The full screen's switch; null where it is not run. */
  fullScreen?: FullScreen | null;
  /** Races ashore; null in the offline sandbox. */
  races?: RacesView | null;
  /** The way home; null in the offline sandbox. */
  home?: HomeView | null;
}) {
  const s = settings.value.value;
  return (
    <>
      {/* The focus in as it opens, and back to its button as it closes. */}
      <Modal of=".menu" close={close} back=".menu-button" />
      <div class="menu-scrim" aria-hidden="true" onClick={close} />
      <section
        class="panel menu"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
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
          {deck?.shipmates != null && sailor !== null ? (
            <div class="menu-chart">
              <button
                type="button"
                onClick={() => {
                  if (deck.shipmates !== null) {
                    deck.shipmates.panel.value = true;
                  }
                  close();
                }}
              >
                {SHIPMATES}
              </button>
            </div>
          ) : null}
          {invite !== null ? (
            <div class="menu-chart">
              <button type="button" onClick={invite}>
                {INVITE_FRIENDS}
              </button>
            </div>
          ) : null}
          {deck !== null && machineShared(deck) !== null && deck.crew.value !== null ? (
            <div class="menu-chart">
              <button
                type="button"
                onClick={() => {
                  deck.list.value = true;
                  close();
                }}
              >
                {WHO_IS_ABOARD}
              </button>
            </div>
          ) : null}
          {watch !== null && deck?.aboard.value == null ? (
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
          {home !== null && home.offered() ? (
            <div class="menu-chart">
              <button
                type="button"
                onClick={() => {
                  home.asking.value = true;
                  close();
                }}
              >
                {BACK_TO_PORT_ROYAL}
              </button>
            </div>
          ) : null}
          {home !== null && home.offered() ? (
            <div class="menu-chart">
              <button
                type="button"
                onClick={() => {
                  home.changing.value = true;
                  close();
                }}
              >
                {CHANGE_BOAT}
              </button>
            </div>
          ) : null}
          {races !== null ? <MenuRaces races={races} close={close} /> : null}
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
          <SoundBlock settings={settings} />
          <Toggle
            name="show-cheers"
            label="Show cheers in a race"
            on={s.showCheers}
            set={(showCheers) => settings.set({ showCheers })}
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
          <Toggle
            name="sea-motion"
            label="The sea moves the view"
            on={s.seaMotion}
            set={(seaMotion) => settings.set({ seaMotion })}
          />
          {notices !== null ? <NoticeSwitches notices={notices} /> : null}
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
