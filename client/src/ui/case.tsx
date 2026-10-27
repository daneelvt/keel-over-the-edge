// SPDX-License-Identifier: AGPL-3.0-only

// The instruments' case, top left at sea, one panel as a watch is one
// case: the heading-up compass card (the true wind's mark on its rim) and
// its readouts (the speed over ground, the heading, what the autopilot
// holds while it is on, and the wind); and its complications, the
// barometer and the world clock, which slide out of the case when their
// pusher on its edge is pressed and back in when it is pressed again: down
// under the compass on a tall screen, out to the side on a short one, so a
// phone held sideways keeps its height. The case never reaches the pocket
// chart: the complication opened first folds back in. In port a third
// pusher rises out of the edge and opens the harbourmaster's board. The
// pushers carry engraved decals, not words; the world clock's is itself a
// power reserve, so the world's time left is on the screen even with the
// clock shut, and in the world's last days the clock comes out by itself.
// Watching one's own machine sailor, a running light set into the case's
// top edge says its AI is at the helm (lit) or has gone quiet (hollow).

import type { ReadonlySignal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Barometer } from './barometer';
import { BarometerDial, type DialWord } from './barometerdial';
import { BoardPanel, type HarbourView } from './board';
import {
  type Complication,
  clockOut,
  disclosure,
  fitted,
  LAID,
  pressed as pressedOrder,
} from './complications';
import type { Countdown } from './countdown';
import { AneroidDecal, BoardDecal, ReserveDecal } from './decals';
import type { HudModel } from './model';
import type { SettingsSignal } from './settings';

/** The running light: the own machine sailor's AI at the helm, gone quiet, or no light. */
export type Lamp = '' | 'helm' | 'quiet';

/** How long a complication takes to slide, and a pusher to rise, ms. */
const SLIDE = 180;
const RISE = 200;
/** How long a pressed pusher's decal glows, ms. */
const GLOW = 150;
/** How far the pushers' stems stand out of the case, px; and the room kept before the pocket chart. */
const STEM = 6;
const CLEAR = 8;

/** Whether the reader asks for less motion. */
function reducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * Out, sliding back in, or in: what slides is still drawn for a moment
 * after it is put away, unless the reader asks for less motion.
 */
function useSlide(out: boolean, ms: number): 'out' | 'folding' | 'in' {
  const [folding, setFolding] = useState(false);
  const was = useRef(out);
  useEffect(() => {
    const before = was.current;
    was.current = out;
    if (!before || out || reducedMotion()) {
      setFolding(false);
      return;
    }
    setFolding(true);
    const t = setTimeout(() => setFolding(false), ms);
    return () => clearTimeout(t);
  }, [out, ms]);
  return out ? 'out' : folding ? 'folding' : 'in';
}

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

function Readouts({ model }: { model: HudModel }) {
  return (
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
  );
}

/**
 * A pusher on the case's edge: a disclosure button, its decal gold while
 * what it opens is out, glowing a moment when pressed so the press shows
 * beside the thumb.
 */
function Pusher({
  name,
  id,
  controls,
  out,
  press,
  motion = '',
  children,
}: {
  name: string;
  id: string;
  controls: string;
  out: boolean;
  press: () => void;
  /** Rising out of the case, or sinking back. */
  motion?: '' | 'rising' | 'sinking';
  children: ComponentChildren;
}) {
  const [glow, setGlow] = useState(false);
  useEffect(() => {
    if (!glow) {
      return;
    }
    const t = setTimeout(() => setGlow(false), GLOW);
    return () => clearTimeout(t);
  }, [glow]);
  return (
    <button
      type="button"
      class={`pusher${out ? ' out' : ''}${glow ? ' pressed' : ''}${motion === '' ? '' : ` ${motion}`}`}
      aria-label={name}
      data-pusher={id}
      disabled={motion === 'sinking'}
      {...disclosure(controls, out)}
      onClick={() => {
        setGlow(true);
        press();
      }}
    >
      <span class="pusher-stem" aria-hidden="true" />
      <span class="pusher-face">{children}</span>
    </button>
  );
}

/** The world clock: the time left until a new world, and the day and hour it comes. */
function WorldClock({ end }: { end: Countdown }) {
  const text = end.text.value;
  const when = end.when.value;
  return (
    <div class="world-clock">
      {text === '' ? null : (
        <p class="clock-left" data-readout="falls">
          <span role="timer" aria-label={`A new world in ${text}`}>
            New world in <b>{text}</b>
          </span>
        </p>
      )}
      {when === '' ? null : (
        <p class="clock-when" data-readout="ends-at">
          {when}
        </p>
      )}
    </div>
  );
}

const LAMP_WORDS: Record<Lamp, string> = {
  '': '',
  helm: 'Your machine sailor’s AI is at the helm',
  quiet: 'Your machine sailor’s AI has gone quiet',
};

/** The case's ids for what its pushers open. */
const IDS: Record<Complication, string> = { barometer: 'case-barometer', clock: 'case-clock' };
const BOARD_ID = 'harbour-board';

export interface CaseProps {
  model: HudModel;
  settings: SettingsSignal;
  /** The countdown to the world's end; null where there is none. */
  end: Countdown | null;
  barometer: { barometer: Barometer; words: readonly DialWord[] } | null;
  harbour: HarbourView | null;
  /** The running light; null where there is none. */
  lamp: ReadonlySignal<Lamp> | null;
}

export function Case({ model, settings, end, barometer, harbour, lamp }: CaseProps) {
  const el = useRef<HTMLElement>(null);
  const s = settings.value.value;
  const world = end?.end.value ?? null;
  // The world clock shows once a world's end is told, even with none known.
  const clock = end !== null && world !== null ? end : null;
  const closing = end?.closing.value === true;
  const [putAwayIn, setPutAwayIn] = useState<string | null>(null);
  const out: Record<Complication, boolean> = {
    barometer: barometer !== null && s.barometer,
    clock: clock !== null && clockOut(s.worldClock, closing, putAwayIn === world?.world),
  };
  // The open complications, oldest opened first.
  const [order, setOrder] = useState<Complication[]>(() => LAID.filter((c) => out[c]));
  const open = [
    ...order.filter((c) => out[c]),
    ...LAID.filter((c) => out[c] && !order.includes(c)),
  ];
  const put = (c: Complication, on: boolean) => {
    setOrder(pressedOrder(open, c, on));
    if (c === 'barometer') {
      settings.set({ barometer: on });
      return;
    }
    settings.set({ worldClock: on });
    setPutAwayIn(!on && closing && world !== null ? world.world : null);
  };
  const slides: Record<Complication, 'out' | 'folding' | 'in'> = {
    barometer: useSlide(out.barometer, SLIDE),
    clock: useSlide(out.clock, SLIDE),
  };
  // The case never reaches the pocket chart: the oldest opened folds back.
  const latest = useRef({ open, put, slides });
  latest.current = { open, put, slides };
  useLayoutEffect(() => {
    const fold = () => {
      const c = el.current;
      const { open, put, slides } = latest.current;
      if (c === null || open.length === 0) {
        return;
      }
      const room = roomOf(c);
      const shown = (hide: (k: Complication) => boolean) => {
        for (const k of LAID) {
          const part = c.querySelector<HTMLElement>(`#${IDS[k]}`);
          if (part !== null) {
            part.hidden = hide(k);
          }
        }
        const all = c.querySelector<HTMLElement>('.complications');
        if (all !== null) {
          all.hidden = LAID.every(hide);
        }
      };
      const keep = fitted(open, (o) => {
        shown((k) => !o.includes(k));
        return c.getBoundingClientRect().right + STEM <= room;
      });
      // As drawn, whatever was tried.
      shown((k) => slides[k] === 'in');
      for (const k of open) {
        if (!keep.includes(k)) {
          put(k, false);
        }
      }
    };
    fold();
    globalThis.addEventListener('resize', fold);
    return () => globalThis.removeEventListener('resize', fold);
  });
  // The harbour's pusher rises in port and sinks as the boat leaves.
  const port = harbour?.port.value ?? null;
  const rise = useSlide(port !== null, RISE);
  const [risen, setRisen] = useState(false);
  useEffect(() => {
    if (port === null) {
      setRisen(false);
      return;
    }
    const t = setTimeout(() => setRisen(true), reducedMotion() ? 0 : RISE);
    return () => clearTimeout(t);
  }, [port === null]);
  const [boardOpen, setBoardOpen] = useState(false);
  useEffect(() => {
    if (port === null) {
      setBoardOpen(false);
    }
  }, [port]);
  const light = lamp?.value ?? '';
  return (
    <>
      <section
        ref={el}
        class={`panel case${closing ? ' closing' : ''}`}
        aria-label="Instruments"
        data-case=""
      >
        {light === '' ? null : (
          <span class={`lamp ${light}`} data-lamp={light} aria-hidden="true" />
        )}
        <p class="visually-hidden" role="status">
          {LAMP_WORDS[light]}
        </p>
        <div class="case-top">
          <div class="case-face">
            <CompassCard model={model} />
            <Readouts model={model} />
          </div>
          <div class="pushers">
            {clock !== null ? (
              <Pusher
                name="World clock"
                id="clock"
                controls={IDS.clock}
                out={out.clock}
                press={() => put('clock', !out.clock)}
              >
                <ReserveDecal reserve={clock.reserve.value} />
              </Pusher>
            ) : null}
            {barometer !== null ? (
              <Pusher
                name="Barometer"
                id="barometer"
                controls={IDS.barometer}
                out={out.barometer}
                press={() => put('barometer', !out.barometer)}
              >
                <AneroidDecal />
              </Pusher>
            ) : null}
            {harbour !== null && rise !== 'in' ? (
              <Pusher
                name="Harbour board"
                id="board"
                controls={BOARD_ID}
                out={boardOpen}
                press={() => setBoardOpen(!boardOpen)}
                motion={rise === 'folding' ? 'sinking' : risen ? '' : 'rising'}
              >
                <BoardDecal />
              </Pusher>
            ) : null}
          </div>
        </div>
        <div class="complications" hidden={LAID.every((k) => slides[k] === 'in')}>
          {barometer !== null ? (
            <div
              class={`complication${slides.barometer === 'folding' ? ' folding' : ''}`}
              id={IDS.barometer}
              data-complication="barometer"
              hidden={slides.barometer === 'in'}
            >
              <BarometerDial barometer={barometer.barometer} words={barometer.words} />
            </div>
          ) : null}
          {clock !== null ? (
            <div
              class={`complication${slides.clock === 'folding' ? ' folding' : ''}`}
              id={IDS.clock}
              data-complication="clock"
              hidden={slides.clock === 'in'}
            >
              <WorldClock end={clock} />
            </div>
          ) : null}
        </div>
        {end !== null && end.last.value !== '' ? (
          <span class="visually-hidden" role="status">
            {end.last.value}
          </span>
        ) : null}
      </section>
      {boardOpen && port !== null && harbour !== null ? (
        <BoardPanel id={BOARD_ID} harbour={harbour} port={port} close={() => setBoardOpen(false)} />
      ) : null}
    </>
  );
}

/** The right edge the case may reach: short of the pocket chart and its pusher, or of the screen. */
function roomOf(c: HTMLElement): number {
  const hud = c.closest('.hud') ?? document;
  let room = globalThis.innerWidth - CLEAR;
  for (const sel of ['.pocket-chart', '.pocket-weather']) {
    const p = hud.querySelector(sel);
    if (p !== null) {
      room = Math.min(room, p.getBoundingClientRect().left - CLEAR);
    }
  }
  return room;
}
