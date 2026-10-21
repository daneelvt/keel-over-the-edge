// SPDX-License-Identifier: AGPL-3.0-only

// The developer panel, with ?dev. Online, the connection's numbers: the
// clock's offset, the round trip, how far ahead the boat is stepped, the
// arrival margins, corrections and bytes each way. Offline, the sandbox's
// wind and the sea it raises: one of four sea states at once, another fetch
// than open water's, a second wind to the east to see two seas meet, or flat
// water; the boat, reset to the start or placed at a position and heading,
// and a jump to the rim; time, paused, stepped once or slowed; the live State
// and Out; the sail since the panel opened or the last reset, recorded as a
// golden scenario to download; camera presets; the back end, the render
// scale, the tile pass and the antialiasing; the quality: the rung of the
// ladder in use, adaptive quality on or off and the steps it took, and the
// detail band, the foam and the wakes each on or off; the sky's hour, moon
// and speed, and where the sun, the moon and the stars stand (skypanel.ts),
// offline and online; and the frame statistics. It is a lazy import,
// outside the game's first download. Built as nodes and text, never markup.

import { PILOT_HEADING, PILOT_OFF, type PilotControl, TURN_STEPS } from '../input/pilot';
import './panel.css';
import { catalog } from '../catalog';
import { type MistParams, visualRangeAt } from '../edge/mist';
import type { FleetStats } from '../game/fleet';
import type { Game } from '../game/game';
import type { LandStats } from '../land/land';
import type { BumpTold, Traffic } from '../net/messages';
import type { Online } from '../net/online';
import { foamOn } from '../ocean/foam';
import { detailOn } from '../ocean/seamaterial';
import { RECORDS, SEA, SEA_SPEED_STEP, WEATHER } from '../predict/layout.gen';
import { type Physics, SEA_PARTS } from '../predict/physics';
import type { Predictor } from '../predict/predictor';
import type { BoatWind } from '../predict/weather';
import { DISK_RADIUS } from '../render/coords';
import { rungName } from '../render/quality';
import { CAMERA_PRESETS, type SeaScene } from '../render/scene';
import { look } from '../render/sky';
import type { Antialias } from '../render/stage';
import { type SeaOptions, seaAreaOf } from '../sandbox/localsea';
import { FRONT, type Sandbox, SEA_STATES, STEADY } from '../sandbox/sandbox';
import { tackText } from '../ui/verdict';
import { skyPanel } from './skypanel';

const KNOT = 1852 / 3600;
const DEG = Math.PI / 180;
const NAUTICAL_MILE = 1852;
/** "Jump to the rim" puts the boat this far from the centre, in metres. */

/** Where the current at the boat is written, east then north. */
const currentAt = [0, 0];
export const RIM = 8300;
/** Fetches to try, in nautical miles; null is open water's. The look was chosen at 1.5, 4, 6.5 and 9. */
export const FETCHES: (number | null)[] = [null, 1.5, 4, 6.5, 9];
export const SCALES: (number | null)[] = [null, 0.5, 0.75, 1, 1.5, 2];
/** Slow motion: the rates real time counts at. */
export const SPEEDS = [1, 0.5, 0.25];

/** What the panel shows and sets, in the units it shows them in. */
export interface PanelState {
  /** The fetch, in nautical miles, or null for open water's. */
  fetch: number | null;
  /** A second wind east of the boat, in knots, or null for one sea. */
  split: number | null;
  /** Flat water, whatever the wind. */
  flat: boolean;
  east: number;
  north: number;
  /** Clockwise from north, in degrees. */
  heading: number;
  /** The weather: steady, or the id of one of the catalog's regimes. */
  weather: string;
  /** The latest spell's wind at mid-disk, 10 m up, in knots, and where it comes from, in degrees. */
  windSpeed: number;
  windFrom: number;
  /** Whether a regime's spell has its gusts, and its shifts. */
  gusts: boolean;
  shifts: boolean;
  antialias: Antialias;
  /** The render scale; null for the back end's default. */
  scale: number | null;
  pass: boolean;
  paused: boolean;
  /** Slow motion: 1, ½ or ¼. */
  speed: number;
}

/** The parts of the scene, the sandbox and the loop the panel drives, so tests can stand in for them. */
export interface PanelWorld {
  usePass: boolean;
  stage: {
    antialias: Antialias;
    scale: number | null;
    setAntialias(a: Antialias): void;
    setScale(s: number | null): void;
  };
  setUsePass(on: boolean): void;
  sandbox: {
    /** The latest spell, a spell record's values; its weather; and what of it is on. */
    readonly spell: ArrayLike<number>;
    readonly regime: string;
    readonly tuning: { readonly gusts: boolean; readonly shifts: boolean };
    readonly states: { readonly current: Float64Array };
    readonly sea: { readonly options: SeaOptions };
    /** The weather of an id, as a server's developer sets it. */
    setWeather(id: string): void;
    /** Changes the latest spell: its wind (m/s, radians), its gusts, its shifts. */
    tune(change: { speed?: number; from?: number; gusts?: boolean; shifts?: boolean }): void;
    /** A steady wind (m/s, radians) at once, as if it had blown for ever. */
    steadyNow(speed: number, from: number): void;
    /** Raises the sea the weather and the options give, at once. */
    settleSea(): void;
    place(east: number, north: number, heading: number): void;
  };
  loop: { paused: boolean; speed: number };
}

function degrees(rad: number): number {
  const d = rad / DEG;
  return ((d % 360) + 360) % 360;
}

/** A spell's wind at mid-disk in m/s, and where it comes from at its start in radians. */
function spellWind(spell: ArrayLike<number>): { speed: number; from: number } {
  return {
    speed: (spell[RECORDS.spell.speed] ?? 0) * SEA_SPEED_STEP,
    from: ((spell[RECORDS.spell.from] ?? 0) / WEATHER.turnSteps) * 2 * Math.PI,
  };
}

const tenth = (x: number): number => Math.round(x * 10) / 10;

export function readState(w: PanelWorld): PanelState {
  const s = w.sandbox.states.current;
  const sea = w.sandbox.sea.options;
  const wind = spellWind(w.sandbox.spell);
  return {
    fetch: sea.fetch === null ? null : sea.fetch / NAUTICAL_MILE,
    split: sea.split === null ? null : sea.split.wind.speed / KNOT,
    flat: sea.flat,
    east: s[RECORDS.state.x] ?? 0,
    north: s[RECORDS.state.y] ?? 0,
    heading: degrees(s[RECORDS.state.heading] ?? 0),
    weather: w.sandbox.regime,
    // To a tenth: a spell's wind is in whole steps, which are not whole knots or degrees.
    windSpeed: tenth(wind.speed / KNOT),
    windFrom: tenth(degrees(wind.from)) % 360,
    gusts: w.sandbox.tuning.gusts,
    shifts: w.sandbox.tuning.shifts,
    antialias: w.stage.antialias,
    scale: w.stage.scale,
    pass: w.usePass,
    paused: w.loop.paused,
    speed: w.loop.speed,
  };
}

/** Applies to the world whatever differs from the state. */
export function applyState(w: PanelWorld, s: PanelState): void {
  const now = readState(w);
  if (s.weather !== now.weather) {
    w.sandbox.setWeather(s.weather);
  } else {
    const change: { speed?: number; from?: number; gusts?: boolean; shifts?: boolean } = {};
    if (s.windSpeed !== now.windSpeed) {
      change.speed = Math.max(0, s.windSpeed) * KNOT;
    }
    if (tenth(degrees(s.windFrom * DEG)) % 360 !== now.windFrom) {
      change.from = degrees(s.windFrom * DEG) * DEG;
    }
    if (s.gusts !== now.gusts) {
      change.gusts = s.gusts;
    }
    if (s.shifts !== now.shifts) {
      change.shifts = s.shifts;
    }
    if (Object.keys(change).length > 0) {
      w.sandbox.tune(change);
    }
  }
  if (s.east !== now.east || s.north !== now.north || s.heading !== now.heading) {
    w.sandbox.place(s.east, s.north, s.heading * DEG);
  }
  if (s.fetch !== now.fetch || s.split !== now.split || s.flat !== now.flat) {
    const sea = w.sandbox.sea.options;
    sea.fetch = s.fetch === null ? null : s.fetch * NAUTICAL_MILE;
    sea.flat = s.flat;
    // The second wind begins at the line of centres east of the boat, and
    // blows from where the first does.
    sea.split =
      s.split === null
        ? null
        : {
            column: seaAreaOf(w.sandbox.states.current[RECORDS.state.x] ?? 0) + 1,
            wind: { speed: Math.max(0, s.split) * KNOT, from: spellWind(w.sandbox.spell).from },
          };
    w.sandbox.settleSea();
  }
  if (s.antialias !== w.stage.antialias) {
    w.stage.setAntialias(s.antialias);
  }
  if (s.scale !== w.stage.scale) {
    w.stage.setScale(s.scale);
  }
  if (s.pass !== w.usePass) {
    w.setUsePass(s.pass);
  }
  w.loop.paused = s.paused;
  w.loop.speed = s.speed;
}

/** The state in one of the sea states the look was chosen in: its wind, steady, and its sea at once. */
export function inSeaState(w: PanelWorld, name: string): void {
  const knots = SEA_STATES[name];
  if (knots === undefined) {
    return;
  }
  w.sandbox.steadyNow(knots * KNOT, spellWind(w.sandbox.spell).from);
  w.sandbox.sea.options.flat = false;
  w.sandbox.settleSea();
}

/**
 * The wind at the boat, as a line: the mean wind, the wind with its gust,
 * the gust factor, the gust field and how far the gust veers the wind.
 */
export function windLine(w: Readonly<BoatWind>): string {
  const veer = (((w.from - w.meanFrom) / DEG + 540) % 360) - 180;
  const sign = (x: number, digits: number): string =>
    `${x < 0 ? '−' : '+'}${Math.abs(x).toFixed(digits)}`;
  const line =
    `wind    mean ${(w.meanSpeed / KNOT).toFixed(1)} kn from ${degrees(w.meanFrom).toFixed(0).padStart(3, '0')}°, ` +
    `now ${(w.speed / KNOT).toFixed(1)} kn (×${w.factor.toFixed(2)}), gust ${sign(w.gust, 2)}, veer ${sign(veer, 1)}°`;
  if (w.shadowSpeed === w.speed && w.shadowFrom === w.from) {
    return line;
  }
  // In another boat's wake: what is left of the wind, and how far it turned.
  const lost = w.speed > 0 ? 1 - w.shadowSpeed / w.speed : 0;
  const turn = (((w.shadowFrom - w.from) / DEG + 540) % 360) - 180;
  return `${line}\nshadow  ${(w.shadowSpeed / KNOT).toFixed(1)} kn, ${(100 * lost).toFixed(0)}% lost, turned ${sign(turn, 1)}°`;
}

/** The weather at the boat, as a line: the pressure there, and the systems placed. */
export function weatherLine(
  physics: Physics,
  tick: number,
  east: number,
  north: number,
  systems: number,
): string {
  physics.windDrawAt(tick);
  return `weather ${physics.pressure(east, north).toFixed(1)} hPa, ${systems} system${systems === 1 ? '' : 's'} placed`;
}

/**
 * The sea's partitions under the boat: the wind sea's height and peak
 * period, the swell's and the direction it comes from (degrees), how much
 * the current raises the waves, and the share the land's lee leaves.
 */
export function partsLine(
  windHs: number,
  windPeak: number,
  swellHs: number,
  swellPeak: number,
  swellFrom: number,
  current: number,
  lee: number,
): string {
  const period = (peak: number): string =>
    peak > 0 ? `${((2 * Math.PI) / peak).toFixed(1)} s` : '—';
  const swell =
    swellHs > 0
      ? `swell ${swellHs.toFixed(2)} m ${period(swellPeak)} from ${Math.round(swellFrom).toString().padStart(3, '0')}°`
      : 'no swell';
  return `parts   wind sea ${windHs.toFixed(2)} m ${period(windPeak)}, ${swell}, current ×${current.toFixed(2)}, lee ×${lee.toFixed(2)}`;
}

/** The sea under the boat, as lines: its height, its peak, and the waves summed. */
export function seaLines(hs: number, peak: number, waves: number, blended: boolean): string {
  if (waves === 0) {
    return 'sea     flat';
  }
  const period = peak > 0 ? `${((2 * Math.PI) / peak).toFixed(1)} s` : '—';
  return `sea     Hs ${hs.toFixed(2)} m, peak ${period}, ${waves} waves${blended ? ', blended' : ''}`;
}

/** What the edge's line reads: the lip and the mist, the falls' draft. */
export interface EdgeNumbers {
  lip: number;
  mist: MistParams;
  /** The falls' draft: from where, m from the centre, and its speed at the lip, m/s. */
  draftFrom: number;
  draft: number;
  /** The clear air's visual range, m. */
  clear: number;
  /** The falls' slabs drawn, and the curtain's triangles. */
  slabs: number;
  curtain: number;
  /** The tick the boat went over, 0 afloat. */
  over: number;
}

/**
 * The boat at the edge, as lines: how far inside the lip it is, the current
 * at it (the drain out and the circulation round), the falls' draft, the
 * mist's visual range there, and the falls drawn.
 */
export function edgeLines(
  east: number,
  north: number,
  current: number[],
  e: EdgeNumbers,
): string[] {
  const r = Math.hypot(east, north);
  const [ce = 0, cn = 0] = current;
  const out = r > 0 ? (ce * east + cn * north) / r : 0;
  const round = r > 0 ? (ce * north - cn * east) / r : 0;
  const draft = e.draft * Math.min(Math.max((r - e.draftFrom) / (e.lip - e.draftFrom), 0), 1);
  const range = visualRangeAt(r, e.clear, e.mist);
  return [
    `edge    ${e.over !== 0 ? `over the lip since tick ${e.over}` : `${(e.lip - r).toFixed(0)} m inside the lip`}`,
    `current drain ${(out / KNOT).toFixed(2)} kn, round ${(round / KNOT).toFixed(2)} kn; draft ${(draft / KNOT).toFixed(2)} kn`,
    `mist    visual range ${range >= 1000 ? `${(range / 1000).toFixed(1)} km` : `${range.toFixed(0)} m`}; falls ${e.slabs} slabs, ${e.curtain} triangles`,
  ];
}

/** The edge's numbers for the panel, from the scene and the catalog. */
function edgeNumbers(world: SeaScene, over: number): EdgeNumbers {
  const disk = catalog.weather.disk;
  const counts = world.edge.falls.counts;
  return {
    lip: world.edge.lip,
    mist: world.edge.mist,
    draftFrom: disk.fallDraftFrom * 1852,
    draft: disk.fallDraft * KNOT,
    clear: look.visualRange.value as number,
    slabs: counts.slabs,
    curtain: counts.curtainTriangles,
    over,
  };
}

/** The state with the boat moved out to the rim along its bearing from the centre (east, from the centre itself). */
export function toRim(s: PanelState): PanelState {
  const d = Math.hypot(s.east, s.north);
  const [e, n] = d < 1 ? [1, 0] : [s.east / d, s.north / d];
  const r = Math.min(RIM, DISK_RADIUS);
  return { ...s, east: e * r, north: n * r };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (text !== undefined) {
    n.textContent = text;
  }
  return n;
}

function row(label: string, control: HTMLElement): HTMLLabelElement {
  const l = el('label');
  l.append(el('span', label), control);
  return l;
}

function select<T>(
  options: T[],
  name: (o: T) => string,
  current: T,
  on: (o: T) => void,
): HTMLSelectElement {
  const s = el('select');
  options.forEach((o, i) => {
    const opt = el('option', name(o));
    opt.value = String(i);
    opt.selected = o === current;
    s.append(opt);
  });
  s.addEventListener('change', () => on(options[Number(s.value)] as T));
  return s;
}

function number(value: number, step: number, on: (v: number) => void): HTMLInputElement {
  const i = el('input');
  i.type = 'number';
  i.step = String(step);
  i.value = String(Math.round(value * 100) / 100);
  i.addEventListener('change', () => {
    const v = Number(i.value);
    if (Number.isFinite(v)) {
      on(v);
    }
  });
  return i;
}

function button(text: string, on: () => void): HTMLButtonElement {
  const b = el('button', text);
  b.type = 'button';
  b.addEventListener('click', on);
  return b;
}

/** Offers a recording as a file to download. */
function download(name: string, data: unknown): void {
  const blob = new Blob([`${JSON.stringify(data, null, 1)}\n`], { type: 'application/json' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function fields(record: Record<string, number>, view: Float64Array): string {
  return Object.entries(record)
    .map(([name, i]) => `${name.padEnd(18)}${(view[i] ?? 0).toFixed(4)}`)
    .join('\n');
}

export function openPanel(
  world: SeaScene,
  game: Game,
  sandbox: Sandbox,
  parent: HTMLElement,
): void {
  const pw: PanelWorld = {
    get usePass() {
      return world.usePass;
    },
    stage: world.stage,
    setUsePass: (on) => world.setUsePass(on),
    sandbox,
    loop: game.loop,
  };
  // Record the sail from here, so it can be downloaded as a golden scenario.
  sandbox.record();
  const panel = el('aside');
  panel.className = 'dev-panel';
  const body = el('div');
  const stats = el('pre');
  const log = el('pre');
  const records = el('pre');
  const seaCheck = el('pre');
  const sky = skyPanel(world);
  panel.append(
    button('Developer', () => body.toggleAttribute('hidden')),
    body,
  );
  parent.append(panel);
  // The GPU's sea against the server's, on this device.
  const checkSea = button('Check the sea', () => {
    seaCheck.textContent = 'checking…';
    import('./seacheck')
      .then(async (m) => {
        seaCheck.textContent = m.seaCheckLines(await m.checkSeaOnGPU(world, game, sandbox));
      })
      .catch((err: unknown) => {
        seaCheck.textContent = err instanceof Error ? err.message : String(err);
      })
      .finally(() => render());
  });

  const set = (change: Partial<PanelState>): void => {
    applyState(pw, { ...readState(pw), ...change });
    render();
  };

  const render = (): void => {
    const s = readState(pw);
    const gfx = world.stage.gfx;
    const query = new URLSearchParams(location.search);
    const toWebGL = gfx?.backend !== 'webgl2';
    if (toWebGL) {
      query.set('backend', 'webgl2');
    } else {
      query.delete('backend');
    }
    const swap = el('a', toWebGL ? 'Reload on WebGL 2' : 'Reload on WebGPU');
    swap.href = `?${query.toString()}`;

    const cameras = el('div');
    cameras.className = 'buttons';
    for (const [name, preset] of Object.entries(CAMERA_PRESETS)) {
      cameras.append(button(name, () => world.placeCamera(preset)));
    }
    const time = el('div');
    time.className = 'buttons';
    time.append(
      button(s.paused ? 'Run' : 'Pause', () => set({ paused: !s.paused })),
      button('Step', () => {
        game.stepOnce();
      }),
      select(
        SPEEDS,
        (x) => (x === 1 ? 'full speed' : x === 0.5 ? '½ speed' : '¼ speed'),
        s.speed,
        (speed) => set({ speed }),
      ),
    );
    const boat = el('div');
    boat.className = 'buttons';
    boat.append(
      button('Reset to the start', () => {
        sandbox.reset();
        render();
      }),
      button('Jump to the rim', () => set(toRim(readState(pw)))),
      // The free camera, as F flies it: the boat stays where it is.
      button('Free camera (F)', () => game.toggleFly()),
    );
    const states = el('div');
    states.className = 'buttons';
    for (const name of Object.keys(SEA_STATES)) {
      states.append(
        button(name, () => {
          inSeaState(pw, name);
          render();
        }),
      );
    }
    const recording = button('Download the sail', () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      download(`sail-${stamp}`, sandbox.recorded(`sail-${stamp}`));
    });

    const spell = el('div');
    spell.className = 'buttons';
    if (s.weather !== STEADY) {
      spell.append(
        button(s.gusts ? 'Gusts on' : 'Gusts off', () => set({ gusts: !s.gusts })),
        button(s.shifts ? 'Shifts on' : 'Shifts off', () => set({ shifts: !s.shifts })),
      );
    }
    body.replaceChildren(
      row(
        'Weather',
        select(
          [
            STEADY,
            FRONT,
            ...catalog.weather.regimes.map((r) => r.id),
            ...catalog.weather.systems.map((k) => k.id),
          ],
          (x) => x,
          s.weather,
          (weather) => set({ weather }),
        ),
      ),
      row('Spell', spell),
      row(
        'Wind, kn',
        number(s.windSpeed, 1, (windSpeed) => set({ windSpeed })),
      ),
      row(
        'Wind from, °',
        number(s.windFrom, 10, (windFrom) => set({ windFrom })),
      ),
      row(
        'East, m',
        number(s.east, 10, (east) => set({ east })),
      ),
      row(
        'North, m',
        number(s.north, 10, (north) => set({ north })),
      ),
      row(
        'Heading, °',
        number(s.heading, 5, (heading) => set({ heading })),
      ),
      boat,
      row('Time', time),
      row(`Recording, ${sandbox.recorder.steps} steps`, recording),
      row('Sea state', states),
      row(
        'Fetch',
        select(
          FETCHES,
          (x) => (x === null ? 'open water' : `${x} NM`),
          s.fetch,
          (fetch) => set({ fetch }),
        ),
      ),
      row(
        'Wind to the east, kn',
        select(
          [null, 6, 12, 20, 34],
          (x) => (x === null ? 'the same' : String(x)),
          s.split,
          (split) => set({ split }),
        ),
      ),
      row(
        'Water',
        select(
          [false, true],
          (x) => (x ? 'flat' : 'waves'),
          s.flat,
          (flat) => set({ flat }),
        ),
      ),
      row('Camera', cameras),
      row(
        'Antialiasing',
        select<Antialias>(
          ['fxaa', 'smaa', 'none'],
          (x) => x.toUpperCase(),
          s.antialias,
          (antialias) => set({ antialias }),
        ),
      ),
      row(
        'Render scale',
        select(
          SCALES,
          (x) => (x === null ? `auto (${world.stage.pixelRatio()})` : String(x)),
          s.scale,
          (scale) => set({ scale }),
        ),
      ),
      row(
        'Tile pass',
        select(
          [true, false],
          (x) => (x ? 'on' : 'off: per vertex'),
          s.pass,
          (pass) => set({ pass }),
        ),
      ),
      row(
        'Back end',
        el('span', gfx === null ? '…' : `${gfx.backend}${gfx.compat ? ' (compatibility)' : ''}`),
      ),
      swap,
      row(
        'Quality',
        select(
          (world.quality?.ladder ?? []).map((_, i) => i),
          (i) => rungName(world.quality?.ladder[i] ?? world.rung),
          world.quality?.index ?? 0,
          (i) => {
            void world.setRung(i, 'panel').then(render);
          },
        ),
      ),
      row(
        'Adaptive',
        select(
          [true, false],
          (x) => (x ? 'on' : 'off'),
          world.quality?.enabled ?? false,
          (on) => {
            if (world.quality !== null) {
              world.quality.enabled = on;
            }
            render();
          },
        ),
      ),
      row(
        'Detail band',
        select(
          [1, 0],
          (x) => (x === 1 ? 'on' : 'off'),
          detailOn.value,
          (v) => {
            detailOn.value = v;
          },
        ),
      ),
      row(
        'Foam',
        select(
          [1, 0],
          (x) => (x === 1 ? 'on' : 'off'),
          foamOn.value,
          (v) => {
            foamOn.value = v;
          },
        ),
      ),
      row(
        'Wakes',
        select(
          [true, false],
          (x) => (x ? 'on' : 'off'),
          world.ocean.drawWakes,
          (on) => {
            world.ocean.drawWakes = on;
            if (!on) {
              world.ocean.wakes.clear();
            }
          },
        ),
      ),
      row('The GPU’s sea', checkSea),
      seaCheck,
      ...sky.elements,
      stats,
      log,
      records,
    );
  };

  let shown = 0;
  const prev = world.onFrame;
  world.onFrame = () => {
    prev?.();
    const now = performance.now();
    if (now - shown < 500) {
      return;
    }
    shown = now;
    sky.update();
    const st = world.stats.last;
    const p = world.pose;
    const o = world.origin;
    const cap = world.stage.cap;
    const gpu = st.gpu === null ? 'no timestamps' : `${st.gpu.toFixed(2)} ms`;
    // The sea of the area the boat is in, in the window drawn.
    const band = world.ocean.band;
    const slot = world.ocean.slot;
    const held = sandbox.seas.held[slot];
    let here = 0;
    let peak = 0;
    let parts = 'parts   —';
    if (held !== undefined) {
      const col = Math.min(Math.max(seaAreaOf(p.east) - held.col, 0), held.size - 1);
      const row = Math.min(Math.max(seaAreaOf(p.north) - held.row, 0), held.size - 1);
      here = row * held.size + col;
      peak = sandbox.physics.seaPeak(slot)[here] ?? 0;
      const v = sandbox.physics.seaParts(slot);
      const at = here * SEA_PARTS;
      const still = v[at + 4] ?? 0;
      parts = partsLine(
        v[at] ?? 0,
        v[at + 1] ?? 0,
        v[at + 2] ?? 0,
        v[at + 3] ?? 0,
        ((held.swellFrom[here] ?? 0) * 360) / SEA.fromSteps,
        still > 0 ? (sandbox.physics.seaHs(slot)[here] ?? 0) / still : 1,
        sandbox.physics.leeAt(slot, p.east, p.north),
      );
    }
    stats.textContent = [
      `frame   ${st.median.toFixed(1)} ms median, ${st.p90.toFixed(1)} ms 90th (${st.frames} in 2 s)`,
      `work    ${st.workMedian.toFixed(2)} ms median, ${st.workP90.toFixed(2)} ms 90th`,
      `display ${cap.rate.toFixed(0)} Hz, drawing every ${cap.divisor} (cap ${cap.limit})`,
      `gpu     ${gpu}`,
      `draws   ${st.drawCalls}, ${st.dispatches} dispatches, ${st.triangles.toLocaleString('en')} triangles`,
      `scale   ${world.stage.pixelRatio().toFixed(2)}${world.stage.gfx?.floatTargets === false ? ', no float targets' : ''}`,
      `tier    ${rungName(world.rung)}${world.quality?.enabled ? ', adaptive' : ', held'} (wait ${((world.quality?.wait ?? 0) / 1000).toFixed(0)} s)`,
      `detail  ${detailLine(world)}`,
      `boat    ${p.east.toFixed(0)} E, ${p.north.toFixed(0)} N`,
      `origin  ${o.world.x.toFixed(0)} E, ${o.world.y.toFixed(0)} N, tile ${o.centre.q},${o.centre.r}`,
      `time    ${game.clock.time.toFixed(2)} s, step ${game.clock.steps}`,
      seaLines(band.hs[here] ?? 0, peak, band.count, band.blended),
      parts,
      windLine(sandbox.wind),
      weatherLine(sandbox.physics, sandbox.tick, p.east, p.north, sandbox.systems),
      pilotLine(game.pilot, sandbox.states.current, sandbox.out),
      ...edgeLines(
        p.east,
        p.north,
        sandbox.physics.current(p.east, p.north, currentAt),
        edgeNumbers(world, sandbox.over),
      ),
    ].join('\n');
    log.textContent = ['Steps', ...world.qualityLog().slice(-8)].join('\n');
    records.textContent = [
      'State',
      fields(RECORDS.state, sandbox.states.current),
      '',
      'Out',
      fields(RECORDS.out, sandbox.out),
    ].join('\n');
  };
  render();
}

const WAYS = ['holding', 'tacking', 'gybing'];

/**
 * The autopilot, as a line: its mode and target, how far it has to turn,
 * its standing helm (toward the wind) and the way it turns.
 */
export function pilotLine(p: PilotControl, state: Float64Array, out: Float64Array): string {
  if (p.mode === PILOT_OFF) {
    return 'pilot   off';
  }
  const target = Math.round((p.target / TURN_STEPS) * 3600) / 10;
  const mode =
    p.mode === PILOT_HEADING
      ? `heading ${target.toFixed(1)}°`
      : `wind ${(target > 180 ? target - 360 : target).toFixed(1)}°`;
  const off = ((out[RECORDS.out.pilotOff] ?? 0) * 180) / Math.PI;
  const trim = state[RECORDS.state.pilotTrim] ?? 0;
  const way = WAYS[state[RECORDS.state.pilotWay] ?? 0] ?? '?';
  return `pilot   ${mode}, ${off.toFixed(2)}° to turn, standing helm ${trim.toFixed(3)}, ${way}, order ${p.order}`;
}

/** The detail band, as a line: how it is made, and how long the low tier's loops took to make. */
function detailLine(world: SeaScene): string {
  const d = world.ocean.detail.state;
  const under = world.ocean.under;
  const wind = `${(under.speed / KNOT).toFixed(1)} kn, fetch ${(under.fetch / NAUTICAL_MILE).toFixed(1)} NM`;
  const bake =
    d.kind === 'baked'
      ? `, ${d.baked ? 'made' : 'making'} in ${d.bakeSpent.toFixed(0)} ms (longest slice ${d.bakeLongest.toFixed(1)} ms)`
      : '';
  return `${d.kind}${bake}; ${wind}`;
}

/** What the connection's part of the panel shows. */
export interface NetNumbers {
  status: string;
  offsetMs: number;
  rttMs: number;
  m: number;
  margin: number;
  counts: {
    snapshots: number;
    corrections: number;
    resets: number;
    stale: number;
    largest: number;
  };
  p95: number;
  traffic: Traffic;
  /** The other boats, and the latest snapshot's size in bytes. */
  fleet: FleetStats;
  snapshotBytes: number;
  /** The wind at the boat, with any shadow; how many wakes reach it. */
  wind?: Readonly<BoatWind>;
  wakes?: number;
  /** The boat's course as the Articles follow it: tack, tacking, ticks settled, course. */
  course?: Readonly<Float64Array>;
  /** The last bump told, and how long ago, s. */
  bump?: { told: BumpTold; ago: number } | null;
  /** The land, and the chunks in the module's slots. */
  land?: LandStats | null;
  slots?: number[] | null;
}

/** The connection's numbers, as lines. */
export function netLines(n: NetNumbers): string {
  const c = n.counts;
  const t = n.traffic;
  const f = n.fleet;
  return [
    `status            ${n.status}`,
    `clock offset      ${n.offsetMs.toFixed(1)} ms`,
    `round trip        ${n.rttMs.toFixed(0)} ms`,
    `ahead (m)         ${n.m} ticks`,
    `last margin       ${n.margin === -32768 ? '—' : `${n.margin} ticks`}`,
    `snapshots         ${c.snapshots}`,
    `corrections       ${c.corrections} (largest ${c.largest.toFixed(3)} m, 95th ${n.p95.toFixed(3)} m)`,
    `resets, stale     ${c.resets}, ${c.stale}`,
    `bytes in, out     ${t.bytesIn}, ${t.bytesOut}`,
    `messages in, out  ${t.messagesIn}, ${t.messagesOut}`,
    `boats near, far   ${f.near}, ${f.far} (${f.fading} fading)`,
    `carried on, held  ${f.extrapolated}, ${f.held}`,
    `delays            ${f.nearDelay.toFixed(0)} ms near, ${f.farDelay.toFixed(0)} ms far (lateness spread ${f.spread.toFixed(0)} ms)`,
    `entries           ${f.entries.toFixed(1)} a second`,
    `snapshot          ${n.snapshotBytes} bytes`,
    `resyncs           ${t.resyncs}`,
    ...encounterLines(n),
    ...landLines(n.land ?? null, n.slots ?? null),
  ].join('\n');
}

/** The land's lines: the chunks handed, had and drawn, the worker's counts and times. */
export function landLines(s: LandStats | null, slots: number[] | null): string[] {
  if (s === null) {
    return [];
  }
  return [
    `land chunks       ${s.handed} handed, ${s.grids} held, ${s.meshes} built, ${s.drawn} drawn, ${s.inFlight} asked`,
    `land fetched      ${s.fetched} from the network (${(s.bytes / 1024).toFixed(0)} KB), ${s.cached} from the cache, ${s.failed} failed`,
    `land times        fetch ${s.fetchMs.toFixed(1)} ms, unpack ${s.unpackMs.toFixed(1)} ms, build ${s.buildMs.toFixed(1)} ms (slowest ${s.slowestBuild.toFixed(1)} ms)`,
    `land drawn        ${s.triangles} triangles`,
    `module's chunks   ${slots === null ? 'none: open sea' : slots.map((n) => (n < 0 ? '—' : n)).join(' ')}`,
  ];
}

/** The encounters' lines: the wind with its shadow, the course, the last bump. */
function encounterLines(n: NetNumbers): string[] {
  const lines: string[] = [];
  if (n.wind !== undefined) {
    lines.push(windLine(n.wind), `wakes             ${n.wakes ?? 0} reaching the boat`);
  }
  const c = n.course;
  if (c !== undefined && (c[0] ?? 0) !== 0) {
    const settled = (c[2] ?? 0) >= 65536 ? 'long' : `${((c[2] ?? 0) / 30).toFixed(1)} s`;
    lines.push(
      `course            ${tackText(c[0] ?? 1, (c[1] ?? 0) !== 0).toLowerCase()}, tack settled ${settled}, ` +
        `course ${degrees(c[3] ?? 0)
          .toFixed(0)
          .padStart(3, '0')}°`,
    );
  }
  const b = n.bump;
  if (b !== undefined && b !== null) {
    const t = b.told;
    lines.push(
      `last bump         ${b.ago.toFixed(0)} s ago, ${t.part}${t.article === '' ? '' : `, Article ${t.article}`}, ` +
        `${t.closing.toFixed(2)} m/s, at ${t.east.toFixed(1)} E ${t.north.toFixed(1)} N`,
    );
  }
  return lines;
}

/**
 * The developer panel online: the connection's numbers, twice a second, and
 * the sky, which it can move for this page alone.
 */
export function openNetPanel(
  world: SeaScene,
  online: Online,
  predictor: Predictor,
  parent: HTMLElement,
): void {
  const panel = el('aside');
  panel.className = 'dev-panel';
  const body = el('div');
  const numbers = el('pre');
  const sky = skyPanel(world);
  body.append(numbers, ...sky.elements);
  panel.append(
    button('Connection', () => body.toggleAttribute('hidden')),
    body,
  );
  parent.append(panel);
  let lastBump: { told: BumpTold; at: number } | null = null;
  const told = online.onBump;
  online.onBump = (b) => {
    lastBump = { told: b, at: performance.now() };
    told?.(b);
  };
  const update = (): void => {
    sky.update();
    numbers.textContent = netLines({
      status: online.status.value,
      offsetMs: online.clock.offset / 1000,
      rttMs: online.clock.rtt / 1000,
      m: online.ahead.m,
      margin: online.lastMargin,
      counts: predictor.counts,
      p95: predictor.p95(),
      traffic: online.traffic,
      fleet: online.fleet.stats,
      snapshotBytes: online.snapshotBytes,
      wind: predictor.wind,
      wakes: predictor.wakes.reaching,
      course: world.rightOfWay.ownCourse,
      bump:
        lastBump === null
          ? null
          : { told: lastBump.told, ago: (performance.now() - lastBump.at) / 1000 },
      land: world.land?.stats ?? null,
      slots: world.land?.slots?.chunks ?? null,
    });
    const p = world.pose;
    numbers.textContent += `\n${edgeLines(
      p.east,
      p.north,
      predictor.physics.current(p.east, p.north, currentAt),
      edgeNumbers(world, predictor.over),
    ).join('\n')}`;
  };
  update();
  setInterval(update, 500);
}
