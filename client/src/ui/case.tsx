// SPDX-License-Identifier: AGPL-3.0-only

// The instruments' case, top left at sea, one panel as a watch is one
// case, as big as its dial and no bigger: the heading-up compass card (the
// true wind's mark on its rim, the heading's figures in a window at its
// lubber line) and beside it its readouts, each a slot as wide as its
// longest words, so the case keeps one size whatever they say: the speed
// over ground, the wind, and a last line that says what nothing else on
// the screen does, there only where it can say something: on a boat
// watched, or with the right-of-way overlay on. Its pushers stand on its edges: the barometer's on the
// right, where a watch's crown is, sliding the barometer out of the case
// and back in, down under the compass; in port the harbourmaster's board's
// rises out of the bottom edge. Held upright, where the case shares the
// top of the screen with the pocket chart, both stand out of the bottom
// edge beneath the readouts, the case no wider than its words. The case
// never reaches the pocket chart: the complication opened first folds back
// in, unless the case reached it with nothing out. The pushers carry engraved
// decals, not words. Watching one's own machine sailor, a running light
// set into the case's top edge says its AI is at the helm (lit) or has
// gone quiet (hollow).

import type { ReadonlySignal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { LampState } from '../net/messages';
import type { Barometer } from './barometer';
import { BarometerDial, type DialWord } from './barometerdial';
import { BoardPanel, type HarbourView } from './board';
import {
  type Complication,
  caseLine,
  disclosure,
  fitted,
  LAID,
  pressed as pressedOrder,
} from './complications';
import { AneroidDecal, BoardDecal } from './decals';
import type { HudModel } from './model';
import type { SettingsSignal } from './settings';

/** The running light: the own machine sailor's AI at the helm, gone quiet, or no light. */
export type Lamp = '' | LampState;

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

/** Whether the screen is held upright, kept as it turns. */
export function useUpright(): boolean {
  const query = '(orientation: portrait)';
  const [upright, setUpright] = useState(() => globalThis.matchMedia?.(query).matches === true);
  useEffect(() => {
    const m = globalThis.matchMedia?.(query);
    if (m === undefined) {
      return;
    }
    const on = () => setUpright(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return upright;
}

const POINTS = ['N', 'E', 'S', 'W'];
/** How far out on the card the points are lettered, inside the window's foot. */
const POINT_R = 19;

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
          const x = POINT_R * Math.sin(a);
          const y = -POINT_R * Math.cos(a);
          return (
            <text
              key={p}
              class={`compass-point${p === 'N' ? ' north' : ''}`}
              x={x}
              y={y}
              transform={`rotate(${i * 90} ${x} ${y})`}
            >
              {p}
            </text>
          );
        })}
      </g>
      {/* The window at the lubber line, the heading's figures read through it. */}
      <rect class="compass-window" x="-19" y="-46" width="38" height="21" rx="3" />
      <text class="compass-figures" x="1.5" y="-35.5" data-readout="figures">
        {model.figures}
      </text>
      <g ref={(el) => model.windMark.attach(el)}>
        <path
          class="compass-wind"
          d="M 0 -47 L 7 -58 L 0 -54 L -7 -58 Z"
          transform="translate(0 16)"
        />
      </g>
      <path
        class="compass-boat"
        d="M 0 -10 C 3.5 -4.5 4.2 3.5 2.8 10 L -2.8 10 C -4.2 3.5 -3.5 -4.5 0 -10 Z"
        transform="translate(0 6)"
      />
    </svg>
  );
}

/**
 * A readout's slot: as wide as the longest of its sizes, which are laid
 * out unseen, so the case keeps its size whatever the slot says.
 */
function Slot({
  sizes,
  class: cls = '',
  children,
}: {
  sizes: readonly ComponentChildren[];
  class?: string;
  children: ComponentChildren;
}) {
  return (
    <span class={`slot${cls === '' ? '' : ` ${cls}`}`}>
      {sizes.map((z, i) => (
        <span key={i} class="slot-size" aria-hidden="true">
          {z}
        </span>
      ))}
      <span class="slot-text">{children}</span>
    </span>
  );
}

/** The longest each slot can say. */
const SPEED_SIZES = ['00.0'];
const WIND_SIZES = [
  <>
    Wind <b>WNW 88 kn · F12</b>
  </>,
  <>
    Wind <b>NNW 88 kn · F12</b>
  </>,
];
const LINE_SIZES = [
  <>
    Autopilot <b>Heading 000°</b>
  </>,
  <>
    Autopilot <b>Wind 135° P</b>
  </>,
  <>
    Autopilot <b>Gybe stalled</b>
  </>,
  <b>Starboard tack</b>,
];

function Readouts({
  model,
  controls,
  last,
}: {
  model: HudModel;
  controls: boolean;
  /** Whether the last line has a place: on a boat watched, or with the right-of-way overlay. */
  last: boolean;
}) {
  const line = caseLine(model.pilot.value, model.tack.value, controls);
  const pilot = line !== '' && line !== model.tack.value;
  return (
    <div class="readouts">
      <p class="speed">
        <Slot class="figures" sizes={SPEED_SIZES}>
          <span data-readout="speed">{model.speed}</span>
        </Slot>
        <span class="unit">kn</span>
      </p>
      <p class="visually-hidden">
        Heading <span data-readout="heading">{model.heading}</span>
      </p>
      <p>
        <Slot sizes={WIND_SIZES}>
          Wind <b data-readout="wind">{model.wind}</b>
        </Slot>
      </p>
      {last ? (
        <p>
          <Slot sizes={LINE_SIZES}>
            {pilot ? (
              <>
                Autopilot <b data-readout="pilot">{model.pilot}</b>
              </>
            ) : line === '' ? null : (
              <b data-readout="tack">{line}</b>
            )}
          </Slot>
        </p>
      ) : null}
    </div>
  );
}

/**
 * A pusher on the case's edge: a disclosure button, its decal gold while
 * what it opens is out, glowing a moment when pressed so the press shows
 * beside the thumb.
 */
export function Pusher({
  name,
  id,
  controls,
  out,
  press,
  edge = 'right',
  motion = '',
  pressed = null,
  class: cls = '',
  children,
}: {
  name: string;
  id: string;
  /** What it opens, as a disclosure; "" for a switch, which says whether it is pressed. */
  controls: string;
  out: boolean;
  press: () => void;
  /** The edge it stands on, its stem out of it. */
  edge?: 'right' | 'bottom' | 'left';
  /** Rising out of the case, or sinking back. */
  motion?: '' | 'rising' | 'sinking';
  /** A switch's state; null for a disclosure. */
  pressed?: boolean | null;
  class?: string;
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
      class={`pusher ${edge}${out ? ' out' : ''}${glow ? ' pressed' : ''}${motion === '' ? '' : ` ${motion}`}${cls === '' ? '' : ` ${cls}`}`}
      aria-label={name}
      data-pusher={id}
      data-edge={edge}
      disabled={motion === 'sinking'}
      {...(pressed === null ? disclosure(controls, out) : { 'aria-pressed': pressed })}
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

const LAMP_WORDS: Record<Lamp, string> = {
  '': '',
  helm: 'Your machine sailor’s AI is at the helm',
  quiet: 'Your machine sailor’s AI has gone quiet',
};

/** The case's ids for what its pushers open. */
const IDS: Record<Complication, string> = { barometer: 'case-barometer' };
const BOARD_ID = 'harbour-board';

export interface CaseProps {
  model: HudModel;
  settings: SettingsSignal;
  /** Whether the controls that act on the boat are on the screen; none on a boat watched. */
  controls: boolean;
  barometer: { barometer: Barometer; words: readonly DialWord[] } | null;
  harbour: HarbourView | null;
  /** The running light; null where there is none. */
  lamp: ReadonlySignal<Lamp> | null;
}

export function Case({ model, settings, controls, barometer, harbour, lamp }: CaseProps) {
  const el = useRef<HTMLElement>(null);
  const s = settings.value.value;
  const out: Record<Complication, boolean> = {
    barometer: barometer !== null && s.barometer,
  };
  // The open complications, oldest opened first.
  const [order, setOrder] = useState<Complication[]>(() => LAID.filter((c) => out[c]));
  const open = [
    ...order.filter((c) => out[c]),
    ...LAID.filter((c) => out[c] && !order.includes(c)),
  ];
  const put = (c: Complication, on: boolean) => {
    setOrder(pressedOrder(open, c, on));
    settings.set({ barometer: on });
  };
  const slides: Record<Complication, 'out' | 'folding' | 'in'> = {
    barometer: useSlide(out.barometer, SLIDE),
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
      // A case already at the chart with nothing out, on a narrow screen,
      // folds back nothing that does not widen it: held upright the
      // barometer hangs beneath the case and never does.
      shown(() => true);
      const bare = c.getBoundingClientRect().right + STEM;
      const keep = fitted(open, (o) => {
        shown((k) => !o.includes(k));
        return c.getBoundingClientRect().right + STEM <= Math.max(room, bare);
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
  const upright = useUpright();
  const light = lamp?.value ?? '';
  const board = harbour !== null && rise !== 'in';
  return (
    <>
      <section
        ref={el}
        class={`panel case${board ? ' in-port' : ''}`}
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
            <Readouts model={model} controls={controls} last={!controls || s.rightOfWay} />
          </div>
          <div class="case-pushers">
            {barometer !== null ? (
              <Pusher
                name="Barometer"
                id="barometer"
                controls={IDS.barometer}
                out={out.barometer}
                press={() => put('barometer', !out.barometer)}
                edge={upright ? 'bottom' : 'right'}
              >
                <AneroidDecal />
              </Pusher>
            ) : null}
            {board ? (
              <Pusher
                name="Harbour board"
                id="board"
                controls={BOARD_ID}
                out={boardOpen}
                press={() => setBoardOpen(!boardOpen)}
                edge="bottom"
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
        </div>
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
  for (const sel of ['.pocket-frame', '.pocket-weather']) {
    const p = hud.querySelector(sel);
    if (p !== null) {
      room = Math.min(room, p.getBoundingClientRect().left - CLEAR);
    }
  }
  return room;
}
