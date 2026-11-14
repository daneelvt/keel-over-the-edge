// SPDX-License-Identifier: AGPL-3.0-only

// The screen at sea: the instruments' case top left (the compass and its
// readouts, the barometer and the ship's clock sliding out of it), the sailor's state when they
// are out of the boat beneath it, the pocket chart top right with the time
// until a new world, the helm bottom left, the sheet bottom right, the
// autopilot's control head between them, and the keys in a column under
// the pocket chart (a row beside it on a short screen): the menu's button,
// Back to the boat, the clear view's, and the key that brings the full
// screen back. Laid out within the safe area, in portrait and landscape,
// no part over another or over the boat. Watching another sailor's boat,
// every control that acts is gone (the helm, the sheet, the autopilot,
// the free camera, taking the boat over): the instruments read the boat
// watched, and a plate where the controls were says whose it is. Aboard
// another's boat as crew, or the skipper while another aboard holds the
// controls, it is the same, a plate of sailing together in the watch
// plate's place; the knocks on the own boat stand under the case.
//
// The clear view hides every part but Back to the boat and its own key,
// which stay in their places, and shows each notice alone at the top as it
// comes. B brings the camera back to the boat; H clears the screen and
// brings it back.

import { ConnectionLine, type ConnectionView } from './connection';
import './hud.css';
import type { ReadonlySignal } from '@preact/signals';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { AccountPanel, MachinesPanel } from '../account/account';
import type { FullScreen } from '../boot/fullscreen';
import type { HelmInput } from '../input/helm';
import type { PilotActions } from '../input/pilot';
import type { SheetInput } from '../input/sheet';
import type { Barometer } from './barometer';
import type { DialWord } from './barometerdial';
import type { HarbourView } from './board';
import { Case, type Lamp } from './case';
import { ChartScreen, type ChartSea, NoticeLine, PocketChart } from './chart';
import type { ClearView } from './clearview';
import type { ShipsClock } from './clock';
import { Helm, Reef, type ReefActions, Sheet } from './controls';
import type { Countdown } from './countdown';
import { type DeckView, deckPlate, deckShown, useDeck } from './decklazy';
import { Menu } from './menu';
import type { HudModel } from './model';
import type { Notices } from './notices';
import { Pilot } from './pilot';
import { type RacesView, racesShown, useRaces } from './raceslazy';
import { type CameraKeys, SeaKeys } from './seakeys';
import type { SettingsSignal } from './settings';
import { type StatementsView, statementsShown, useStatements } from './statementlazy';
import { sailsOwn, useWatch, type WatchView } from './watchlazy';
import { watchersText } from './watchwords';

function BumpLine({ model }: { model: HudModel }) {
  const text = model.bump.value;
  return text === '' ? null : (
    <p class="panel bump-line" role="status" data-readout="bump">
      {text}
    </p>
  );
}

function SailorLine({ model }: { model: HudModel }) {
  const text = model.sailor.value;
  return text === '' ? null : (
    <p class="panel sailor-line" role="status" data-readout="sailor">
      {text}
    </p>
  );
}

/** How many watch the own boat, under the sailor's line, while any do. */
function WatchersLine({ watch }: { watch: WatchView }) {
  const text = watchersText(watch.watchers.value);
  return text === '' ? null : (
    <p class="panel watchers-line" data-readout="watchers">
      {text}
    </p>
  );
}

/** Whether any part of watching is on the screen. */
function watchShown(w: WatchView): boolean {
  return (
    w.spectating.value ||
    w.watching.value !== null ||
    w.place.value !== null ||
    w.status.value === 'idle' ||
    w.list.value
  );
}

/** The plate over a boat watched, at the foot of the screen; or the list, over the rest. */
function LazyWatch({ watch, part }: { watch: WatchView; part: 'plate' | 'list' }) {
  const shown = watchShown(watch);
  const m = useWatch(shown);
  if (m === null || !shown) {
    return null;
  }
  return part === 'plate' ? <m.WatchBar view={watch} /> : <m.SeaWatchList view={watch} />;
}

/** Sailing together's parts: under the case, at the foot of the screen, or its windows over the rest. */
function LazyDeck({
  deck,
  part,
  sailor,
}: {
  deck: DeckView;
  part: 'top' | 'chat' | 'foot' | 'windows';
  sailor: string | null;
}) {
  const shown = deckShown(deck);
  const m = useDeck(shown);
  if (m === null || !shown) {
    return null;
  }
  return part === 'top' ? (
    <m.DeckTop deck={deck} />
  ) : part === 'chat' ? (
    <m.DeckChat deck={deck} sailor={sailor} />
  ) : part === 'foot' ? (
    <m.DeckFoot deck={deck} />
  ) : (
    <m.DeckWindows deck={deck} sailor={sailor} />
  );
}

/** A statement of reasons from the game's owner: its line under the case, or its window. */
function LazyStatements({ view, part }: { view: StatementsView; part: 'line' | 'window' }) {
  const shown = statementsShown(view);
  const m = useStatements(shown);
  if (m === null || !shown) {
    return null;
  }
  return part === 'line' ? <m.StatementLine view={view} /> : <m.StatementWindow view={view} />;
}

/** Races ashore's windows: Make a race, a race's card, the share of one made; loaded when one opens. */
function LazyRaces({ races }: { races: RacesView }) {
  const shown = racesShown(races);
  const m = useRaces(shown);
  return m === null || !shown ? null : <m.RacesWindows view={races} />;
}

/** The controls that act on the boat: the helm, the autopilot and the sheet; none on a boat watched. */
export function SeaControls({
  steer,
  helm,
  sheet,
  pilot,
  reef,
  model,
  settings,
}: {
  steer: boolean;
  helm: HelmInput;
  sheet: SheetInput;
  pilot: PilotActions;
  reef?: ReefActions | null;
  model: HudModel;
  settings: SettingsSignal;
}) {
  if (!steer) {
    return null;
  }
  return (
    <>
      <Helm input={helm} model={model} />
      <Pilot actions={pilot} model={model} settings={settings} />
      <Sheet input={sheet} model={model} />
      {reef != null ? <Reef actions={reef} model={model} /> : null}
    </>
  );
}

function Clinometer({ model }: { model: HudModel }) {
  // A pendulum hung from the top, swinging against the heel as the boat leans.
  const at = (r: number, d: number): [number, number] => {
    const a = (d * Math.PI) / 180;
    return [r * Math.sin(a), r * Math.cos(a)];
  };
  const [ax, ay] = at(34, 60);
  return (
    <section class="panel clinometer" aria-label="Heel">
      <svg viewBox="-40 -4 80 44" aria-hidden="true">
        <path class="clino-scale" d={`M ${-ax} ${ay} A 34 34 0 0 0 ${ax} ${ay}`} />
        {[-60, -30, 0, 30, 60].map((d) => {
          const [x1, y1] = at(30, d);
          const [x2, y2] = at(36, d);
          return <line key={d} class="clino-tick" x1={x1} y1={y1} x2={x2} y2={y2} />;
        })}
        <g ref={(el) => model.clinometer.attach(el)}>
          <line class="clino-needle" x1="0" y1="0" x2="0" y2="32" />
        </g>
      </svg>
      <span class="control-label">Heel</span>
    </section>
  );
}

export interface ScreenProps {
  model: HudModel;
  settings: SettingsSignal;
  helm: HelmInput;
  sheet: SheetInput;
  /** The autopilot's control head. */
  pilot: PilotActions;
  /** The Reef key's: the main reefed to a level; none for no key. */
  reef?: ReefActions;
  /** The layer the overlays' labels go in. */
  labels: (el: HTMLElement | null) => void;
  /** The sailor's name, or null in the offline sandbox. */
  sailor: string | null;
  /** The game connection, or null in the offline sandbox. */
  connection: ConnectionView | null;
  /** The free camera, where it is offered, or null. */
  fly?: FlyView | null;
  /** The chart, its pocket and its news; null where there is no land. */
  sea?: ChartSea | null;
  /** The notices. */
  notices?: Notices | null;
  /** The countdown to the world's end; null in the offline sandbox. */
  end?: Countdown | null;
  /** The barometer and the words about its dial; null without. */
  barometer?: { barometer: Barometer; words: readonly DialWord[] } | null;
  /** The ship's clock, the world's time of day; null without. */
  clock?: ShipsClock | null;
  /** The harbourmaster's board, in port; null without. */
  harbour?: HarbourView | null;
  /** Watching another sailor's boat; null in the offline sandbox. */
  watch?: WatchView | null;
  /** Sailing together; null in the offline sandbox. */
  deck?: DeckView | null;
  /** The statements of reasons from the game's owner; null in the offline sandbox. */
  statements?: StatementsView | null;
  /** The running light of the own machine sailor's AI, while watching it; null in the offline sandbox. */
  lamp?: ReadonlySignal<Lamp> | null;
  /** The full screen's switch and key; null where it is not run. */
  fullScreen?: FullScreen | null;
  /** The camera, for Back to the boat; null without the key. */
  camera?: CameraKeys | null;
  /** The clear view; null without the key. */
  clear?: ClearView | null;
  /** Races ashore: Make a race in the menu, the cards; null in the offline sandbox. */
  races?: RacesView | null;
}

/** Whether a key press is the player's, not typing in a field. */
function typing(e: KeyboardEvent): boolean {
  const t = e.target;
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLSelectElement ||
    t instanceof HTMLTextAreaElement
  );
}

/** The free camera as the screen sees it. */
export interface FlyView {
  /** Whether it is offered: online, to an account with the owner's flag. */
  can: ReadonlySignal<boolean>;
  /** Whether it flies: the screen is clean. */
  flying: ReadonlySignal<boolean>;
  /** Whether the way back shows, a moment after a tap. */
  back: ReadonlySignal<boolean>;
  fly: () => void;
  land: () => void;
}

function Screen(props: ScreenProps) {
  const { model, settings } = props;
  const [menu, setMenu] = useState(false);
  const [account, setAccount] = useState<'' | 'account' | 'machines'>('');
  const s = settings.value.value;
  const fly = props.fly ?? null;
  const sea = props.sea ?? null;
  const notices = props.notices ?? null;
  const end = props.end ?? null;
  const watch = props.watch ?? null;
  const deck = props.deck ?? null;
  // Aboard without the controls, or the skipper while another holds
  // them: the plate of sailing together stands where the watch plate would.
  const decked = deck !== null && deckPlate(deck);
  const full = props.fullScreen ?? null;
  const camera = props.camera ?? null;
  const clear = props.clear ?? null;
  const cleared = clear?.on.value === true;
  const flying = fly?.flying.value === true;
  const charted = sea?.chart.open.value === true;
  // B: back to the boat; H: the clear view, and back.
  useEffect(() => {
    if (flying || charted) {
      return;
    }
    const key = (e: KeyboardEvent) => {
      if (typing(e) || e.repeat || e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }
      if (e.code === 'KeyB' && camera !== null) {
        camera.behind();
        e.preventDefault();
      } else if (e.code === 'KeyH' && clear !== null) {
        clear.toggle();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [flying, charted, camera, clear]);
  // Nothing steers a boat watched.
  const steer = watch === null || !watch.spectating.value;
  if (charted && sea !== null) {
    // The chart covers the screen; the boat sails on under it.
    // A sailor's log offers Watch where watching takes no boat out of the water.
    const fromLog =
      watch === null || sailsOwn(watch)
        ? null
        : (name: string) => {
            sea.chart.show(null);
            watch.watch(name);
          };
    return <ChartScreen sea={sea} end={end} notices={notices} watch={fromLog} />;
  }
  if (flying && fly !== null) {
    // The free camera's picture is clean; a tap shows the way back a moment.
    return (
      <button
        type="button"
        class={`panel fly-back${fly.back.value ? ' shown' : ''}`}
        tabIndex={fly.back.value ? 0 : -1}
        onClick={fly.land}
      >
        Back to the boat
      </button>
    );
  }
  // Cleared, every part stays laid out but unseen, so the two keys left
  // stand where they stood; the overlays' labels go with the overlays.
  return (
    <div class={`hud-screen${cleared ? ' clear' : ''}`}>
      {cleared ? null : <div class="overlay-labels" ref={props.labels} aria-hidden="true" />}
      <div class="hud-top">
        <Case
          model={model}
          settings={settings}
          controls={steer}
          barometer={props.barometer ?? null}
          clock={props.clock ?? null}
          harbour={props.harbour ?? null}
          lamp={props.lamp ?? null}
          clear={cleared}
        />
        <SailorLine model={model} />
        {watch !== null && steer ? <WatchersLine watch={watch} /> : null}
        <BumpLine model={model} />
        {notices !== null && !cleared ? <NoticeLine notices={notices} /> : null}
        {deck !== null ? <LazyDeck deck={deck} part="top" sailor={props.sailor} /> : null}
        {deck !== null ? <LazyDeck deck={deck} part="chat" sailor={props.sailor} /> : null}
        {props.statements != null ? <LazyStatements view={props.statements} part="line" /> : null}
        {props.connection !== null ? (
          <ConnectionLine view={props.connection} takeover={steer} />
        ) : null}
        {s.forcesOverlay ? <Clinometer model={model} /> : null}
      </div>
      {notices !== null && cleared ? (
        <div class="clear-notices">
          <NoticeLine notices={notices} />
        </div>
      ) : null}
      <div class="hud-right">
        {sea !== null ? (
          <PocketChart
            sea={sea}
            end={end}
            weather={s.pocketWeather}
            setWeather={(pocketWeather) => settings.set({ pocketWeather })}
          />
        ) : null}
        <SeaKeys
          menu={{
            open: menu,
            press: () => {
              if (!menu) {
                full?.menuOpened();
              }
              setMenu(!menu);
            },
          }}
          camera={camera}
          clear={clear}
          full={full?.key.value === true && !menu ? full.resume : null}
        />
      </div>
      {account === 'account' ? <AccountPanel close={() => setAccount('')} /> : null}
      {account === 'machines' ? <MachinesPanel close={() => setAccount('')} /> : null}
      {menu && account === '' ? (
        <Menu
          settings={settings}
          sailor={props.sailor}
          connection={props.connection}
          close={() => setMenu(false)}
          account={
            props.sailor === null
              ? null
              : () => {
                  setMenu(false);
                  setAccount('account');
                }
          }
          machines={
            props.sailor === null
              ? null
              : () => {
                  setMenu(false);
                  setAccount('machines');
                }
          }
          notices={notices}
          end={end}
          chart={
            sea === null
              ? null
              : (mode) => {
                  setMenu(false);
                  if (mode === 'news') {
                    sea.chart.showNews(null);
                  } else {
                    sea.chart.show(mode);
                  }
                }
          }
          fly={
            fly?.can.value === true && steer
              ? () => {
                  setMenu(false);
                  fly.fly();
                }
              : null
          }
          watch={watch}
          deck={deck}
          fullScreen={full}
          races={props.races ?? null}
        />
      ) : null}
      {watch !== null && !decked ? <LazyWatch watch={watch} part="plate" /> : null}
      {watch !== null ? <LazyWatch watch={watch} part="list" /> : null}
      {deck !== null ? <LazyDeck deck={deck} part="foot" sailor={props.sailor} /> : null}
      <SeaControls
        steer={steer}
        helm={props.helm}
        sheet={props.sheet}
        pilot={props.pilot}
        reef={props.reef ?? null}
        model={model}
        settings={settings}
      />
      {deck !== null ? <LazyDeck deck={deck} part="windows" sailor={props.sailor} /> : null}
      {props.statements?.open.value != null ? (
        <LazyStatements view={props.statements} part="window" />
      ) : null}
      {props.races != null ? <LazyRaces races={props.races} /> : null}
    </div>
  );
}

/** Draws the screen at sea into parent; the result takes it away. */
export function mountScreen(parent: HTMLElement, props: ScreenProps): () => void {
  const root = document.createElement('div');
  root.className = 'hud';
  parent.append(root);
  render(<Screen {...props} />, root);
  return () => {
    render(null, root);
    root.remove();
  };
}
