// SPDX-License-Identifier: AGPL-3.0-only

// The world page: the map, and beside it the world's clock, the weather,
// the boats at sea and in the queue, and the islands. It reads the world
// once a second, and not while its tab is hidden. A click on the map picks
// a point: what is there is told, and the owner's boats can be put there.
// The page acts on the owner's boats alone; the server refuses the rest.

import { render } from 'preact';
import {
  type Dispatch,
  type StateUpdater,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'preact/hooks';
import {
  type Boat,
  type Current,
  control,
  drawing,
  type Group,
  getBytes,
  getJSON,
  type Island,
  type Point,
  type WorldNow,
} from './api';
import {
  allLayers,
  drawMap,
  gustPicture,
  ISLAND_DETAIL,
  LAYER_NAMES,
  type Layers,
  type MapData,
} from './draw';
import { centreOn, fitView, pan, toWorld, type View, zoomAt } from './map';

/** How often the page reads the world, ms. */
export const EVERY = 1000;

/** Whether the page's tab is hidden: it reads nothing then. */
function hidden(): boolean {
  return document.visibilityState === 'hidden';
}

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
    const ctx = c?.getContext('2d');
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

function Clock({ now }: { now: WorldNow }) {
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

/** A boat's row, and for the owner's its controls. */
function BoatRow({
  b,
  chosen,
  choose,
  act,
  picked,
  islands,
}: {
  b: Boat;
  chosen: boolean;
  choose: () => void;
  act: (path: 'flag' | 'place' | 'unseen', body: unknown, what: string) => void;
  picked: [number, number] | null;
  islands: Island[];
}) {
  const [island, setIsland] = useState(0);
  const marks = [
    b.falling ? 'falling' : '',
    b.connected ? '' : `in its grace, ${seconds(b.grace)}`,
    b.stays ? 'staying' : '',
    b.unseen ? 'unseen' : '',
    b.eye !== null ? 'roaming' : '',
  ].filter((m) => m !== '');
  return (
    <>
      <tr class={chosen ? 'chosen' : ''} onClick={choose} data-boat={b.boat}>
        <td>{b.boat}</td>
        <td>
          {b.sailor || '—'}
          {b.human ? '' : ' (AI)'}
        </td>
        <td>{b.kind}</td>
        <td>{b.knots.toFixed(1)} kn</td>
        <td>{b.fromLip.toFixed(0)} m</td>
        <td>{marks.join(', ')}</td>
        <td>
          <label>
            <input
              type="checkbox"
              name="flag"
              checked={b.tools}
              disabled={!b.human}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) =>
                act(
                  'flag',
                  { account: b.account, on: e.currentTarget.checked },
                  `${b.sailor}'s flag`,
                )
              }
            />{' '}
            owner
          </label>
        </td>
      </tr>
      {chosen && b.tools ? (
        <tr class="controls">
          <td colSpan={7}>
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

function App() {
  const [now, setNow] = useState<WorldNow | null>(null);
  const [islands, setIslands] = useState<Island[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [start, setStart] = useState<[number, number][]>([]);
  const [current, setCurrent] = useState<Current | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [layers, setLayers] = useState<Layers>(allLayers());
  const [picked, setPicked] = useState<[number, number] | null>(null);
  const [point, setPoint] = useState<Point | null>(null);
  const [boat, setBoat] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [, redraw] = useState(0);
  const images = useRef({
    land: null as HTMLImageElement | null,
    coasts: null as HTMLImageElement | null,
    islands: new Map<number, HTMLImageElement>(),
    gusts: document.createElement('canvas'),
    hasGusts: false,
  });
  const again = useCallback(() => redraw((n) => n + 1), []);

  // Once per world: the land, the coasts, the islands, the current.
  useEffect(() => {
    const im = images.current;
    im.land = image(drawing('land.png'), again);
    im.coasts = image(drawing('coasts.svg'), again);
    getJSON<{ islands: Island[]; groups: Group[]; start: [number, number][] }>('islands.json')
      .then((d) => {
        setIslands(d.islands);
        setGroups(d.groups);
        setStart(d.start);
      })
      .catch((e: unknown) => setError(String(e)));
    getJSON<Current>('current.json')
      .then(setCurrent)
      .catch((e: unknown) => setError(String(e)));
  }, [again]);

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
        gustPicture(g, images.current.gusts);
        images.current.hasGusts = true;
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

  // An island zoomed into, at the lattice's resolution.
  useEffect(() => {
    if (view === null || view.scale >= ISLAND_DETAIL) {
      return;
    }
    const im = images.current;
    const [w, n] = toWorld(view, 0, 0);
    const [e, s] = toWorld(view, view.width, view.height);
    for (const is of islands) {
      const [bw, bs, be, bn] = is.bounds;
      if (be < w || bw > e || bn < s || bs > n || im.islands.has(is.number)) {
        continue;
      }
      im.islands.set(is.number, image(drawing(`island/${is.number}.svg`), again));
    }
  }, [view, islands, again]);

  const pick = (east: number, north: number): void => {
    setPicked([east, north]);
    getJSON<Point>(`point?east=${east.toFixed(2)}&north=${north.toFixed(2)}`)
      .then(setPoint)
      .catch((e: unknown) => setError(String(e)));
  };

  const act = (path: 'flag' | 'place' | 'unseen', body: unknown, what: string): void => {
    control(path, body)
      .then((a) => setMessage(a.ok ? `Done: ${what}.` : `Refused (${a.status}): ${a.text}`))
      .catch((e: unknown) => setMessage(`Failed: ${String(e)}`));
  };

  const im = images.current;
  const data: MapData = {
    now,
    islands,
    groups,
    start,
    current,
    land: im.land,
    coasts: im.coasts,
    islandImages: im.islands,
    gusts: im.hasGusts ? im.gusts : null,
    picked,
    boat,
  };
  const goTo = (east: number, north: number, scale?: number): void => {
    if (view !== null) {
      setView(centreOn(view, east, north, scale));
    }
  };

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
      </header>
      <main>
        <div class="map-box">
          <MapCanvas data={data} layers={layers} view={view} setView={setView} pick={pick} />
          <fieldset class="layers">
            {(Object.keys(LAYER_NAMES) as (keyof Layers)[]).map((k) => (
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
              onClick={() => view !== null && setView(fitView(view.width, view.height))}
            >
              The whole disk
            </button>
          </fieldset>
          {point !== null ? (
            <p class="point" data-field="point">
              ({point.east.toFixed(0)}, {point.north.toFixed(0)}):{' '}
              {point.elevation > 0
                ? `land ${point.elevation.toFixed(1)} m high`
                : `${(-point.elevation).toFixed(1)} m deep`}
              , {point.fromLip.toFixed(0)} m inside the lip, {point.off.toFixed(0)} m from{' '}
              {point.island}.{point.water !== '' ? ` No boat here: ${point.water}.` : ''}
            </p>
          ) : null}
        </div>
        <aside>
          {now !== null ? <Clock now={now} /> : null}
          {now !== null ? <WeatherCard now={now} /> : null}
          <section class="card" aria-label="Boats at sea">
            <h2>At sea: {now?.boats.length ?? 0}</h2>
            <table class="boats">
              <thead>
                <tr>
                  <th>Boat</th>
                  <th>Sailor</th>
                  <th>Kind</th>
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
                    act={act}
                    picked={picked}
                    islands={islands}
                  />
                ))}
              </tbody>
            </table>
          </section>
          <section class="card" aria-label="The queue">
            <h2>Waiting: {now?.queue.length ?? 0}</h2>
            <table>
              <tbody>
                {(now?.queue ?? []).map((q) => (
                  <tr key={q.account}>
                    <td>{q.sailor || '—'}</td>
                    <td>{seconds(q.waited)}</td>
                    <td>{q.connected ? '' : 'away'}</td>
                    <td>
                      <label>
                        <input
                          type="checkbox"
                          name="flag"
                          checked={q.tools}
                          onChange={(e) =>
                            act(
                              'flag',
                              { account: q.account, on: e.currentTarget.checked },
                              `${q.sailor}'s flag`,
                            )
                          }
                        />{' '}
                        owner
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section class="card" aria-label="Islands">
            <h2>Islands: {islands.length}</h2>
            <ul class="islands">
              {islands
                .filter((is) => is.group < 0)
                .map((is) => (
                  <li key={is.number}>
                    <button
                      type="button"
                      data-island={is.number}
                      onClick={() => {
                        goTo(is.east, is.north, Math.max(0.5, is.across / 300));
                        pick(is.approach[0], is.approach[1]);
                      }}
                    >
                      {is.number}. {is.name}
                    </button>{' '}
                    <span class="small">
                      {is.kind}, {is.biome}, {is.size}, {is.highest.toFixed(0)} m
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
        </aside>
      </main>
    </div>
  );
}

const root = document.getElementById('app');
if (root !== null) {
  render(<App />, root);
}
