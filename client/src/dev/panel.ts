// SPDX-License-Identifier: AGPL-3.0-only

// The developer panel, with ?dev: the test sea; the boat's position, speed
// and heading (it moves along a straight line); a jump to the rim; camera
// presets matching the waves rendering's views; the back end, the render
// scale, the tile pass and the antialiasing; and the frame statistics. It
// is a lazy import, outside the game's first download. Built as nodes and
// text, never markup.

import './panel.css';
import { DISK_RADIUS } from '../render/coords';
import { CAMERA_PRESETS, type SeaScene } from '../render/scene';
import type { Antialias } from '../render/stage';

const KNOT = 1852 / 3600;
/** "Jump to the rim" puts the boat this far from the centre, in metres. */
export const RIM = 8300;
export const SEAS = ['flat', 'calm', 'breeze', 'fresh', 'gale'];
export const SCALES: (number | null)[] = [null, 0.5, 0.75, 1, 1.5, 2];

/** What the panel shows and sets, in the units it shows them in. */
export interface PanelState {
  sea: string;
  east: number;
  north: number;
  /** Clockwise from north, in degrees. */
  heading: number;
  /** In knots. */
  speed: number;
  antialias: Antialias;
  /** The render scale; null for the back end's default. */
  scale: number | null;
  pass: boolean;
}

/** The part of the scene the panel drives, so tests can stand in for it. */
export interface PanelWorld {
  testSea: string;
  usePass: boolean;
  boatState: { east: number; north: number; heading: number; speed: number };
  stage: {
    antialias: Antialias;
    scale: number | null;
    setAntialias(a: Antialias): void;
    setScale(s: number | null): void;
  };
  setTestSea(name: string): void;
  setUsePass(on: boolean): void;
  placeBoat(east: number, north: number): void;
}

export function readState(w: PanelWorld): PanelState {
  const degrees = (w.boatState.heading * 180) / Math.PI;
  return {
    sea: w.testSea,
    east: w.boatState.east,
    north: w.boatState.north,
    heading: ((degrees % 360) + 360) % 360,
    speed: w.boatState.speed / KNOT,
    antialias: w.stage.antialias,
    scale: w.stage.scale,
    pass: w.usePass,
  };
}

/** Applies to the world whatever differs from the state. */
export function applyState(w: PanelWorld, s: PanelState): void {
  if (s.sea !== w.testSea) {
    w.setTestSea(s.sea);
  }
  if (s.east !== w.boatState.east || s.north !== w.boatState.north) {
    w.placeBoat(s.east, s.north);
  }
  w.boatState.heading = (s.heading * Math.PI) / 180;
  w.boatState.speed = s.speed * KNOT;
  if (s.antialias !== w.stage.antialias) {
    w.stage.setAntialias(s.antialias);
  }
  if (s.scale !== w.stage.scale) {
    w.stage.setScale(s.scale);
  }
  if (s.pass !== w.usePass) {
    w.setUsePass(s.pass);
  }
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

export function openPanel(world: SeaScene, parent: HTMLElement): void {
  const panel = el('aside');
  panel.className = 'dev-panel';
  const body = el('div');
  const stats = el('pre');
  panel.append(
    button('Developer', () => body.toggleAttribute('hidden')),
    body,
  );
  parent.append(panel);

  const set = (change: Partial<PanelState>): void => {
    applyState(world, { ...readState(world), ...change });
    render();
  };

  const render = (): void => {
    const s = readState(world);
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

    body.replaceChildren(
      row(
        'Test sea',
        select(
          SEAS,
          (x) => x,
          s.sea,
          (sea) => set({ sea }),
        ),
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
      row(
        'Speed, kn',
        number(s.speed, 0.5, (speed) => set({ speed })),
      ),
      button('Jump to the rim', () => set(toRim(readState(world)))),
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
    );
  };

  let shown = 0;
  world.onFrame = () => {
    const now = performance.now();
    if (now - shown < 500) {
      return;
    }
    shown = now;
    const st = world.stats.last;
    const b = world.boatState;
    const o = world.origin;
    const gpu = st.gpu === null ? 'no timestamps' : `${st.gpu.toFixed(2)} ms`;
    stats.textContent = [
      `frame   ${st.median.toFixed(1)} ms median, ${st.p90.toFixed(1)} ms 90th (${st.frames} in 2 s)`,
      `gpu     ${gpu}`,
      `draws   ${st.drawCalls}, ${st.triangles.toLocaleString('en')} triangles`,
      `scale   ${world.stage.pixelRatio()}${world.stage.gfx?.floatTargets === false ? ', no float targets' : ''}`,
      `boat    ${b.east.toFixed(0)} E, ${b.north.toFixed(0)} N`,
      `origin  ${o.world.x.toFixed(0)} E, ${o.world.y.toFixed(0)} N, tile ${o.centre.q},${o.centre.r}`,
    ].join('\n');
  };
  render();
}
