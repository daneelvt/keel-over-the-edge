// SPDX-License-Identifier: AGPL-3.0-only

// The screen at sea: the instrument panel top left (a heading-up compass
// card with the true wind's mark on its rim, the speed over ground, the
// heading, what the autopilot holds while it is on, and the wind), the sailor's state
// when they are out of the boat, the helm bottom left, the sheet bottom
// right, the autopilot's button between them, and the menu. Laid out
// within the safe area, in portrait and landscape.

import { ConnectionLine, type ConnectionView } from './connection';
import './hud.css';
import type { ReadonlySignal } from '@preact/signals';
import { render } from 'preact';
import { useState } from 'preact/hooks';
import type { HelmInput } from '../input/helm';
import type { PilotActions } from '../input/pilot';
import type { SheetInput } from '../input/sheet';
import { ChartScreen, type ChartSea, NoticeLine, PocketChart } from './chart';
import { Helm, Sheet } from './controls';
import { Menu } from './menu';
import type { HudModel } from './model';
import type { Notices } from './notices';
import { Pilot } from './pilot';
import type { SettingsSignal } from './settings';

const POINTS = ['N', 'E', 'S', 'W'];

function CompassCard({ model }: { model: HudModel }) {
  return (
    <svg class="compass" viewBox="-50 -50 100 100" aria-hidden="true">
      <circle class="compass-face" r="46" />
      <g ref={(el) => model.rose.attach(el)}>
        {Array.from({ length: 16 }, (_, i) => {
          const a = (i * Math.PI) / 8;
          const inner = i % 4 === 0 ? 34 : 38;
          return (
            <line
              key={`t${i}`}
              class="compass-tick"
              x1={inner * Math.sin(a)}
              y1={-inner * Math.cos(a)}
              x2={42 * Math.sin(a)}
              y2={-42 * Math.cos(a)}
            />
          );
        })}
        {POINTS.map((p, i) => {
          const a = (i * Math.PI) / 2;
          return (
            <text
              key={p}
              class={`compass-point${p === 'N' ? ' north' : ''}`}
              x={26 * Math.sin(a)}
              y={-26 * Math.cos(a)}
              transform={`rotate(${i * 90} ${26 * Math.sin(a)} ${-26 * Math.cos(a)})`}
            >
              {p}
            </text>
          );
        })}
      </g>
      <g ref={(el) => model.windMark.attach(el)}>
        <path
          class="compass-wind"
          d="M 0 -47 L 7 -58 L 0 -54 L -7 -58 Z"
          transform="translate(0 16)"
        />
      </g>
      <path class="compass-boat" d="M 0 -16 C 5 -8 6 4 4 14 L -4 14 C -6 4 -5 -8 0 -16 Z" />
    </svg>
  );
}

function Instruments({ model }: { model: HudModel }) {
  return (
    <section class="panel instruments" aria-label="Instruments">
      <CompassCard model={model} />
      <div class="readouts">
        <p class="speed">
          <span data-readout="speed">{model.speed}</span>
          <span class="unit">kn</span>
        </p>
        <p>
          Heading <b data-readout="heading">{model.heading}</b>
        </p>
        {model.pilot.value === '' ? null : (
          <p>
            Autopilot <b data-readout="pilot">{model.pilot}</b>
          </p>
        )}
        <p>
          Wind <b data-readout="wind">{model.wind}</b>
        </p>
        {model.tack.value === '' ? null : (
          <p>
            <b data-readout="tack">{model.tack}</b>
          </p>
        )}
      </div>
    </section>
  );
}

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
  /** The autopilot's button and dial. */
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
  const s = settings.value.value;
  const fly = props.fly ?? null;
  const sea = props.sea ?? null;
  const notices = props.notices ?? null;
  if (sea?.chart.open.value) {
    // The chart covers the screen; the boat sails on under it.
    return (
      <>
        <ChartScreen sea={sea} />
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
        <Instruments model={model} />
        <SailorLine model={model} />
        <BumpLine model={model} />
        {notices !== null ? <NoticeLine notices={notices} /> : null}
        {props.connection !== null ? <ConnectionLine view={props.connection} /> : null}
        {s.forcesOverlay ? <Clinometer model={model} /> : null}
      </div>
      {sea !== null ? <PocketChart sea={sea} /> : null}
      <button
        type="button"
        class="round menu-button"
        aria-label="Menu"
        aria-expanded={menu}
        onClick={() => setMenu(!menu)}
      >
        ☰
      </button>
      {menu ? (
        <Menu
          settings={settings}
          sailor={props.sailor}
          connection={props.connection}
          close={() => setMenu(false)}
          notices={notices}
          chart={
            sea === null
              ? null
              : (mode) => {
                  setMenu(false);
                  sea.chart.show(mode);
                }
          }
          fly={
            fly?.can.value === true
              ? () => {
                  setMenu(false);
                  fly.fly();
                }
              : null
          }
        />
      ) : null}
      <Helm input={props.helm} model={model} />
      <Pilot actions={props.pilot} model={model} />
      <Sheet input={props.sheet} model={model} />
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
