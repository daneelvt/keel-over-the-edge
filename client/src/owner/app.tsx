// SPDX-License-Identifier: AGPL-3.0-only

// The world page: the map, and beside it the world's clock, the weather
// and its week, the boats at sea and in the queue, the islands, the places
// and the lighthouses, each light flashing its character by the world's
// clock as every phone shows it. It reads the world once a second, and not
// while its tab is hidden. A click on the map picks a point: what is there
// is told, with its pressure at the tick shown and the barometer's
// tendency, its sea while the sea is shown, its sky while the clouds or
// the rain are, and its visibility and what makes it, and the owner's
// boats can be put there, or at a place, or at a position written as
// charts write it. The fog and the lightning show while their layers are,
// and with them the lights sounding their fog signals and those lit by
// day. The forecast shows over the truth while its layer is, every system's
// track over its reach, with every gale warning of the world, and beside
// the week how busy its weather has been; a point,
// an island or a place picked has its box and outlook at the tick shown,
// as a chart gives them to a sailor there.
// The page acts on the owner's boats alone; the server refuses the rest.
// At the top, always in view, the world's end counted down by keel's clock; the
// owner may make a new next world, begin it now or chart the whole world,
// each confirmed with what it will do, and look over the next world, drawn
// as the current is, on a tab of its own, and make it again. The players'
// accounts are on a third tab: searched, and each opened on its card, from
// the search or from its boat or place in the queue, where the owner stops,
// starts again, revokes or deletes it, sets how many machine sailors it may
// have, and sets the token lifetime of AI apps. Beside each account's
// owner's flag is its priority, which its next join takes: a priority
// account never waits. A machine sailor's boat is marked with its agent's
// app, its last call and its wait; humans and machine sailors wait in
// queues of their own, each shown with its places' positions, and the
// machine sailors at sea are counted against their cap and the places kept
// for them.

import { render } from 'preact';
import {
  type Dispatch,
  type StateUpdater,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'preact/hooks';
import { formatPosition } from '../chart/position';
import { lightOn } from '../lights/character';
import { AccountBoxes, AccountsTab } from './accounts';
import { agentWords, machinesLine, rulesLine, spectatorsLine, watchersWords } from './admission';
import {
  type AccountsData,
  type Admission,
  type Boat,
  type BusyPage,
  type ChartedData,
  type CloudsPage,
  type Control,
  type Current,
  control,
  drawing,
  type FeaturesData,
  type ForecastPage,
  type GalesPage,
  type Group,
  getBusy,
  getBytes,
  getClouds,
  getForecast,
  getGales,
  getJSON,
  getPlaceWeather,
  getPressure,
  getSea,
  getVisibility,
  type Island,
  type Lifecycle,
  type Light,
  type LightCharacter,
  type Place,
  type PlaceOf,
  type PlacesData,
  type PlaceWeather,
  type Point,
  type PressureAt,
  type SeaPage,
  type Town,
  type TownsData,
  type VisibilityPage,
  type Waiting,
  type WeatherWeek,
  type WorldNow,
} from './api';
import {
  CLOUD_COLOURS,
  CLOUDS_EVERY,
  RAIN_SPACING,
  RAIN_WORDS,
  rainRanges,
  shadeOver,
  sheetShade,
  sheetsPicture,
  skyWords,
  WMO_WORDS,
} from './clouds';
import {
  allLayers,
  COLOURS,
  drawMap,
  gustPicture,
  ISLAND_DETAIL,
  LAYER_NAMES,
  type Layers,
  type MapData,
} from './draw';
import {
  FLASH_FOR,
  FOG_ALPHA,
  FOG_COLOURS,
  fogPicture,
  lightWords,
  MET_WORDS,
  outlinesUnder,
  VISIBILITY_EVERY,
  VISIBILITY_WORDS,
  visibilityRanges,
  visibilityWords,
} from './fog';
import { busyRows, FORECAST_COLOURS, spellAt, trackAt, warningSpan } from './forecast';
import { brief, hidden, serverOffset } from './life';
import { type Life, LifecycleCard, SwitchBar, WorldByHand } from './lifecycle';
import { machinesWords } from './machines';
import { centreOn, fitView, pan, toWorld, type View, zoomAt } from './map';
import { foamOver, RAISED, SEA_COLOURS, SEA_EVERY, SEA_FULL, seaWords } from './sea';
import { fromNow, WEATHER_COLOURS, whereFrom } from './weather';
import { useWeather, WEATHER_EVERY, WeekCard } from './week';

/** How often the page reads the world, ms. */
export const EVERY = 1000;

function image(src: string, onload: () => void): HTMLImageElement {
  const img = new Image();
  img.onload = onload;
  img.src = src;
  return img;
}

function seconds(s: number): string {
  if (s < 60) {
    return `${s.toFixed(0)} s`;
  }
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${Math.round(s - 60 * m)} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function hour(h: number): string {
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** World time now, µs, from the world's time last read and when: the page's own clock between reads. */
interface WorldClock {
  worldTime: number;
  at: number;
}

function worldUsAt(c: WorldClock, now: number): number {
  return Math.floor((c.worldTime + (now - c.at) / 1000) * 1e6);
}

/** How often the lights' marks beside their rows are looked at, ms. */
const FLASH_EVERY = 100;

/** The map: a canvas filling its box, panned by a drag, zoomed by the wheel, a click picking a point. */
function MapCanvas({
  data,
  layers,
  view,
  setView,
  pick,
}: {
  data: MapData;
  layers: Layers;
  view: View | null;
  setView: Dispatch<StateUpdater<View | null>>;
  pick: (east: number, north: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);

  const drag = useRef<{ x: number; y: number; moved: number } | null>(null);
  // Fits the canvas to its box, and the view to the canvas.
  useEffect(() => {
    const c = canvas.current;
    if (c === null) {
      return;
    }
    const fit = (): void => {
      const r = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
      setView((v) =>
        v === null ? fitView(r.width, r.height) : { ...v, width: r.width, height: r.height },
      );
    };
    const ro = new ResizeObserver(fit);
    ro.observe(c);
    return () => ro.disconnect();
  }, [setView]);
  useEffect(() => {
    const c = canvas.current;
    // Drawn on the CPU: the map is drawn again with each reading, and a
    // canvas drawn by the GPU process starves a software GPU's other pages.
    const ctx = c?.getContext('2d', { willReadFrequently: true });
    if (c == null || ctx == null || view === null) {
      return;
    }
    const dpr = c.width / Math.max(1, view.width);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawMap(ctx, view, data, layers);
  });
  return (
    <canvas
      ref={canvas}
      class="map"
      data-testid="map"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, moved: 0 };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d === null || view === null) {
          return;
        }
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        d.x = e.clientX;
        d.y = e.clientY;
        d.moved += Math.hypot(dx, dy);
        if (d.moved > 3) {
          setView(pan(view, dx, dy));
        }
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (d !== null && d.moved <= 3 && view !== null) {
          const r = e.currentTarget.getBoundingClientRect();
          const [east, north] = toWorld(view, e.clientX - r.left, e.clientY - r.top);
          pick(east, north);
        }
      }}
      onWheel={(e) => {
        e.preventDefault();
        if (view === null) {
          return;
        }
        const r = e.currentTarget.getBoundingClientRect();
        setView(zoomAt(view, e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.002)));
      }}
    />
  );
}

function Clock({ now, accounts }: { now: WorldNow; accounts: AccountsData | null }) {
  const w = now.world;
  return (
    <section class="card" aria-label="The world">
      <h2>World {w.number}</h2>
      <dl>
        <dt>Tick</dt>
        <dd data-field="tick">{now.tick}</dd>
        <dt>World time</dt>
        <dd>{seconds(now.worldTime)}</dd>
        <dt>Hour at the centre</dt>
        <dd>{hour(now.hour)}</dd>
        <dt>Seed</dt>
        <dd>
          {w.seed} (generator {w.generator})
        </dd>
        <dt>Made</dt>
        <dd>{w.made}</dd>
        <dt>Epoch</dt>
        <dd>{w.epoch}</dd>
        <dt>ID</dt>
        <dd class="small">{w.id}</dd>
        <dt>Accounts</dt>
        <dd data-field="accounts">
          {accounts === null
            ? '—'
            : `${accounts.total}: ${accounts.week} made this week, ${accounts.today} seen today${
                accounts.machines === undefined ? '' : `; ${machinesWords(accounts.machines)}`
              }`}
        </dd>
      </dl>
    </section>
  );
}

function WeatherCard({ now }: { now: WorldNow }) {
  const w = now.weather;
  return (
    <section class="card" aria-label="The weather">
      <h2>Weather</h2>
      <p data-field="weather">
        {w.regime || '—'}
        {w.steady ? ', steady' : ''}
        {w.held ? ', held by the developer' : ''}: {w.knots.toFixed(1)} kn from {w.from.toFixed(0)}
        °, drifting {w.drift.toFixed(0)}°, gusts ×{w.gust.toFixed(2)}
      </p>
      <p>
        {w.next > 0
          ? `The next change begins in ${seconds(w.nextIn)}, at tick ${w.next}.`
          : 'No change in sight.'}
      </p>
    </section>
  );
}

/** The lights' marks beside their rows, each lit while its light shows: one timer for them all. */
const marks = new Map<
  HTMLSpanElement,
  { light: Light; character: LightCharacter; clock: { current: WorldClock } }
>();
let marksTimer: ReturnType<typeof setInterval> | null = null;

function lightMarks(): void {
  if (hidden()) {
    return;
  }
  const now = performance.now();
  for (const [dot, m] of marks) {
    // Only a change touches the page: nothing repaints while a light holds.
    const on = lightOn(m.character.steps, m.light.phase, worldUsAt(m.clock.current, now))
      ? '1'
      : '0';
    if (dot.dataset.on !== on) {
      dot.dataset.on = on;
    }
  }
}

/** A light's mark beside its row: lit while it shows, by the world's clock. */
function Flash({
  light,
  character,
  clock,
}: {
  light: Light;
  character: LightCharacter | undefined;
  clock: { current: WorldClock };
}) {
  const dot = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const d = dot.current;
    if (d === null || character === undefined) {
      return;
    }
    d.dataset.colour = character.colour;
    marks.set(d, { light, character, clock });
    if (marksTimer === null) {
      marksTimer = setInterval(lightMarks, FLASH_EVERY);
    }
    return () => {
      marks.delete(d);
      if (marks.size === 0 && marksTimer !== null) {
        clearInterval(marksTimer);
        marksTimer = null;
      }
    };
  }, [light, character, clock]);
  return <span ref={dot} class="flash" data-light={light.number} />;
}

/** What a place's kind measures of it, in a few words. */
function placeWords(p: Place): string {
  const d = p.details;
  const words: string[] = [p.zone];
  if (d.shelter !== undefined) {
    words.push(d.shelter);
  }
  if (d.depth !== undefined) {
    words.push(`${d.depth.toFixed(1)} m`);
  }
  if (d.across !== undefined) {
    words.push(`${d.across.toFixed(0)} m across`);
  }
  if (d.length !== undefined) {
    words.push(`${d.length.toFixed(0)} m long`);
  }
  if (d.offshore === true) {
    words.push('offshore');
  }
  if (d.ship !== undefined) {
    const s = d.ship;
    words.push(
      `the ${s.rig} ${s.name} (${s.language}), ${s.cargo}, ${s.age}, ${s.sunk ? 'sunk' : 'stranded'}`,
    );
  }
  return words.join(', ');
}

/** The boats at sea by kind: the machine sailors against their cap and reserve, and their agents' rules. */
function AdmissionLines({ a }: { a: Admission }) {
  const rules = rulesLine(a);
  return (
    <>
      <p class="small" data-field="machines-at-sea">
        {machinesLine(a)}; {a.humans} {a.humans === 1 ? 'human' : 'humans'} at sea.
      </p>
      {rules !== '' ? (
        <p class="small" data-field="agent-rules">
          {rules}
        </p>
      ) : null}
    </>
  );
}

/** One kind's queue, the head first, each place with its position among its kind's. */
function Queue({
  title,
  field,
  queue,
  act,
  account,
}: {
  title: string;
  field: string;
  queue: Waiting[];
  act: (path: 'flag' | 'priority', body: unknown, what: string) => Promise<boolean>;
  account: (id: string) => void;
}) {
  return (
    <>
      <h3 data-field={field}>
        {title}: {queue.length}
      </h3>
      {queue.length > 0 ? (
        <table class="queue">
          <tbody>
            {queue.map((q) => (
              <tr key={q.account}>
                <td>{q.position}</td>
                <td>{q.sailor || '—'}</td>
                <td>{seconds(q.waited)}</td>
                <td>
                  {[q.connected ? '' : 'away', q.admitted ? 'priority' : '']
                    .filter((m) => m !== '')
                    .join(', ')}
                </td>
                <td>
                  <AccountBoxes
                    account={q.account}
                    sailor={q.sailor}
                    tools={q.tools}
                    priority={q.priority}
                    human={!q.machine}
                    act={act}
                  />{' '}
                  <AccountButton id={q.account} account={account} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}

/** Opens the account's card on the Accounts tab. */
function AccountButton({ id, account }: { id: string; account: (id: string) => void }) {
  return (
    <button
      type="button"
      name="account"
      class="small"
      onClick={(e) => {
        e.stopPropagation();
        account(id);
      }}
    >
      Account
    </button>
  );
}

/** A boat's row, and for the owner's its controls. */
function BoatRow({
  b,
  chosen,
  choose,
  account,
  act,
  picked,
  islands,
}: {
  b: Boat;
  chosen: boolean;
  choose: () => void;
  account: (id: string) => void;
  act: (
    path: 'flag' | 'place' | 'unseen' | 'priority',
    body: unknown,
    what: string,
  ) => Promise<boolean>;
  picked: [number, number] | null;
  islands: Island[];
}) {
  const [island, setIsland] = useState(0);
  const [position, setPosition] = useState('');
  const marks = [
    b.falling ? 'falling' : '',
    b.connected ? '' : `in its grace, ${seconds(b.grace)}`,
    b.stays ? 'staying' : '',
    b.unseen ? 'unseen' : '',
    b.eye !== null ? 'roaming' : '',
    b.admitted ? 'given as a priority account’s' : '',
    watchersWords(b.watchers),
  ].filter((m) => m !== '');
  return (
    <>
      <tr class={chosen ? 'chosen' : ''} onClick={choose} data-boat={b.boat}>
        <td>{b.boat}</td>
        <td>
          {b.sailor || '—'}
          {b.machine ? ' (AI)' : ''}
          {b.machine ? (
            <div class="small agent" data-field="agent">
              {agentWords(b.agent)}
            </div>
          ) : null}
        </td>
        <td>{b.kind}</td>
        <td class="small" data-field="boat-position">
          {formatPosition(b.east, b.north)}
        </td>
        <td>{b.knots.toFixed(1)} kn</td>
        <td>{b.fromLip.toFixed(0)} m</td>
        <td>{marks.join(', ')}</td>
        <td>
          <AccountBoxes
            account={b.account}
            sailor={b.sailor}
            tools={b.tools}
            priority={b.priority}
            human={b.human && !b.machine}
            act={act}
          />{' '}
          <AccountButton id={b.account} account={account} />
        </td>
      </tr>
      {chosen && b.tools ? (
        <tr class="controls">
          <td colSpan={8}>
            <button
              type="button"
              disabled={picked === null}
              onClick={() =>
                picked !== null &&
                act(
                  'place',
                  { boat: b.boat, east: picked[0], north: picked[1] },
                  'teleport to the point',
                )
              }
            >
              To the point picked
            </button>
            <form
              class="position"
              onSubmit={(e) => {
                e.preventDefault();
                void act('place', { boat: b.boat, position }, `teleport to ${position.trim()}`);
              }}
            >
              <input
                type="text"
                name="position"
                placeholder="67°24′N 045°12′"
                aria-label="A position: degrees and minutes of latitude, then of longitude"
                value={position}
                onInput={(e) => setPosition(e.currentTarget.value)}
              />
              <button type="submit" disabled={position.trim() === ''}>
                To the position
              </button>
            </form>
            <button
              type="button"
              onClick={() => act('place', { boat: b.boat, start: true }, 'teleport to the start')}
            >
              To the start
            </button>
            <select
              name="island"
              value={island}
              onChange={(e) => setIsland(Number(e.currentTarget.value))}
            >
              {islands
                .filter((is) => is.group < 0)
                .map((is) => (
                  <option key={is.number} value={is.number}>
                    {is.name}
                  </option>
                ))}
            </select>
            <button
              type="button"
              onClick={() => act('place', { boat: b.boat, island }, 'teleport to the island')}
            >
              To the island
            </button>
            <button
              type="button"
              disabled={b.eye === null}
              onClick={() =>
                act('place', { boat: b.boat, camera: true }, 'teleport under its camera')
              }
            >
              Under its camera
            </button>
            <label>
              <input
                type="checkbox"
                name="unseen"
                checked={b.unseen}
                onChange={(e) =>
                  act('unseen', { boat: b.boat, on: e.currentTarget.checked }, 'unseen')
                }
              />{' '}
              unseen by other players
            </label>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** How often what is charted is read, ms. */
const CHARTED_EVERY = 5000;

/** How often the world's life is read, ms. */
const LIFE_EVERY = 5000;

/** The layers that are live, drawn of the world being sailed alone: none of them for the next world. */
const LIVE: ReadonlySet<keyof Layers> = new Set([
  'sea',
  'cloud',
  'rain',
  'fog',
  'lightning',
  'gusts',
  'wind',
  'forecast',
  'boats',
  'charted',
]);

/** How often the world's gale warnings are read while the forecast shows, and the busy weather's figures, ms. */
const FORECAST_PAST_EVERY = 60_000;

/** The sea layer's legend: the waves' heights shaded, the swell's arrow, the hatching. */
function SeaLegend() {
  const heights = [0.25, 0.5, 1, SEA_FULL];
  return (
    <p class="small legend" data-field="sea-legend">
      {heights.map((h) => (
        <span key={h}>
          <i class="swatch" style={{ background: foamOver(COLOURS.sea, h) }} /> {h} m
        </span>
      ))}
      <span>
        <b style={{ color: SEA_COLOURS.swell }}>→</b> swell
      </span>
      <span>
        <i
          class="swatch"
          style={{
            background: `repeating-linear-gradient(-45deg, ${SEA_COLOURS.raised} 0 1px, ${COLOURS.sea} 1px 4px)`,
          }}
        />{' '}
        raised over ×{RAISED} by a current
      </span>
    </p>
  );
}

/** The cloud layer's legend: each sheet shaded at its whole cover, the cumulus, a heaped cloud's outline. */
function CloudLegend() {
  const sheets: [string, number, number, number][] = [
    ['cirrus', 1, 0, 0],
    ['middle', 0, 1, 0],
    ['low', 0, 0, 1],
  ];
  return (
    <p class="small legend" data-field="cloud-legend">
      {sheets.map(([name, c, m, l]) => (
        <span key={name}>
          <i class="swatch" style={{ background: shadeOver(COLOURS.sea, sheetShade(c, m, l)) }} />{' '}
          {name}
        </span>
      ))}
      <span>
        <i class="swatch round" style={{ background: CLOUD_COLOURS.cumulus }} /> cumulus
      </span>
      <span>
        <i class="swatch round" style={{ border: `1.5px solid ${CLOUD_COLOURS.outline}` }} /> heaped
        cloud, its top in m
      </span>
    </p>
  );
}

/** The rain layer's legend: each word's stipple and the rates it spans. */
function RainLegend({ words }: { words: readonly number[] }) {
  const ranges = rainRanges(words);
  return (
    <p class="small legend" data-field="rain-legend">
      {ranges.map((r, k) => {
        const s = RAIN_SPACING[k + 1] ?? 3;
        return (
          <span key={r}>
            <i
              class="swatch stipple"
              style={{
                background: `radial-gradient(circle, ${CLOUD_COLOURS.rain} 0.9px, transparent 1.3px) 0 0 / ${s}px ${s}px, ${COLOURS.sea}`,
              }}
            />{' '}
            {RAIN_WORDS[k + 1]} {r}
          </span>
        );
      })}
      <span>mm/h</span>
    </p>
  );
}

/** The fog layer's legend: each word's shade and the visibilities it spans, a very poor area's outline. */
function FogLegend({ words }: { words: readonly number[] }) {
  const ranges = visibilityRanges(words);
  const [r, g, b] = FOG_COLOURS.fog;
  return (
    <p class="small legend" data-field="fog-legend">
      {ranges.map((range, k) => {
        const word = 3 - k;
        return (
          <span key={range}>
            <i
              class="swatch"
              style={{
                background: `linear-gradient(rgb(${r} ${g} ${b} / ${FOG_ALPHA[word]}), rgb(${r} ${g} ${b} / ${FOG_ALPHA[word]})), ${COLOURS.sea}`,
                border: word === 3 ? `1.5px solid ${FOG_COLOURS.outline}` : undefined,
              }}
            />{' '}
            {VISIBILITY_WORDS[word]} {range}
          </span>
        );
      })}
      <span>m; good unshaded</span>
      <span>
        <i class="swatch round" style={{ border: `2px solid ${FOG_COLOURS.byDay}` }} /> light lit by
        day
      </span>
      <span>
        <b style={{ color: FOG_COLOURS.sounding }}>)))</b> sounding its fog signal
      </span>
    </p>
  );
}

/** The lightning layer's legend: a flash to the sea, one in the cloud, and how long they stay. */
function LightningLegend() {
  return (
    <p class="small legend" data-field="lightning-legend">
      <span>
        <b style={{ color: FOG_COLOURS.sea }}>ϟ</b> to the sea
      </span>
      <span>
        <i class="swatch round" style={{ border: `2px solid ${FOG_COLOURS.cloud}` }} /> in the cloud
      </span>
      <span>fading over {FLASH_FOR} s</span>
    </p>
  );
}

/** The forecast layer's legend: a system's place at the tick shown and its track, a storm's, the fronts, a gale. */
function ForecastLegend() {
  return (
    <p class="small legend" data-field="forecast-legend">
      <span>
        <i class="swatch round" style={{ border: `2px solid ${FORECAST_COLOURS.system}` }} /> a
        system at the tick shown, and its track over the forecast's reach
      </span>
      <span>
        <i class="swatch round" style={{ border: `2px solid ${FORECAST_COLOURS.storm}` }} /> a
        storm's
      </span>
      <span>
        <i class="swatch" style={{ background: WEATHER_COLOURS.front }} /> a cold front
      </span>
      <span>
        <i class="swatch" style={{ background: WEATHER_COLOURS.warm }} /> a warm front
      </span>
      <span>
        <i
          class="swatch"
          style={{
            background: `repeating-linear-gradient(45deg, ${FORECAST_COLOURS.gale} 0 1px, transparent 1px 5px)`,
          }}
        />{' '}
        gale
      </span>
    </p>
  );
}

/** A tick of the world as a moment in a few words, by its week's epoch. */
function momentOf(w: WeatherWeek | null, tick: number): string {
  return w === null ? `tick ${tick}` : brief(w.epoch + (tick / w.ticksPerSecond) * 1000);
}

/** The forecast in force at the tick shown: its issue, its spells, its systems, its gale warning. */
function ForecastCard({
  f,
  w,
  now,
  goTo,
}: {
  f: ForecastPage;
  w: WeatherWeek | null;
  now: number;
  goTo: GoTo;
}) {
  const tps = w?.ticksPerSecond ?? 30;
  const minutes = (ticks: number): string => `${Math.round(ticks / tps / 60)} min`;
  const spell = spellAt(f.spells, f.at);
  const name = (k: number, id: string): string => w?.kinds[k]?.name || id || String(k);
  return (
    <section class="card" aria-label="The forecast">
      <h2>Forecast</h2>
      <p data-field="forecast-issue">
        Issued {momentOf(w, f.issue)} ({fromNow(f.issue - now, tps)}), tick {f.issue};{' '}
        {f.issued ? 'as the players were sent it' : "made on the page's asking from the week"};{' '}
        {f.steps} steps of {minutes(f.step)}; it knows the systems to {momentOf(w, f.until)}.
      </p>
      <p data-field="gale-warning" class={f.gale !== null ? 'gale' : ''}>
        {f.gale !== null
          ? `Gale warning: ${f.gale.words}. Force ${f.gale.force}, in force since ${momentOf(w, f.gale.key)}.`
          : 'No gale warning in force.'}
      </p>
      {spell !== null ? (
        <p data-field="spell-now">
          Spell now: {spell.id || spell.regime}, {spell.knots.toFixed(1)} kn from{' '}
          {spell.from.toFixed(0)}°.
        </p>
      ) : null}
      <ul class="spells small">
        {f.spells.map((s) => (
          <li key={s.begin}>
            {momentOf(w, s.begin)}: {s.id || s.regime}, {s.knots.toFixed(1)} kn from{' '}
            {s.from.toFixed(0)}°{s.shifts > 0 ? `, shifting ±${s.shifts.toFixed(0)}°` : ''}
            {s.front ? (s.warm ? ', by a warm front' : ', by a cold front') : ''}
          </li>
        ))}
      </ul>
      {f.systems.length > 0 ? (
        <table class="systems">
          <thead>
            <tr>
              <th>Kind</th>
              <th>At the tick shown</th>
              <th>Born</th>
              <th>Gone</th>
            </tr>
          </thead>
          <tbody>
            {f.systems.map((s) => {
              const at = trackAt(s, f.at, f.every);
              const first = s.track[0];
              const where = at ?? first;
              return (
                <tr key={`${s.slot}-${s.seed}`} data-forecast-system={s.slot}>
                  <td>
                    <button
                      type="button"
                      disabled={where === undefined}
                      onClick={() => where !== undefined && goTo(where[0], where[1])}
                    >
                      {name(s.kind, s.id)}
                    </button>
                    {s.length > 0 ? ` ${(s.length / 1852).toFixed(1)} M long` : ''}
                  </td>
                  <td>{at === null ? '—' : whereFrom(at[0], at[1])}</td>
                  <td>{fromNow(s.born - now, tps)}</td>
                  <td>{fromNow(s.gone - now, tps)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

/** How busy the world's weather has been: its figures from the week's opening to now, and over the whole week. */
function BusyCard({ b, w }: { b: BusyPage; w: WeatherWeek | null }) {
  return (
    <section class="card" aria-label="The busy weather">
      <h2>The busy weather</h2>
      <p class="small">
        Each minute from the week's opening, {momentOf(w, b.opening)}, the systems on the disk:{' '}
        {b.soFar.minutes} minutes so far of {b.week.minutes}.
      </p>
      <table class="busy" data-field="busy">
        <thead>
          <tr>
            <th />
            <th>So far</th>
            <th>The week</th>
          </tr>
        </thead>
        <tbody>
          {busyRows(b.soFar, b.week).map((r) => (
            <tr key={r.name}>
              <th>{r.name}</th>
              <td>{r.soFar}</td>
              <td>{r.week}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Every gale warning of the world, the latest first. */
function GalesCard({ g, w, goTo }: { g: GalesPage; w: WeatherWeek | null; goTo: GoTo }) {
  return (
    <section class="card" aria-label="Gale warnings">
      <h2>Gale warnings: {g.warnings.length}</h2>
      <ul class="gales" data-field="gales">
        {[...g.warnings].reverse().map((x) => (
          <li key={x.key} class={x.inForce ? 'chosen' : ''}>
            <button type="button" onClick={() => goTo(x.east, x.north, 4)}>
              {x.words}
            </button>{' '}
            <span class="small">
              force {x.force};{' '}
              {w === null ? `tick ${x.key}` : warningSpan(x, g.every, w.epoch, w.ticksPerSecond)}
              {x.inForce ? ', in force' : ''}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A place's box at the tick shown, as a chart gives it, and its outlook. */
function PlaceBox({ p }: { p: PlaceWeather }) {
  return (
    <div class="place-box" data-field="place-box">
      <p>
        <b>{p.name === '' ? 'The point' : p.name}</b>, {p.position}
      </p>
      <dl>
        <dt>Wind</dt>
        <dd data-field="box-wind">{p.box.wind}</dd>
        <dt>Gusts</dt>
        <dd>{p.box.gusts}</dd>
        <dt>Sky</dt>
        <dd>{p.box.sky}</dd>
        <dt>Visibility</dt>
        <dd>{p.box.visibility}</dd>
        <dt>Barometer</dt>
        <dd>{p.box.barometer}</dd>
      </dl>
      <p data-field="outlook">Outlook: {p.outlook}</p>
    </div>
  );
}

/** What is drawn and listed of a world's terrain, the same for its life. */
interface Drawn {
  islands: Island[];
  groups: Group[];
  start: [number, number][];
  current: Current | null;
  places: PlacesData | null;
  towns: Town[];
  features: FeaturesData | null;
  land: HTMLImageElement | null;
  coasts: HTMLImageElement | null;
  /** An island's drawing at the lattice's resolution, by number, once asked for. */
  islandImages: Map<number, HTMLImageElement>;
}

function noDrawn(): Drawn {
  return {
    islands: [],
    groups: [],
    start: [],
    current: null,
    places: null,
    towns: [],
    features: null,
    land: null,
    coasts: null,
    islandImages: new Map(),
  };
}

/** A drawing's address under prefix, the key on it so that a drawing of another world is never kept. */
function drawnAt(prefix: string, key: string, path: string): string {
  return drawing(`${prefix}${path}?world=${encodeURIComponent(key)}`);
}

/**
 * A world's terrain, read under prefix ("" for the current world's, "next/"
 * for the next's) once for each key it is given, and none for a null key:
 * a new key, for a new world or the next made again, reads it all again.
 * An island in view is drawn at the lattice's resolution when zoomed into.
 */
function useDrawn(
  prefix: string,
  key: string | null,
  view: View | null,
  setError: (e: string) => void,
): Drawn {
  const [drawn, setDrawn] = useState<Drawn>(noDrawn);
  const [, redraw] = useState(0);
  useEffect(() => {
    if (key === null) {
      setDrawn(noDrawn());
      return;
    }
    let live = true;
    const again = (): void => {
      if (live) {
        redraw((n) => n + 1);
      }
    };
    const fail = (e: unknown): void => {
      if (live) {
        setError(String(e));
      }
    };
    const set = (part: Partial<Drawn>): void => {
      if (live) {
        setDrawn((d) => ({ ...d, ...part }));
      }
    };
    setDrawn({
      ...noDrawn(),
      land: image(drawnAt(prefix, key, 'land.png'), again),
      coasts: image(drawnAt(prefix, key, 'coasts.svg'), again),
    });
    getJSON<{ islands: Island[]; groups: Group[]; start: [number, number][] }>(
      `${prefix}islands.json`,
    )
      .then((d) => set({ islands: d.islands, groups: d.groups, start: d.start }))
      .catch(fail);
    getJSON<Current>(`${prefix}current.json`)
      .then((current) => set({ current }))
      .catch(fail);
    getJSON<PlacesData>(`${prefix}places.json`)
      .then((places) => set({ places }))
      .catch(fail);
    getJSON<TownsData>(`${prefix}towns.json`)
      .then((d) => set({ towns: d.towns }))
      .catch(fail);
    getJSON<FeaturesData>(`${prefix}features.json`)
      .then((features) => set({ features }))
      .catch(fail);
    return () => {
      live = false;
    };
  }, [prefix, key, setError]);

  useEffect(() => {
    if (key === null || view === null || view.scale >= ISLAND_DETAIL) {
      return;
    }
    const [w, n] = toWorld(view, 0, 0);
    const [e, s] = toWorld(view, view.width, view.height);
    for (const is of drawn.islands) {
      const [bw, bs, be, bn] = is.bounds;
      if (be < w || bw > e || bn < s || bs > n || drawn.islandImages.has(is.number)) {
        continue;
      }
      drawn.islandImages.set(
        is.number,
        image(drawnAt(prefix, key, `island/${is.number}.svg`), () => redraw((c) => c + 1)),
      );
    }
  }, [prefix, key, view, drawn.islands, drawn.islandImages]);
  return drawn;
}

/** Centres a map on a point, at a scale if given. */
type GoTo = (east: number, north: number, scale?: number) => void;

/** Picks a point, and the island or place it was picked for, if one was. */
type Pick = (east: number, north: number, of?: PlaceOf) => void;

/** Sails the owner's chosen boat to what is named; null when no boat of theirs is chosen. */
type Sail = ((body: Record<string, number>, what: string) => void) | null;

function IslandsCard({
  islands,
  groups,
  features,
  goTo,
  pick,
}: {
  islands: Island[];
  groups: Group[];
  features: FeaturesData | null;
  goTo: GoTo;
  pick?: Pick;
}) {
  const featureName = new Map((features?.kinds ?? []).map((k) => [k.id, k.name]));
  return (
    <section class="card" aria-label="Islands">
      <h2>Islands: {islands.length}</h2>
      <ul class="islands">
        {islands
          .filter((is) => is.group < 0)
          .sort((a, b) => b.score - a.score)
          .map((is) => (
            <li key={is.number}>
              <button
                type="button"
                data-island={is.number}
                onClick={() => {
                  goTo(is.east, is.north, Math.max(0.5, is.across / 300));
                  pick?.(is.approach[0], is.approach[1], { island: is.number });
                }}
              >
                {is.number}. {is.name}
              </button>{' '}
              <span class="small">
                {formatPosition(is.east, is.north)}; {is.kind}, {is.biome}
                {is.age !== undefined ? ` (${is.age})` : ''}, {is.size}, {is.highest.toFixed(0)} m;{' '}
                <span data-field="class">
                  class {is.class}, {is.score.toFixed(1)}
                </span>
                {is.features.length > 0
                  ? `; ${is.features.map((k) => featureName.get(k) ?? k).join(', ')}`
                  : ''}
                {is.flora.length > 0 ? `; ${is.flora.join(', ')}` : ''}
              </span>
            </li>
          ))}
        {groups.map((g) => (
          <li key={`g${g.number}`}>
            <button type="button" onClick={() => goTo(g.east, g.north, 2)}>
              {g.name}
            </button>{' '}
            <span class="small">{g.members.length} rocks</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function LightsCard({
  places,
  light,
  choose,
  clock,
  shown,
}: {
  places: PlacesData | null;
  light: number | null;
  choose: (l: Light) => void;
  /** The world's clock the lights flash by; none for a world not yet begun. */
  clock?: { current: WorldClock };
  /** How each light shows now, in words, by number: sounding its fog signal, lit by day. */
  shown?: ReadonlyMap<number, string>;
}) {
  return (
    <section class="card" aria-label="Lighthouses">
      <h2>Lighthouses: {places?.lights.length ?? 0}</h2>
      <ul class="lights">
        {(places?.lights ?? []).map((l) => (
          <li key={l.number} class={l.number === light ? 'chosen' : ''}>
            {clock !== undefined ? (
              <>
                <Flash light={l} character={places?.characters[l.character]} clock={clock} />{' '}
              </>
            ) : null}
            <button type="button" data-light={l.number} onClick={() => choose(l)}>
              {l.name}
            </button>{' '}
            <span class="small" data-field="chart">
              {l.chart}, {l.role}
            </span>
            {shown?.has(l.number) === true ? (
              <span class="small light-now" data-field="light-now">
                {' '}
                {shown.get(l.number)}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function TownsCard({
  towns,
  plan,
  goTo,
  sail,
}: {
  towns: Town[];
  /** A town's plan's address. */
  plan: (number: number) => string;
  goTo: GoTo;
  sail: Sail;
}) {
  return (
    <section class="card" aria-label="Towns">
      <h2>Towns: {towns.length}</h2>
      <ul class="towns">
        {towns.map((t) => (
          <li key={t.number}>
            <button type="button" data-town={t.number} onClick={() => goTo(t.east, t.north, 2)}>
              {t.name}
            </button>{' '}
            <span class="small">
              {townWords(t)}{' '}
              <a href={plan(t.number)} target="_blank" rel="noopener">
                its plan
              </a>
            </span>
            {sail !== null && t.harbour !== null ? (
              <button
                type="button"
                class="small"
                onClick={() => sail({ town: t.number }, `teleport to ${t.name}'s harbour`)}
              >
                sail there
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function FeaturesCard({
  features,
  islands,
  goTo,
  pick,
  sail,
}: {
  features: FeaturesData | null;
  islands: Island[];
  goTo: GoTo;
  pick?: Pick;
  sail: Sail;
}) {
  const featureName = new Map((features?.kinds ?? []).map((k) => [k.id, k.name]));
  const islandName = new Map(islands.map((is) => [is.number, is.name]));
  return (
    <section class="card" aria-label="Features">
      <h2>Features: {features?.features.length ?? 0}</h2>
      <ul class="features">
        {(features?.features ?? []).map((f) => (
          <li key={f.number}>
            <button
              type="button"
              data-feature={f.number}
              onClick={() => {
                goTo(f.east, f.north, 1);
                if (f.approach !== null) {
                  pick?.(f.approach[0], f.approach[1]);
                }
              }}
            >
              {featureName.get(f.kind) ?? f.kind}
            </button>{' '}
            <span class="small">
              {islandName.get(f.island) ?? f.island}, {f.height.toFixed(0)} m
              {f.seen ? '' : ', not seen from the water'}
            </span>
            {sail !== null && f.approach !== null ? (
              <button
                type="button"
                class="small"
                onClick={() =>
                  sail(
                    { feature: f.number },
                    `teleport to see the ${featureName.get(f.kind) ?? f.kind}`,
                  )
                }
              >
                sail there
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PlacesCard({
  places,
  goTo,
  pick,
  sail,
}: {
  places: PlacesData | null;
  goTo: GoTo;
  pick?: Pick;
  sail: Sail;
}) {
  const kindName = new Map((places?.kinds ?? []).map((k) => [k.id, k.name]));
  const lightSite = new Set(
    (places?.kinds ?? []).filter((k) => k.site === 'light').map((k) => k.id),
  );
  const shown = (places?.places ?? []).filter((p) => !lightSite.has(p.kind));
  return (
    <section class="card" aria-label="Places">
      <h2>Places: {shown.length}</h2>
      <ul class="places">
        {shown.map((p) => (
          <li key={p.number}>
            <button
              type="button"
              data-place={p.number}
              onClick={() => {
                goTo(p.east, p.north, 1);
                if (p.approach !== null) {
                  pick?.(p.approach[0], p.approach[1], { place: p.number });
                }
              }}
            >
              {p.name}
            </button>{' '}
            <span class="small">
              {kindName.get(p.kind) ?? p.kind}: {placeWords(p)};{' '}
              <span data-field="place-position">{formatPosition(p.east, p.north)}</span>
            </span>
            {sail !== null && p.approach !== null ? (
              <button
                type="button"
                class="small"
                onClick={() => sail({ place: p.number }, `teleport to ${p.name}`)}
              >
                sail there
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function App() {
  const [now, setNow] = useState<WorldNow | null>(null);
  const [life, setLife] = useState<Life | null>(null);
  const [lifeError, setLifeError] = useState('');
  const [tab, setTab] = useState<'world' | 'next' | 'accounts'>('world');
  // The account whose card is open on the Accounts tab.
  const [card, setCard] = useState<string | null>(null);
  const [seenNext, setSeenNext] = useState(false);
  const [view, setView] = useState<View | null>(null);
  const [nextView, setNextView] = useState<View | null>(null);
  const [layers, setLayers] = useState<Layers>(allLayers());
  const [picked, setPicked] = useState<[number, number] | null>(null);
  const [pickedOf, setPickedOf] = useState<PlaceOf>(null);
  const [point, setPoint] = useState<Point | null>(null);
  const [placeWeather, setPlaceWeather] = useState<PlaceWeather | null>(null);
  const [forecast, setForecast] = useState<ForecastPage | null>(null);
  const [busy, setBusy] = useState<BusyPage | null>(null);
  const [gales, setGales] = useState<GalesPage | null>(null);
  const [pressure, setPressure] = useState<PressureAt | null>(null);
  const [sea, setSea] = useState<SeaPage | null>(null);
  const [clouds, setClouds] = useState<CloudsPage | null>(null);
  const [visibility, setVisibility] = useState<VisibilityPage | null>(null);
  const [boat, setBoat] = useState<number | null>(null);
  const [charted, setCharted] = useState<ChartedData | null>(null);
  const [accounts, setAccounts] = useState<AccountsData | null>(null);
  const [light, setLight] = useState<number | null>(null);
  const clock = useRef<WorldClock>({ worldTime: 0, at: performance.now() });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const gusts = useRef({ canvas: document.createElement('canvas'), drawn: false });
  const readLife = useRef<() => void>(() => undefined);
  const readCharted = useRef<() => void>(() => undefined);

  // The world being sailed, by its number: its terrain read again when
  // another world begins.
  const world = now?.world.number ?? life?.life.world ?? null;
  const next = life?.life.next ?? null;
  const cur = useDrawn('', world === null ? null : String(world), view, setError);
  // The next world's terrain, once its tab has been opened and while it
  // is stored: read again when it is made again.
  const nextKey = seenNext && next?.stored ? `${next.number}-${next.storedAt}` : null;
  const nxt = useDrawn('next/', nextKey, nextView, setError);
  // Each world's week of weather, at the tick shown: the current world's
  // following now, the next's at its beginning until the strip is dragged.
  const weather = useWeather('', world === null ? null : String(world), WEATHER_EVERY, setError);
  const nextWeather = useWeather('next/', nextKey, null, setError);
  // The tab shown: the next world's while there is one, the accounts, or
  // the world being sailed, whose live layers are read only while it shows.
  const onNext = tab === 'next' && next !== null;
  const onAccounts = tab === 'accounts';
  const onWorld = !onNext && !onAccounts;

  // What was picked of a world ended means nothing in the next.
  useEffect(() => {
    if (world === null) {
      return;
    }
    setPicked(null);
    setPickedOf(null);
    setPoint(null);
    setBoat(null);
    setLight(null);
    setTab((t) => (t === 'next' ? 'world' : t));
  }, [world]);

  // What is charted, every few seconds, and at once in a new world.
  useEffect(() => {
    if (world === null) {
      return;
    }
    const read = () => {
      if (hidden()) {
        return;
      }
      getJSON<ChartedData>('charted.json')
        .then(setCharted)
        .catch((e: unknown) => setError(String(e)));
      getJSON<AccountsData>('accounts.json')
        .then(setAccounts)
        .catch(() => setAccounts(null));
    };
    readCharted.current = read;
    read();
    const t = setInterval(read, CHARTED_EVERY);
    return () => clearInterval(t);
  }, [world]);

  // The world each second, paused while the tab is hidden.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const read = async (): Promise<void> => {
      timer = null;
      if (hidden()) {
        return;
      }
      try {
        const [w, g] = await Promise.all([getJSON<WorldNow>('world.json'), getBytes('gusts.bin')]);
        setNow(w);
        clock.current = { worldTime: w.worldTime, at: performance.now() };
        gustPicture(g, gusts.current.canvas);
        gusts.current.drawn = true;
        setError('');
      } catch (e) {
        setError(String(e));
      }
      if (!stopped && timer === null && !hidden()) {
        timer = setTimeout(read, EVERY);
      }
    };
    const shown = (): void => {
      if (!hidden() && timer === null) {
        void read();
      }
    };
    document.addEventListener('visibilitychange', shown);
    void read();
    return () => {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      document.removeEventListener('visibilitychange', shown);
    };
  }, []);

  // The world's life every few seconds, paused while the tab is hidden,
  // and at once after a control touching it. Keel's clock is measured
  // against the page's at each reading.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const read = async (): Promise<void> => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (hidden()) {
        return;
      }
      const sent = Date.now();
      try {
        const l = await getJSON<Lifecycle>('lifecycle.json');
        setLife({ life: l, offset: serverOffset(l.now, sent, Date.now()) });
        setLifeError('');
      } catch (e) {
        setLifeError(String(e));
      }
      if (!stopped && timer === null && !hidden()) {
        timer = setTimeout(read, LIFE_EVERY);
      }
    };
    const shown = (): void => {
      if (!hidden() && timer === null) {
        void read();
      }
    };
    readLife.current = () => void read();
    document.addEventListener('visibilitychange', shown);
    void read();
    return () => {
      stopped = true;
      readLife.current = () => undefined;
      if (timer !== null) {
        clearTimeout(timer);
      }
      document.removeEventListener('visibilitychange', shown);
    };
  }, []);

  // The pressure at the point picked, at the tick shown, read again with
  // the weather; none for a world with no weather.
  const shownAt = weather.weather?.at ?? null;
  const following = weather.at === null;
  useEffect(() => {
    if (picked === null || shownAt === null) {
      setPressure(null);
      return;
    }
    let live = true;
    getPressure(picked[0], picked[1], following ? null : shownAt)
      .then((p) => live && setPressure(p))
      .catch(() => live && setPressure(null));
    return () => {
      live = false;
    };
  }, [picked, shownAt, following]);

  // The box and outlook of the point, island or place picked, at the tick
  // shown, read again with the weather.
  useEffect(() => {
    if (picked === null || shownAt === null) {
      setPlaceWeather(null);
      return;
    }
    let live = true;
    getPlaceWeather(picked[0], picked[1], pickedOf, following ? null : shownAt)
      .then((p) => live && setPlaceWeather(p))
      .catch(() => live && setPlaceWeather(null));
    return () => {
      live = false;
    };
  }, [picked, pickedOf, shownAt, following]);

  // The forecast in force at the tick shown while its layer shows the
  // world being sailed, read again with the weather; and how well it has
  // held and the world's gale warnings every minute, paused while the tab
  // is hidden.
  const forecastShown = layers.forecast && world !== null && onWorld;
  useEffect(() => {
    if (!forecastShown || shownAt === null) {
      setForecast(null);
      return;
    }
    let live = true;
    getForecast(following ? null : shownAt)
      .then((f) => live && setForecast(f))
      .catch((e: unknown) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [forecastShown, shownAt, following]);
  useEffect(() => {
    if (!forecastShown) {
      setGales(null);
      return;
    }
    let live = true;
    const read = (): void => {
      if (hidden()) {
        return;
      }
      getGales()
        .then((g) => live && setGales(g))
        .catch((e: unknown) => live && setError(String(e)));
    };
    read();
    const t = setInterval(read, FORECAST_PAST_EVERY);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [forecastShown]);
  // How busy the weather has been, once a minute while the world being
  // sailed is shown.
  const busyShown = world !== null && onWorld;
  useEffect(() => {
    if (!busyShown) {
      setBusy(null);
      return;
    }
    let live = true;
    const read = (): void => {
      if (hidden()) {
        return;
      }
      getBusy()
        .then((b) => live && setBusy(b))
        .catch((e: unknown) => live && setError(String(e)));
    };
    read();
    const t = setInterval(read, FORECAST_PAST_EVERY);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [busyShown]);

  // The sea every ten seconds while its layer shows the world being
  // sailed, with the point picked, and at once for a point picked anew;
  // paused while the tab is hidden.
  const seaShown = layers.sea && world !== null && onWorld;
  useEffect(() => {
    if (!seaShown) {
      setSea(null);
      return;
    }
    let live = true;
    const read = (): void => {
      if (hidden()) {
        return;
      }
      getSea(picked)
        .then((s) => live && setSea(s))
        .catch((e: unknown) => live && setError(String(e)));
    };
    read();
    const t = setInterval(read, SEA_EVERY);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [seaShown, picked]);
  // The sea at the point picked, once the reading is of it.
  const seaPoint =
    sea?.point !== undefined &&
    picked !== null &&
    Math.abs(sea.point.east - picked[0]) < 0.01 &&
    Math.abs(sea.point.north - picked[1]) < 0.01
      ? sea.point
      : null;

  // The clouds and the rain every ten seconds while either layer shows the
  // world being sailed, and the point picked again, for its sky; paused
  // while the tab is hidden.
  const skyShown = (layers.cloud || layers.rain) && world !== null && onWorld;
  useEffect(() => {
    if (!skyShown) {
      setClouds(null);
      return;
    }
    let live = true;
    const read = (): void => {
      if (hidden()) {
        return;
      }
      getClouds()
        .then((c) => live && setClouds(c))
        .catch((e: unknown) => live && setError(String(e)));
      if (picked !== null) {
        getJSON<Point>(`point?east=${picked[0].toFixed(2)}&north=${picked[1].toFixed(2)}`)
          .then((p) => live && setPoint(p))
          .catch((e: unknown) => live && setError(String(e)));
      }
    };
    read();
    const t = setInterval(read, CLOUDS_EVERY);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [skyShown, picked]);
  // The sheets' picture, drawn once a reading.
  const sheets = useMemo(() => {
    if (clouds === null) {
      return null;
    }
    const c = document.createElement('canvas');
    sheetsPicture(clouds.sheets, c);
    return c;
  }, [clouds]);

  // The fog, the lightning and the lights every few seconds while the fog's
  // or the lightning's layer shows the world being sailed, and the point
  // picked again, for its visibility; paused while the tab is hidden.
  const fogShown = (layers.fog || layers.lightning) && world !== null && onWorld;
  useEffect(() => {
    if (!fogShown) {
      setVisibility(null);
      return;
    }
    let live = true;
    let reads = 0;
    const read = (): void => {
      if (hidden()) {
        return;
      }
      getVisibility()
        .then((v) => live && setVisibility(v))
        .catch((e: unknown) => live && setError(String(e)));
      // The point's visibility at the pace of the clouds', not of the lights'.
      if (picked !== null && reads++ % Math.round(CLOUDS_EVERY / VISIBILITY_EVERY) === 0) {
        getJSON<Point>(`point?east=${picked[0].toFixed(2)}&north=${picked[1].toFixed(2)}`)
          .then((p) => live && setPoint(p))
          .catch((e: unknown) => live && setError(String(e)));
      }
    };
    read();
    const t = setInterval(read, VISIBILITY_EVERY);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [fogShown, picked]);
  // The fog's picture and its very poor areas' outlines, made once a reading.
  const fog = useMemo(() => {
    if (visibility === null) {
      return null;
    }
    const c = document.createElement('canvas');
    fogPicture(visibility, c);
    return c;
  }, [visibility]);
  const fogOutlines = useMemo(
    () =>
      visibility === null
        ? []
        : outlinesUnder(visibility.grid, visibility.words[0], visibility.lip),
    [visibility],
  );
  // How the lights show now, in words: the lists made again only when it changes.
  const lightsKey = JSON.stringify(
    (visibility?.lights ?? [])
      .map((l) => [l.number, lightWords(l)] as const)
      .filter(([, w]) => w !== ''),
  );
  const lightsNow = useMemo(
    () => new Map<number, string>(JSON.parse(lightsKey) as [number, string][]),
    [lightsKey],
  );

  const pick = useCallback((east: number, north: number, of: PlaceOf = null): void => {
    setPicked([east, north]);
    setPickedOf(of);
    getJSON<Point>(`point?east=${east.toFixed(2)}&north=${north.toFixed(2)}`)
      .then(setPoint)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  /** Asks for a change and says how it went; true when it was done. */
  const act = useCallback(
    (path: Control, body: unknown, what: string): Promise<boolean> =>
      control(path, body)
        .then((a) => {
          setMessage(a.ok ? `Done: ${what}.` : `Refused (${a.status}): ${a.text}`);
          if (a.ok && (path === 'world' || path === 'next')) {
            // What was begun shows in the world's life within a few seconds.
            readLife.current();
            setTimeout(() => readLife.current(), 2000);
          }
          if (a.ok && (path === 'lifetime' || path.startsWith('accounts/'))) {
            // The lifetime and the grants it leaves live show at once, and
            // the accounts stopped.
            readCharted.current();
          }
          if (a.ok && path === 'chart') {
            // What is charted shows once its rows are written, within a second or two.
            readCharted.current();
            setTimeout(() => readCharted.current(), 2000);
          }
          return a.ok;
        })
        .catch((e: unknown) => {
          setMessage(`Failed: ${String(e)}`);
          return false;
        }),
    [],
  );

  const goTo = useCallback<GoTo>(
    (east, north, scale) => setView((v) => (v === null ? v : centreOn(v, east, north, scale))),
    [],
  );
  const goToNext = useCallback<GoTo>(
    (east, north, scale) => setNextView((v) => (v === null ? v : centreOn(v, east, north, scale))),
    [],
  );

  // An account's card opened from the world: on the Accounts tab.
  const openAccount = useCallback((id: string): void => {
    setCard(id);
    setTab('accounts');
  }, []);
  // A boat shown from its account's card: chosen on the world's tab, the map on it.
  const showBoat = useCallback(
    (b: number, east: number, north: number): void => {
      setTab('world');
      setBoat(b);
      goTo(east, north);
    },
    [goTo],
  );

  const data: MapData = {
    now,
    islands: cur.islands,
    groups: cur.groups,
    start: cur.start,
    current: cur.current,
    land: cur.land,
    coasts: cur.coasts,
    islandImages: cur.islandImages,
    gusts: gusts.current.drawn ? gusts.current.canvas : null,
    picked,
    boat,
    places: cur.places,
    light,
    features: cur.features,
    charted:
      charted === null ? null : new Set(charted.charted.map((c) => `${c.subject}:${c.number}`)),
    weather: weather.weather,
    forecast: forecastShown ? forecast : null,
    sea,
    clouds,
    sheets,
    visibility,
    fog,
    fogOutlines,
  };
  // The next world drawn as the current is, without what is live. The
  // disk's rings are keel's, not a world's: they are drawn from the
  // current world's reading, with no boat or wind of it.
  const nextData: MapData = {
    now: now === null ? null : { ...now, boats: [], wind: { ...now.wind, points: [] } },
    islands: nxt.islands,
    groups: nxt.groups,
    start: nxt.start,
    current: nxt.current,
    land: nxt.land,
    coasts: nxt.coasts,
    islandImages: nxt.islandImages,
    gusts: null,
    picked: null,
    boat: null,
    places: nxt.places,
    light: null,
    features: nxt.features,
    charted: null,
    weather: nextWeather.weather,
    forecast: null,
    sea: null,
    clouds: null,
    sheets: null,
    visibility: null,
    fog: null,
    fogOutlines: [],
  };
  const chosen = now?.boats.find((b) => b.boat === boat && b.tools) ?? null;

  // The lists of places and lights, made again only when what they show
  // changes, not at each second's reading of the world.
  const chosenBoat = chosen?.boat ?? null;
  const lists = useMemo(() => {
    const featureName = new Map((cur.features?.kinds ?? []).map((k) => [k.id, k.name]));
    const islandName = new Map(cur.islands.map((is) => [is.number, is.name]));
    const sail: Sail =
      chosenBoat === null
        ? null
        : (body, what) => void act('place', { boat: chosenBoat, ...body }, what);
    return (
      <>
        <IslandsCard
          islands={cur.islands}
          groups={cur.groups}
          features={cur.features}
          goTo={goTo}
          pick={pick}
        />
        <LightsCard
          places={cur.places}
          light={light}
          choose={(l) => {
            setLight(l.number);
            goTo(l.east, l.north, 4);
          }}
          clock={clock}
          shown={lightsNow}
        />
        <section class="card" aria-label="Charted">
          <h2>
            Charted: <span data-field="charted">{charted?.charted.length ?? 0}</span> of{' '}
            {charted?.subjects ?? 0}
          </h2>
          <ul class="charted">
            {[...(charted?.charted ?? [])].reverse().map((c) => {
              const at =
                c.subject === 'island'
                  ? cur.islands.find((is) => is.number === c.number)
                  : c.subject === 'place'
                    ? cur.places?.places.find((p) => p.number === c.number)
                    : cur.features?.features.find((f) => f.number === c.number);
              const title =
                c.subject === 'feature'
                  ? `${featureName.get((at as { kind?: string } | undefined)?.kind ?? '') ?? 'Feature'} on ${islandName.get((at as { island?: number } | undefined)?.island ?? -1) ?? '?'}`
                  : ((at as { name?: string } | undefined)?.name ?? `${c.subject} ${c.number}`);
              return (
                <li key={`${c.subject}:${c.number}`}>
                  <button
                    type="button"
                    data-charted={`${c.subject}:${c.number}`}
                    onClick={() => at !== undefined && goTo(at.east, at.north, 4)}
                  >
                    {title}
                  </button>{' '}
                  <span class="small">
                    {c.by === '' ? 'known' : <bdi>{c.by}</bdi>}
                    {c.ai ? ' (AI)' : ''}, {new Date(c.at).toLocaleString()}, worth{' '}
                    {c.worth.toFixed(1)}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
        <TownsCard
          towns={cur.towns}
          plan={(n) => drawnAt('', String(world), `town/${n}.svg`)}
          goTo={goTo}
          sail={sail}
        />
        <FeaturesCard
          features={cur.features}
          islands={cur.islands}
          goTo={goTo}
          pick={pick}
          sail={sail}
        />
        <PlacesCard places={cur.places} goTo={goTo} pick={pick} sail={sail} />
      </>
    );
  }, [cur, world, light, chosenBoat, charted, act, goTo, pick, lightsNow]);

  // The next world's lists, as the current world's are, with nothing to sail to.
  const nextLists = useMemo(
    () => (
      <>
        <IslandsCard
          islands={nxt.islands}
          groups={nxt.groups}
          features={nxt.features}
          goTo={goToNext}
        />
        <LightsCard places={nxt.places} light={null} choose={(l) => goToNext(l.east, l.north, 4)} />
        <TownsCard
          towns={nxt.towns}
          plan={(n) => drawnAt('next/', nextKey ?? '', `town/${n}.svg`)}
          goTo={goToNext}
          sail={null}
        />
        <FeaturesCard features={nxt.features} islands={nxt.islands} goTo={goToNext} sail={null} />
        <PlacesCard places={nxt.places} goTo={goToNext} sail={null} />
      </>
    ),
    [nxt, nextKey, goToNext],
  );

  return (
    <div class="page">
      <header>
        <h1>The world</h1>
        <p class="note">The owner's page: reached from this computer alone.</p>
        {error !== '' ? <p class="error">{error}</p> : null}
        {message !== '' ? (
          <p class="message" role="status">
            {message}
          </p>
        ) : null}
        <SwitchBar life={life} error={lifeError} />
        <nav class="tabs" aria-label="Which tab">
          <button
            type="button"
            name="tab-world"
            aria-pressed={onWorld}
            onClick={() => setTab('world')}
          >
            World {world}
          </button>
          {next !== null ? (
            <button
              type="button"
              name="tab-next"
              aria-pressed={onNext}
              onClick={() => {
                setTab('next');
                setSeenNext(true);
              }}
            >
              Next: world {next.number}
              {next.stored ? '' : ', being made'}
            </button>
          ) : null}
          <button
            type="button"
            name="tab-accounts"
            aria-pressed={onAccounts}
            onClick={() => setTab('accounts')}
          >
            Accounts
          </button>
        </nav>
      </header>
      <AccountsTab
        accounts={accounts}
        shown={onAccounts}
        chosen={card}
        open={setCard}
        showBoat={showBoat}
        act={act}
      />
      {onAccounts ? null : (
        <main>
          <div class="map-box">
            {onNext ? (
              next.stored ? (
                <MapCanvas
                  key="next"
                  data={nextData}
                  layers={layers}
                  view={nextView}
                  setView={setNextView}
                  pick={() => undefined}
                />
              ) : (
                <p class="map waiting" data-field="next-waiting">
                  World {next.number} is being made.
                </p>
              )
            ) : (
              <MapCanvas
                key="world"
                data={data}
                layers={layers}
                view={view}
                setView={setView}
                pick={pick}
              />
            )}
            <fieldset class="layers">
              {(Object.keys(LAYER_NAMES) as (keyof Layers)[])
                .filter((k) => !onNext || !LIVE.has(k))
                .map((k) => (
                  <label key={k}>
                    <input
                      type="checkbox"
                      name={`layer-${k}`}
                      checked={layers[k]}
                      onChange={(e) => setLayers({ ...layers, [k]: e.currentTarget.checked })}
                    />{' '}
                    {LAYER_NAMES[k]}
                  </label>
                ))}
              <button
                type="button"
                onClick={() => {
                  const set = onNext ? setNextView : setView;
                  set((v) => (v === null ? v : fitView(v.width, v.height)));
                }}
              >
                The whole disk
              </button>
              {seaShown ? <SeaLegend /> : null}
              {skyShown && layers.cloud ? <CloudLegend /> : null}
              {skyShown && layers.rain ? <RainLegend words={clouds?.words ?? WMO_WORDS} /> : null}
              {fogShown && layers.fog ? <FogLegend words={visibility?.words ?? MET_WORDS} /> : null}
              {fogShown && layers.lightning ? <LightningLegend /> : null}
              {forecastShown ? <ForecastLegend /> : null}
            </fieldset>
            {!onNext && point !== null ? (
              <p class="point" data-field="point">
                <span data-field="point-position">{point.position}</span> ({point.east.toFixed(0)},{' '}
                {point.north.toFixed(0)}):{' '}
                {point.elevation > 0
                  ? `land ${point.elevation.toFixed(1)} m high`
                  : `${(-point.elevation).toFixed(1)} m deep`}
                , {point.fromLip.toFixed(0)} m inside the lip, {point.off.toFixed(0)} m from{' '}
                {point.island}.{point.water !== '' ? ` No boat here: ${point.water}.` : ''}
                {pressure !== null ? (
                  <span data-field="pressure">
                    {' '}
                    {pressure.hPa.toFixed(1)} hPa, {pressure.tendency} (
                    {pressure.change >= 0 ? '+' : ''}
                    {pressure.change.toFixed(1)} in 15 min).
                  </span>
                ) : null}
                {seaShown && seaPoint !== null ? (
                  <span data-field="sea"> Sea: {seaWords(seaPoint)}.</span>
                ) : null}
                {skyShown && point.sky !== null ? (
                  <span data-field="sky"> Sky: {skyWords(point.sky)}.</span>
                ) : null}
                {point.sky !== null ? (
                  <span data-field="visibility"> Visibility: {visibilityWords(point.sky)}.</span>
                ) : null}
              </p>
            ) : null}
            {!onNext && placeWeather !== null ? <PlaceBox p={placeWeather} /> : null}
          </div>
          {onNext ? (
            <aside>
              {life !== null ? <LifecycleCard life={life} /> : null}
              {life !== null ? (
                <WorldByHand life={life} charted={charted} act={act} hands={['make']} />
              ) : null}
              {next.stored ? (
                <WeekCard
                  w={nextWeather.weather}
                  now={nextWeather.weather?.now ?? 0}
                  at={nextWeather.at}
                  show={nextWeather.show}
                  goTo={goToNext}
                />
              ) : null}
              {next.stored ? nextLists : null}
            </aside>
          ) : (
            <aside>
              {now !== null ? <Clock now={now} accounts={accounts} /> : null}
              {now !== null ? <WeatherCard now={now} /> : null}
              <WeekCard
                w={weather.weather}
                now={now?.tick ?? weather.weather?.now ?? 0}
                at={weather.at}
                show={weather.show}
                goTo={goTo}
              />
              {forecastShown && forecast !== null ? (
                <ForecastCard
                  f={forecast}
                  w={weather.weather}
                  now={now?.tick ?? weather.weather?.now ?? 0}
                  goTo={goTo}
                />
              ) : null}
              {onWorld && busy !== null ? <BusyCard b={busy} w={weather.weather} /> : null}
              {forecastShown && gales !== null ? (
                <GalesCard g={gales} w={weather.weather} goTo={goTo} />
              ) : null}
              {life !== null ? (
                <WorldByHand
                  life={life}
                  charted={charted}
                  act={act}
                  hands={['make', 'begin', 'chart']}
                />
              ) : null}
              {life !== null ? <LifecycleCard life={life} /> : null}
              <section class="card" aria-label="Boats at sea">
                <h2>At sea: {now?.boats.length ?? 0}</h2>
                {now !== null ? <AdmissionLines a={now.admission} /> : null}
                <table class="boats">
                  <thead>
                    <tr>
                      <th>Boat</th>
                      <th>Sailor</th>
                      <th>Kind</th>
                      <th>Position</th>
                      <th>Speed</th>
                      <th>Inside the lip</th>
                      <th />
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {(now?.boats ?? []).map((b) => (
                      <BoatRow
                        key={b.boat}
                        b={b}
                        chosen={b.boat === boat}
                        choose={() => {
                          setBoat(b.boat);
                          goTo(b.east, b.north);
                        }}
                        account={openAccount}
                        act={act}
                        picked={picked}
                        islands={cur.islands}
                      />
                    ))}
                  </tbody>
                </table>
              </section>
              <section class="card" aria-label="The queue">
                <h2>Waiting: {now?.queue.length ?? 0}</h2>
                {now !== null ? (
                  <p class="small" data-field="spectators">
                    {spectatorsLine(now.spectators)}.
                  </p>
                ) : null}
                <Queue
                  title="Humans"
                  field="humans-waiting"
                  queue={(now?.queue ?? []).filter((q) => !q.machine)}
                  act={act}
                  account={openAccount}
                />
                <Queue
                  title="Machine sailors"
                  field="machines-waiting"
                  queue={(now?.queue ?? []).filter((q) => q.machine)}
                  act={act}
                  account={openAccount}
                />
              </section>
              {lists}
            </aside>
          )}
        </main>
      )}
    </div>
  );
}

/** What a town has, in a few words: its buildings, the most of its kinds, its piers and moorings. */
export function townWords(t: Town): string {
  const kind =
    t.kind === 'main' ? 'Port Royal' : t.kind === 'port' ? 'a port' : 'a fishing village';
  const most = Object.entries(t.counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, n]) => `${n} ${k.toLowerCase()}`)
    .join(', ');
  const piers =
    t.piers.length > 0 ? `; ${t.piers.length} piers to ${Math.max(...t.piers).toFixed(0)} m` : '';
  const moorings = t.moorings > 0 ? `; ${t.moorings} moorings` : '';
  return `${kind}: ${t.buildings} buildings (${most})${piers}${moorings}.`;
}

const root = document.getElementById('app');
if (root !== null) {
  render(<App />, root);
}
