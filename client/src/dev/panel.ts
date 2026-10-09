// SPDX-License-Identifier: AGPL-3.0-only

// The developer panel, with ?dev. Online, the connection's numbers: the
// clock's offset, the round trip, how far ahead the boat is stepped, the
// arrival margins, corrections and bytes each way. Offline, the sandbox's wind; the boat, reset to
// the start or placed at a position and heading, and a jump to the rim;
// time, paused, stepped once or slowed; the live State and Out; the sail
// since the panel opened or the last reset, recorded as a golden scenario
// to download; the test
// sea; camera presets; the back end, the render scale, the tile pass and the
// antialiasing; and the frame statistics. It is a lazy import, outside the
// game's first download. Built as nodes and text, never markup.

import './panel.css';
import type { Game } from '../game/game';
import type { Online } from '../net/online';
import { RECORDS } from '../predict/layout.gen';
import type { Predictor } from '../predict/predictor';
import { DISK_RADIUS } from '../render/coords';
import { CAMERA_PRESETS, type SeaScene } from '../render/scene';
import type { Antialias } from '../render/stage';
import type { Sandbox } from '../sandbox/sandbox';

const KNOT = 1852 / 3600;
const DEG = Math.PI / 180;
/** "Jump to the rim" puts the boat this far from the centre, in metres. */
export const RIM = 8300;
export const SEAS = ['flat', 'calm', 'breeze', 'fresh', 'gale'];
export const SCALES: (number | null)[] = [null, 0.5, 0.75, 1, 1.5, 2];
/** Slow motion: the rates real time counts at. */
export const SPEEDS = [1, 0.5, 0.25];

/** What the panel shows and sets, in the units it shows them in. */
export interface PanelState {
  sea: string;
  east: number;
  north: number;
  /** Clockwise from north, in degrees. */
  heading: number;
  /** The wind 10 m up, in knots, and where it comes from, in degrees. */
  windSpeed: number;
  windFrom: number;
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
  testSea: string;
  usePass: boolean;
  stage: {
    antialias: Antialias;
    scale: number | null;
    setAntialias(a: Antialias): void;
    setScale(s: number | null): void;
  };
  setTestSea(name: string): void;
  setUsePass(on: boolean): void;
  sandbox: {
    readonly wind: { speed: number; from: number };
    readonly states: { readonly current: Float64Array };
    setWind(speed: number, from: number): void;
    place(east: number, north: number, heading: number): void;
  };
  loop: { paused: boolean; speed: number };
}

function degrees(rad: number): number {
  const d = rad / DEG;
  return ((d % 360) + 360) % 360;
}

export function readState(w: PanelWorld): PanelState {
  const s = w.sandbox.states.current;
  return {
    sea: w.testSea,
    east: s[RECORDS.state.x] ?? 0,
    north: s[RECORDS.state.y] ?? 0,
    heading: degrees(s[RECORDS.state.heading] ?? 0),
    windSpeed: w.sandbox.wind.speed / KNOT,
    windFrom: degrees(w.sandbox.wind.from),
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
  if (s.sea !== w.testSea) {
    w.setTestSea(s.sea);
  }
  if (s.windSpeed !== now.windSpeed || s.windFrom !== now.windFrom) {
    w.sandbox.setWind(Math.max(0, s.windSpeed) * KNOT, degrees(s.windFrom * DEG) * DEG);
  }
  if (s.east !== now.east || s.north !== now.north || s.heading !== now.heading) {
    w.sandbox.place(s.east, s.north, s.heading * DEG);
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
    get testSea() {
      return world.testSea;
    },
    get usePass() {
      return world.usePass;
    },
    stage: world.stage,
    setTestSea: (n) => world.setTestSea(n),
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
  const records = el('pre');
  panel.append(
    button('Developer', () => body.toggleAttribute('hidden')),
    body,
  );
  parent.append(panel);

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
    );
    const recording = button('Download the sail', () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      download(`sail-${stamp}`, sandbox.recorded(`sail-${stamp}`));
    });

    body.replaceChildren(
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
      row(
        'Test sea',
        select(
          SEAS,
          (x) => x,
          s.sea,
          (sea) => set({ sea }),
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
      stats,
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
    const st = world.stats.last;
    const p = world.pose;
    const o = world.origin;
    const cap = world.stage.cap;
    const gpu = st.gpu === null ? 'no timestamps' : `${st.gpu.toFixed(2)} ms`;
    stats.textContent = [
      `frame   ${st.median.toFixed(1)} ms median, ${st.p90.toFixed(1)} ms 90th (${st.frames} in 2 s)`,
      `work    ${st.workMedian.toFixed(2)} ms median, ${st.workP90.toFixed(2)} ms 90th`,
      `display ${cap.rate.toFixed(0)} Hz, drawing every ${cap.divisor} (cap ${cap.limit})`,
      `gpu     ${gpu}`,
      `draws   ${st.drawCalls}, ${st.triangles.toLocaleString('en')} triangles`,
      `scale   ${world.stage.pixelRatio()}${world.stage.gfx?.floatTargets === false ? ', no float targets' : ''}`,
      `boat    ${p.east.toFixed(0)} E, ${p.north.toFixed(0)} N`,
      `origin  ${o.world.x.toFixed(0)} E, ${o.world.y.toFixed(0)} N, tile ${o.centre.q},${o.centre.r}`,
      `time    ${game.clock.time.toFixed(2)} s, step ${game.clock.steps}`,
    ].join('\n');
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
  traffic: { bytesIn: number; bytesOut: number; messagesIn: number; messagesOut: number };
}

/** The connection's numbers, as lines. */
export function netLines(n: NetNumbers): string {
  const c = n.counts;
  const t = n.traffic;
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
  ].join('\n');
}

/** The developer panel online: the connection's numbers, twice a second. */
export function openNetPanel(online: Online, predictor: Predictor, parent: HTMLElement): void {
  const panel = el('aside');
  panel.className = 'dev-panel';
  const body = el('pre');
  panel.append(
    button('Connection', () => body.toggleAttribute('hidden')),
    body,
  );
  parent.append(panel);
  const update = (): void => {
    body.textContent = netLines({
      status: online.status.value,
      offsetMs: online.clock.offset / 1000,
      rttMs: online.clock.rtt / 1000,
      m: online.ahead.m,
      margin: online.lastMargin,
      counts: predictor.counts,
      p95: predictor.p95(),
      traffic: online.traffic,
    });
  };
  update();
  setInterval(update, 500);
}
