// SPDX-License-Identifier: AGPL-3.0-only

// The autopilot under the player's thumbs: a compact control head of the
// period at the bottom of the screen, between the helm and the sheet held
// sideways, above the helm held upright, never over the boat. Its first
// row steps what it holds, ten degrees and one either way, about a drum
// that shows what it holds ("Wind 45° S", "Heading 270°", "Tacking",
// "Tack stalled"), which a drag along turns, a degree for every few
// pixels; its second, the power and the mode as two-way levers, Tack,
// Gybe and the tab that folds it. Folded, it is one button saying what the
// autopilot holds: tapped while off it switches the autopilot on at the
// boat's angle to the wind and unfolds the head; tapped while on it
// unfolds it. Open or folded is kept on the device, so a head left open is
// open the next voyage; nothing else folds it, not a tap on the sea, not
// the helm, which takes the autopilot off and leaves the head showing it.

import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { angleOf, PILOT_HEADING, PILOT_WIND, type PilotActions } from '../input/pilot';
import { CompassDecal, Decal, FoldDecal, GybeDecal, TackDecal, WindDecal } from './decals';
import { compassPoint } from './format';
import type { HudModel } from './model';
import type { SettingsSignal } from './settings';

/** Pixels of drag along the drum for each degree it turns. */
export const DRUM_PIXELS = 6;

/** A step of the target: degrees of heading, positive to starboard. */
function Step({
  degrees,
  actions,
  redraw,
  on,
}: {
  degrees: number;
  actions: PilotActions;
  redraw: () => void;
  on: boolean;
}) {
  const n = Math.abs(degrees);
  const label = `${n === 1 ? 'One degree' : `${n} degrees`} to ${degrees < 0 ? 'port' : 'starboard'}`;
  return (
    <button
      type="button"
      class={`head-key step${n === 10 ? ' ten' : ''}`}
      aria-label={label}
      data-pilot-step={degrees}
      disabled={!on}
      onClick={() => {
        actions.pilotAdjust(degrees);
        redraw();
      }}
    >
      {degrees < 0 ? `◂${n}` : `${n}▸`}
    </button>
  );
}

/** The drum's pictogram: the boat and the wind's mark on a half-ring, or the compass point held. */
function Pictogram({ actions }: { actions: PilotActions }) {
  const p = actions.pilot;
  if (p.mode === PILOT_HEADING) {
    return (
      <span class="drum-point" aria-hidden="true">
        {compassPoint(p.degrees)}
      </span>
    );
  }
  // The wind's mark at the angle held, on the side it is over.
  const a = angleOf(p.target);
  return (
    <Decal class="drum-picture">
      <path class="decal-line thin" d={`M 0 -9 A 9 9 0 0 ${a < 0 ? 0 : 1} 0 9`} />
      <path class="decal-fill" d="M 0 -6 C 2.5 -3 3 2 2 6 L -2 6 C -3 2 -2.5 -3 0 -6 Z" />
      <circle class="decal-fill" cx={9 * Math.sin(a)} cy={-9 * Math.cos(a)} r="2.2" />
    </Decal>
  );
}

/** The drum: what the autopilot holds, turned by a drag along it. */
function Drum({
  actions,
  text,
  redraw,
}: {
  actions: PilotActions;
  text: string;
  redraw: () => void;
}) {
  const drag = useRef<{ id: number; x: number; turned: number } | null>(null);
  const on = actions.pilot.on;
  return (
    <div
      class={`drum${on ? '' : ' idle'}`}
      data-pilot="drum"
      role="img"
      aria-label={`Autopilot: ${text}`}
      onPointerDown={(e) => {
        if (!actions.pilot.on) {
          return;
        }
        drag.current = { id: e.pointerId, x: e.clientX, turned: 0 };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d === null || d.id !== e.pointerId) {
          return;
        }
        const want = Math.trunc((e.clientX - d.x) / DRUM_PIXELS);
        if (want !== d.turned) {
          actions.pilotAdjust(want - d.turned);
          d.turned = want;
          redraw();
        }
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    >
      {on ? <Pictogram actions={actions} /> : null}
      <span class="drum-window">
        <span key={text} class="drum-text" data-readout="pilot-drum">
          {text}
        </span>
      </span>
    </div>
  );
}

/**
 * A two-way lever: a tap on either half sets it there, a key or a tap
 * between them throws it over; pressed while at its second half.
 */
function Lever({
  name,
  id,
  halves,
  at,
  set,
}: {
  name: string;
  id: string;
  /** Each half: its hook, its engraved legend, and its symbol for a narrow head. */
  halves: [Half, Half];
  /** Which half it is at. */
  at: 0 | 1;
  set: (half: 0 | 1) => void;
}) {
  return (
    <button
      type="button"
      class={`lever at-${at}`}
      aria-label={name}
      aria-pressed={at === 1}
      data-pilot={id}
      onClick={(e) => {
        const half = (e.target as Element | null)
          ?.closest('[data-half]')
          ?.getAttribute('data-half');
        set(half === halves[0].id ? 0 : half === halves[1].id ? 1 : at === 0 ? 1 : 0);
      }}
    >
      {halves.map((h, i) => (
        <span
          key={h.id}
          class={`lever-half${at === i ? ' set' : ''}`}
          data-half={h.id}
          data-pilot={h.id}
        >
          <span class="legend">{h.text}</span>
          <span class="symbol">{h.symbol}</span>
        </span>
      ))}
    </button>
  );
}

interface Half {
  id: string;
  text: string;
  symbol: ComponentChildren;
}

function Head({
  actions,
  model,
  fold,
}: {
  actions: PilotActions;
  model: HudModel;
  fold: () => void;
}) {
  const p = actions.pilot;
  const on = p.on;
  // What the keys change shows at once, not at the next frame.
  const [, setDraws] = useState(0);
  const redraw = () => {
    model.flush();
    setDraws((n) => n + 1);
  };
  const state = model.pilot.value;
  return (
    <section class="panel pilot-head" aria-label="Autopilot" data-pilot="head">
      <div class="head-row">
        <Step degrees={-10} actions={actions} redraw={redraw} on={on} />
        <Step degrees={-1} actions={actions} redraw={redraw} on={on} />
        <Drum actions={actions} text={state === '' ? 'Off' : state} redraw={redraw} />
        <Step degrees={1} actions={actions} redraw={redraw} on={on} />
        <Step degrees={10} actions={actions} redraw={redraw} on={on} />
      </div>
      <div class="head-row">
        <Lever
          name="Autopilot"
          id="power"
          halves={[
            { id: 'off', text: 'Off', symbol: '0' },
            { id: 'on', text: 'On', symbol: 'I' },
          ]}
          at={on ? 1 : 0}
          set={(half) => {
            if (half === 0) {
              actions.takeHelm();
            } else if (!actions.pilot.on) {
              actions.togglePilot();
            }
            redraw();
          }}
        />
        <Lever
          name="Hold a heading"
          id="mode"
          halves={[
            { id: 'wind', text: 'Wind', symbol: <WindDecal /> },
            { id: 'compass', text: 'Compass', symbol: <CompassDecal /> },
          ]}
          at={p.mode === PILOT_HEADING ? 1 : 0}
          set={(half) => {
            const mode = half === 1 ? PILOT_HEADING : PILOT_WIND;
            if (actions.pilot.mode !== mode) {
              actions.engagePilot(mode);
            }
            redraw();
          }}
        />
        <button
          type="button"
          class="head-key turn"
          data-pilot="tack"
          aria-label="Tack"
          disabled={!on}
          onClick={() => {
            actions.pilotTack();
            redraw();
          }}
        >
          <span class="legend">Tack</span>
          <span class="symbol">
            <TackDecal />
          </span>
        </button>
        <button
          type="button"
          class="head-key turn"
          data-pilot="gybe"
          aria-label="Gybe"
          disabled={!on}
          onClick={() => {
            actions.pilotGybe();
            redraw();
          }}
        >
          <span class="legend">Gybe</span>
          <span class="symbol">
            <GybeDecal />
          </span>
        </button>
        <button
          type="button"
          class="head-key fold"
          data-pilot="fold"
          aria-label="Fold the autopilot"
          aria-expanded={true}
          onClick={fold}
        >
          <FoldDecal />
        </button>
      </div>
    </section>
  );
}

export function Pilot({
  actions,
  model,
  settings,
}: {
  actions: PilotActions;
  model: HudModel;
  settings: SettingsSignal;
}) {
  const open = settings.value.value.pilotHead;
  const setOpen = (pilotHead: boolean) => settings.set({ pilotHead });
  const state = model.pilot.value;
  if (open) {
    return <Head actions={actions} model={model} fold={() => setOpen(false)} />;
  }
  return (
    <button
      type="button"
      class={`pilot-button${actions.pilot.on ? ' on' : ''}`}
      aria-expanded={false}
      aria-label={`Autopilot: ${state === '' ? 'off' : state}`}
      data-pilot="button"
      onClick={() => {
        if (!actions.pilot.on) {
          actions.togglePilot();
          model.flush();
        }
        setOpen(true);
      }}
    >
      <span class="pilot-hinge" aria-hidden="true" />
      <span class="pilot-name">Autopilot</span>
      <span class="pilot-text" data-readout="pilot-button">
        {state === '' ? 'Off' : state}
      </span>
    </button>
  );
}
