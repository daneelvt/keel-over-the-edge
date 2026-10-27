// SPDX-License-Identifier: AGPL-3.0-only

// The screen at sea: the instruments' case top left (the compass and its
// readouts, the barometer and the world clock sliding out of it), the
// sailor's state when they are out of the boat beneath it, the pocket
// chart top right, the helm bottom left, the sheet bottom right, the
// autopilot's control head between them, and the menu. Laid out within
// the safe area, in portrait and landscape, no part over another or over
// the boat. Watching another sailor's boat, every control that acts is
// gone (the helm, the sheet, the autopilot, the free camera, taking the
// boat over): the instruments read the boat watched, and the bar over it
// says whose it is.

import { ConnectionLine, type ConnectionView } from './connection';
import './hud.css';
import type { ReadonlySignal } from '@preact/signals';
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { AccountPanel, MachinesPanel } from '../account/account';
import type { HelmInput } from '../input/helm';
import type { PilotActions } from '../input/pilot';
import type { SheetInput } from '../input/sheet';
import type { Barometer } from './barometer';
import type { DialWord } from './barometerdial';
import type { HarbourView } from './board';
import { Case, type Lamp } from './case';
import { ChartScreen, type ChartSea, NoticeLine, PocketChart } from './chart';
import { Helm, Sheet } from './controls';
import type { Countdown } from './countdown';
import { Menu } from './menu';
import type { HudModel } from './model';
import type { Notices } from './notices';
import { Pilot } from './pilot';
import type { SettingsSignal } from './settings';
import { useWatch, type WatchView } from './watchlazy';
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

/** The bar over a boat watched, in the column at the top; or the button behind it and the list, over the rest. */
function LazyWatch({ watch, part }: { watch: WatchView; part: 'bar' | 'over' }) {
  const shown = watchShown(watch);
  const m = useWatch(shown);
  if (m === null || !shown) {
    return null;
  }
  if (part === 'bar') {
    return <m.WatchBar view={watch} />;
  }
  return (
    <>
      <m.BehindTheBoat view={watch} />
      <m.SeaWatchList view={watch} />
    </>
  );
}

/** The controls that act on the boat: the helm, the autopilot and the sheet; none on a boat watched. */
export function SeaControls({
  steer,
  helm,
  sheet,
  pilot,
  model,
  settings,
}: {
  steer: boolean;
  helm: HelmInput;
  sheet: SheetInput;
  pilot: PilotActions;
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
  /** The harbourmaster's board, in port; null without. */
  harbour?: HarbourView | null;
  /** Watching another sailor's boat; null in the offline sandbox. */
  watch?: WatchView | null;
  /** The running light of the own machine sailor's AI, while watching it; null in the offline sandbox. */
  lamp?: ReadonlySignal<Lamp> | null;
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
  // Nothing steers a boat watched.
  const steer = watch === null || !watch.spectating.value;
  if (sea?.chart.open.value) {
    // The chart covers the screen; the boat sails on under it.
    return (
      <>
        <ChartScreen sea={sea} end={end} />
        {notices !== null ? (
          <div class="hud-notices">
            <NoticeLine notices={notices} />
          </div>
        ) : null}
      </>
    );
  }
  if (fly?.flying.value === true) {
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
  return (
    <>
      <div class="overlay-labels" ref={props.labels} aria-hidden="true" />
      <div class="hud-top">
        {watch !== null ? <LazyWatch watch={watch} part="bar" /> : null}
        <Case
          model={model}
          settings={settings}
          end={end}
          barometer={props.barometer ?? null}
          harbour={props.harbour ?? null}
          lamp={props.lamp ?? null}
        />
        <SailorLine model={model} />
        {watch !== null && steer ? <WatchersLine watch={watch} /> : null}
        <BumpLine model={model} />
        {notices !== null ? <NoticeLine notices={notices} /> : null}
        {props.connection !== null ? (
          <ConnectionLine view={props.connection} takeover={steer} />
        ) : null}
        {s.forcesOverlay ? <Clinometer model={model} /> : null}
      </div>
      {sea !== null ? (
        <PocketChart
          sea={sea}
          end={end}
          weather={s.pocketWeather}
          setWeather={(pocketWeather) => settings.set({ pocketWeather })}
        />
      ) : null}
      <button
        type="button"
        class="round menu-button"
        aria-label="Menu"
        aria-expanded={menu}
        onClick={() => setMenu(!menu)}
      >
        ☰
      </button>
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
                  sea.chart.show(mode);
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
        />
      ) : null}
      {watch !== null ? <LazyWatch watch={watch} part="over" /> : null}
      <SeaControls
        steer={steer}
        helm={props.helm}
        sheet={props.sheet}
        pilot={props.pilot}
        model={model}
        settings={settings}
      />
    </>
  );
}

/** Draws the screen at sea into parent. */
export function mountScreen(parent: HTMLElement, props: ScreenProps): void {
  const root = document.createElement('div');
  root.className = 'hud';
  parent.append(root);
  render(<Screen {...props} />, root);
}
