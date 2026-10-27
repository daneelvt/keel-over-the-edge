// SPDX-License-Identifier: AGPL-3.0-only

// The autopilot under the player's thumb: one button between the helm and
// the sheet, saying what it holds ("Off", "Wind 45° S", "Heading 270°",
// "Tacking", "Tack stalled"). Tapped while off it switches the autopilot on
// at the boat's angle to the wind and opens the dial; tapped while on it
// opens or closes the dial. The dial is a half-ring of the angle off the wind on the boat's
// side, or a compass rose, with the target's mark, which a drag along the
// ring moves; steps of a degree and of ten either way; Tack, Gybe, the other
// mode, and Off. A tap anywhere else closes the dial and leaves the
// autopilot on; touching the helm takes the helm back.

import { useEffect, useRef, useState } from 'preact/hooks';
import { angleOf, PILOT_HEADING, PILOT_WIND, type PilotActions, stepsOf } from '../input/pilot';
import type { HudModel } from './model';

const R = 40;

/**
 * The target's mark on the dial: (x, y) on its ring, north up on the rose;
 * on the half-ring head to wind up, and the wind over starboard on the
 * right, as on a wind instrument with the bow up.
 */
function markAt(target: number): [number, number] {
  const a = angleOf(target);
  return [R * Math.sin(a), -R * Math.cos(a)];
}

function Ring({ actions, redraw }: { actions: PilotActions; redraw: () => void }) {
  const p = actions.pilot;
  const wind = p.mode === PILOT_WIND;
  const side = wind && angleOf(p.target) < 0 ? -1 : 1;
  const [mx, my] = markAt(p.target);
  const drag = useRef<number | null>(null);
  const at = (e: PointerEvent, el: SVGSVGElement): void => {
    const r = el.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const theta = Math.atan2(dx, -dy);
    if (p.mode === PILOT_HEADING) {
      p.target = stepsOf(theta);
    } else {
      // Along the half-ring on the boat's side: the angle from head to wind.
      const now = angleOf(p.target);
      p.target = stepsOf((now < 0 ? -1 : 1) * Math.abs(theta));
      p.adjust(0);
    }
    redraw();
  };
  // The half-ring of the wind's side, or the whole rose.
  const arc = wind
    ? `M 0 ${-R} A ${R} ${R} 0 0 ${side > 0 ? 1 : 0} 0 ${R}`
    : `M 0 ${-R} A ${R} ${R} 0 1 1 0 ${R} A ${R} ${R} 0 1 1 0 ${-R}`;
  return (
    <svg
      class="pilot-ring"
      viewBox="-56 -56 112 112"
      role="img"
      aria-label={wind ? 'Angle off the wind' : 'Compass heading'}
      data-pilot="ring"
      onPointerDown={(e) => {
        drag.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
        at(e, e.currentTarget);
      }}
      onPointerMove={(e) => {
        if (drag.current === e.pointerId) {
          at(e, e.currentTarget);
        }
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    >
      <path class="pilot-track" d={arc} />
      {wind ? (
        <>
          <text class="pilot-tick" x={0} y={-R - 6}>
            Wind
          </text>
          <path class="pilot-boat" d="M 0 -14 C 4 -7 5 3 3 12 L -3 12 C -5 3 -4 -7 0 -14 Z" />
        </>
      ) : (
        ['N', 'E', 'S', 'W'].map((n, i) => {
          const a = (i * Math.PI) / 2;
          return (
            <text
              key={n}
              class="pilot-tick"
              x={(R + 10) * Math.sin(a)}
              y={-(R + 10) * Math.cos(a) + 4}
            >
              {n}
            </text>
          );
        })
      )}
      <line class="pilot-needle" x1={0} y1={0} x2={mx} y2={my} />
      <circle class="pilot-mark" cx={mx} cy={my} r={7} />
    </svg>
  );
}

/** A step of the target: degrees of heading, positive to starboard. */
function Step({
  degrees,
  actions,
  redraw,
}: {
  degrees: number;
  actions: PilotActions;
  redraw: () => void;
}) {
  const n = Math.abs(degrees);
  const label = `${n === 1 ? 'One degree' : `${n} degrees`} to ${degrees < 0 ? 'port' : 'starboard'}`;
  return (
    <button
      type="button"
      class="pilot-step"
      aria-label={label}
      data-pilot-step={degrees}
      onClick={() => {
        actions.pilotAdjust(degrees);
        redraw();
      }}
    >
      {degrees < 0 ? `◂ ${n}°` : `${n}° ▸`}
    </button>
  );
}

function Dial({
  actions,
  model,
  close,
}: {
  actions: PilotActions;
  model: HudModel;
  close: () => void;
}) {
  const [, setDraws] = useState(0);
  const redraw = () => {
    model.flush();
    setDraws((n) => n + 1);
  };
  const p = actions.pilot;
  const state = model.pilot.value;
  return (
    <section class="panel pilot-dial" aria-label="Autopilot" data-pilot="dial">
      <p class="pilot-state">
        Autopilot <b data-readout="pilot-dial">{state === '' ? 'Off' : state}</b>
      </p>
      <Ring actions={actions} redraw={redraw} />
      <div class="pilot-row">
        {[-10, -1, 1, 10].map((d) => (
          <Step key={d} degrees={d} actions={actions} redraw={redraw} />
        ))}
      </div>
      <div class="pilot-row">
        <button
          type="button"
          class="pilot-action"
          data-pilot="tack"
          onClick={() => {
            actions.pilotTack();
            redraw();
          }}
        >
          Tack
        </button>
        <button
          type="button"
          class="pilot-action"
          data-pilot="gybe"
          onClick={() => {
            actions.pilotGybe();
            redraw();
          }}
        >
          Gybe
        </button>
      </div>
      <div class="pilot-row">
        <button
          type="button"
          class="pilot-action"
          data-pilot="mode"
          onClick={() => {
            actions.pilotMode();
            redraw();
          }}
        >
          {p.mode === PILOT_HEADING ? 'Hold the wind' : 'Hold a heading'}
        </button>
        <button
          type="button"
          class="pilot-action"
          data-pilot="off"
          onClick={() => {
            actions.takeHelm();
            close();
          }}
        >
          Off
        </button>
      </div>
    </section>
  );
}

export function Pilot({ actions, model }: { actions: PilotActions; model: HudModel }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const dial = useRef<HTMLDivElement>(null);
  const state = model.pilot.value;
  const on = actions.pilot.on;
  useEffect(() => {
    if (!open) {
      return;
    }
    // A tap anywhere else closes the dial; the autopilot stays on.
    const outside = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t !== null && (button.current?.contains(t) || dial.current?.contains(t))) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);
  useEffect(() => {
    // Turned off by the helm, a key or the dial: the dial goes too.
    if (!on && open) {
      setOpen(false);
    }
  }, [on, open]);
  return (
    <>
      <button
        type="button"
        ref={button}
        class={`pilot-button${on ? ' on' : ''}`}
        aria-expanded={open}
        aria-label={`Autopilot: ${state === '' ? 'off' : state}`}
        data-pilot="button"
        onClick={() => {
          if (!actions.pilot.on) {
            actions.togglePilot();
            model.flush();
            setOpen(true);
          } else {
            setOpen(!open);
          }
        }}
      >
        <span class="pilot-name">Autopilot</span>
        <span class="pilot-text" data-readout="pilot-button">
          {state === '' ? 'Off' : state}
        </span>
      </button>
      {open && on ? (
        <div ref={dial}>
          <Dial actions={actions} model={model} close={() => setOpen(false)} />
        </div>
      ) : null}
    </>
  );
}
