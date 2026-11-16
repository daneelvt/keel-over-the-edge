// SPDX-License-Identifier: AGPL-3.0-only

// The sound room (sounds.html, reached as dev.html#sounds): the game's sound
// engine on a page of its own, never part of the game's, to choose and
// balance recordings by ear and by the meter, on the Mac and on the phone.
//
// It plays every voice in its scene, as the engine plays it at sea: the bed
// from sliders for the apparent wind, the boat's speed, the sea's height
// (the boat pitching in it, so the bow slaps), rain, a shore's nearness and
// the hour; in port, the harbour; and the one-shots on their keys, the gun,
// the cheer, thunder and a fog signal at the distance set. Each recorded
// voice can play its synthesis or a file: one of the game's recordings, a
// master, or a candidate dropped into art/sound/candidates (which is not
// committed; the development server lists it at /sound-candidates/). A and
// B switch between the synthesis and the file at once, at the gain set.
//
// The meter reads the mix as it plays: integrated loudness since the reset,
// short-term and momentary, the highest true peak, the share of the mix's
// and of the bed's energy above 2 kHz, and the limiter's reduction.

import './soundroom.css';
import { CHEER, cheerOf } from '../audio/cheer';
import { SoundEngine } from '../audio/engine';
import { FOG_SIGNAL_RULES } from '../audio/fogsignals';
import { GUN, gunReport } from '../audio/gun';
import type { HarbourInput } from '../audio/harbour';
import { KNOCK, knockOf } from '../audio/knock';
import { LiveMeter } from '../audio/livemeter';
import { VOICES, type Voice } from '../audio/recorded';
import type { ThunderFlash } from '../audio/thunder';
import type { SoundInput } from '../audio/voices';

/** The game's recordings' files, the tests' own too, by name: to try in any voice. */
const BUILT = import.meta.glob<string>('../../../art/sound/recorded/*.webm', {
  eager: true,
  query: '?url',
  import: 'default',
});

/** A file the room can play: where it is from, its name, its address. */
interface Source {
  from: 'recording' | 'master' | 'candidate';
  name: string;
  url: string;
}

/** The scenes the sliders start from. */
const PRESETS: Record<string, Partial<Settings>> = {
  calm: { wind: 1.5, speed: 0.5, sea: 0.1, rain: 0, shore: false, port: false },
  harbour: { wind: 4, speed: 0.8, sea: 0.2, rain: 0, shore: false, port: true },
  gentle: { wind: 5, speed: 2, sea: 0.4, rain: 0, shore: false, port: false },
  fresh: { wind: 9.5, speed: 3.2, sea: 1.2, rain: 0, shore: false, port: false },
  gale: { wind: 18, speed: 4.4, sea: 2.6, rain: 0, shore: false, port: false },
  squall: { wind: 14, speed: 3.8, sea: 1.5, rain: 20, shore: false, port: false },
  shore: { wind: 6, speed: 2.4, sea: 0.9, rain: 0, shore: true, port: false },
};

/** What the sliders and switches set. */
interface Settings {
  wind: number;
  speed: number;
  sea: number;
  rain: number;
  distance: number;
  hour: number;
  shore: boolean;
  port: boolean;
  luffing: boolean;
  fog: boolean;
  volume: number;
}

const settings: Settings = {
  wind: 9.5,
  speed: 3.2,
  sea: 1.2,
  rain: 0,
  distance: 400,
  hour: 10,
  shore: false,
  port: false,
  luffing: false,
  fog: false,
  volume: 1,
};

/** A node with its text, classes and children. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
}

/** A slider row: its label, its value shown by show, set into settings[key]. */
function slider(
  key: keyof Settings,
  label: string,
  min: number,
  max: number,
  step: number,
  show: (v: number) => string,
): { row: HTMLElement; set: (v: number) => void } {
  const value = el('span', { className: 'room-value' });
  const input = el('input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
  });
  input.setAttribute('aria-label', label);
  const set = (v: number): void => {
    input.value = String(v);
    (settings as unknown as Record<string, number>)[key] = v;
    value.textContent = show(v);
  };
  input.addEventListener('input', () => set(Number(input.value)));
  set(settings[key] as number);
  return { row: el('label', { className: 'room-row' }, el('span', {}, label), input, value), set };
}

/** A switch row, set into settings[key]. */
function toggle(
  key: keyof Settings,
  label: string,
): { row: HTMLElement; set: (v: boolean) => void } {
  const input = el('input', { type: 'checkbox' });
  const set = (v: boolean): void => {
    input.checked = v;
    (settings as unknown as Record<string, boolean>)[key] = v;
  };
  input.addEventListener('change', () => set(input.checked));
  set(settings[key] as boolean);
  return {
    row: el('label', { className: 'room-row room-switch' }, input, el('span', {}, label)),
    set,
  };
}

/** The files to try: the game's recordings, and what the development server lists of masters and candidates. */
async function sources(): Promise<Source[]> {
  const out: Source[] = Object.entries(BUILT).map(([path, url]) => ({
    from: 'recording' as const,
    name: path.slice(path.lastIndexOf('/') + 1),
    url,
  }));
  try {
    const res = await fetch('/sound-candidates/');
    if (res.ok) {
      const list = (await res.json()) as { candidates: string[]; masters: string[] };
      for (const name of list.masters) {
        out.push({
          from: 'master',
          name,
          url: `/sound-candidates/masters/${encodeURIComponent(name)}`,
        });
      }
      for (const name of list.candidates) {
        out.push({ from: 'candidate', name, url: `/sound-candidates/${encodeURIComponent(name)}` });
      }
    }
  } catch {
    // A built room: the game's recordings alone.
  }
  return out;
}

const fmt = (v: number, digits = 1): string => (Number.isFinite(v) ? v.toFixed(digits) : '–');

export async function openSoundRoom(): Promise<void> {
  document.title = 'Keel Over the Edge · sound room';
  const root = el('main', { className: 'room' });
  document.body.append(root);
  root.append(
    el('h1', {}, 'Sound room'),
    el(
      'p',
      { className: 'room-note' },
      'Every voice as it plays at sea. Pick a scene, move the sliders, and try a file in a voice: A is its synthesis, B the file.',
    ),
  );

  // The scene.
  const rows = {
    wind: slider('wind', 'Apparent wind', 0, 25, 0.5, (v) => `${fmt(v)} m/s`),
    speed: slider('speed', 'Speed', 0, 6, 0.1, (v) => `${fmt(v)} m/s`),
    sea: slider('sea', 'Sea', 0, 4, 0.1, (v) => `${fmt(v)} m`),
    rain: slider('rain', 'Rain', 0, 60, 1, (v) => `${fmt(v, 0)} mm/h`),
    distance: slider('distance', 'Distance', 20, 4000, 10, (v) => `${fmt(v, 0)} m`),
    hour: slider(
      'hour',
      'Hour',
      0,
      24,
      0.25,
      (v) =>
        `${String(Math.floor(v)).padStart(2, '0')}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}`,
    ),
    volume: slider('volume', 'Volume', 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`),
  };
  const switches = {
    port: toggle('port', 'In port'),
    shore: toggle('shore', 'Near a shore'),
    luffing: toggle('luffing', 'Sail luffing'),
    fog: toggle('fog', 'Fog, a horn at the distance'),
  };
  const presets = el(
    'div',
    { className: 'room-keys' },
    ...Object.entries(PRESETS).map(([name, p]) => {
      const b = el('button', { type: 'button' }, name);
      b.addEventListener('click', () => {
        for (const [k, v] of Object.entries(p)) {
          if (typeof v === 'boolean') {
            switches[k as keyof typeof switches]?.set(v);
          } else {
            rows[k as keyof typeof rows]?.set(v as number);
          }
        }
      });
      return b;
    }),
  );
  const play = el('button', { type: 'button', className: 'room-play' }, 'Play');
  root.append(
    el(
      'section',
      {},
      el('h2', {}, 'The scene'),
      presets,
      ...Object.values(rows).map((r) => r.row),
      ...Object.values(switches).map((s) => s.row),
    ),
  );

  // The one-shots.
  const shots = el('div', { className: 'room-keys' });
  root.append(el('section', {}, el('h2', {}, 'Once'), shots));

  // The meter.
  const read = el('pre', { className: 'room-meter' }, '–');
  const reset = el('button', { type: 'button' }, 'Reset the meter');
  root.append(el('section', {}, el('h2', {}, 'The meter'), read, reset));

  // The voices.
  const voiceList = el('div', { className: 'room-voices' });
  root.append(el('section', {}, el('h2', {}, 'The voices'), voiceList));
  root.prepend(play);

  let started: Started | null = null;
  play.addEventListener('click', () => {
    if (started === null) {
      started = start(shots, voiceList, read, reset);
      play.textContent = 'Pause';
      return;
    }
    const ctx = started.ctx;
    if (ctx.state === 'running') {
      void ctx.suspend();
      play.textContent = 'Play';
    } else {
      void ctx.resume();
      play.textContent = 'Pause';
    }
  });
}

interface Started {
  ctx: AudioContext;
  engine: SoundEngine;
}

/** Starts the engine on a context of the room's: the scene, the keys, the voices and the meter. */
function start(
  shots: HTMLElement,
  voiceList: HTMLElement,
  read: HTMLElement,
  reset: HTMLElement,
): Started {
  const ctx = new AudioContext({ latencyHint: 'playback' });
  const out = ctx.createGain();
  out.connect(ctx.destination);
  const engine = new SoundEngine();
  engine.attach(ctx, out);

  // The meter: the mix after the limiter, and the bed's bus.
  const mixMeter = new LiveMeter(ctx.sampleRate);
  const bedMeter = new LiveMeter(ctx.sampleRate);
  // The limiter's meter starts from a reduction of its own, settling
  // within seconds: it is read from 3 s after the start or a reset.
  let reduction = 0;
  let readFrom = ctx.currentTime + 3;
  const tap = (from: AudioNode, m: LiveMeter): void => {
    const p = ctx.createScriptProcessor(4096, 2, 2);
    p.onaudioprocess = (e) => {
      const b = e.inputBuffer;
      m.push([
        b.getChannelData(0),
        b.numberOfChannels > 1 ? b.getChannelData(1) : b.getChannelData(0),
      ]);
    };
    const silent = ctx.createGain();
    silent.gain.value = 0;
    from.connect(p);
    p.connect(silent);
    silent.connect(ctx.destination);
  };
  tap(out, mixMeter);
  const bed = engine.tap('sea');
  if (bed !== null) {
    tap(bed, bedMeter);
  }
  reset.addEventListener('click', () => {
    mixMeter.reset();
    bedMeter.reset();
    reduction = 0;
    readFrom = ctx.currentTime + 3;
  });

  // The scene, every 50 ms.
  const input: SoundInput = {
    apparentWind: 0,
    speed: 0,
    throughWater: 0,
    seaHeight: 0,
    whitecaps: 0,
    luffing: 0,
    time: 0,
    lip: Number.POSITIVE_INFINITY,
    lipPan: 0,
    falling: false,
    waterline: 3.5,
    sailArea: 7,
  };
  const listener = { east: 0, north: 0 };
  const flashes: ThunderFlash[] = [];
  const t0 = performance.now();
  const secondsPerHour = 60;
  const harbour = (seconds: number): HarbourInput => ({
    seconds,
    hour: settings.hour,
    day: settings.hour > 6 && settings.hour < 18,
    listener,
    look: 0,
    inPort: settings.port,
    nearTown: settings.port ? 40 : 1e9,
    bell: settings.port ? { east: 60, north: 80 } : null,
    yard: settings.port ? { east: -140, north: 160 } : null,
    quay: settings.port ? { east: -25, north: 10 } : null,
    gulls: [],
    seaHeight: settings.sea,
    period: 4,
  });
  let boom = 0.35;
  setInterval(() => {
    const now = performance.now();
    const t = (now - t0) / 1000;
    const seconds = 1000 + t;
    // The wind gusting about the slider's, two slow swells and a flutter.
    const gust =
      0.7 * Math.sin((2 * Math.PI * t) / 17) * (0.6 + 0.4 * Math.sin((2 * Math.PI * t) / 41)) +
      0.3 * Math.sin((2 * Math.PI * t) / 5.3 + 1);
    const g = 1 + 0.12 * gust;
    input.apparentWind = settings.wind * g;
    input.gustFactor = g;
    input.speed = settings.speed;
    input.throughWater = settings.speed;
    input.seaHeight = settings.sea;
    input.whitecaps = Math.min(1, Math.max(0, (settings.wind - 7) / 12));
    input.luffing = settings.luffing ? 2 : 0;
    input.time = seconds;
    input.rain = settings.rain;
    input.depth = settings.shore ? 4 : 40;
    // The boat pitching in the sea: 4° a metre of it, every 3 s to 5 s.
    const period = 3 + settings.sea;
    const omega = (2 * Math.PI) / period;
    input.pitchRate = ((4 * settings.sea * Math.PI) / 180) * omega * Math.cos(omega * t);
    input.heaveRate = 0.4 * settings.sea * omega * Math.cos(omega * t - 0.4);
    input.boom = boom;
    input.boomRate = 0;
    input.apparentAngle = 0.8 * Math.sign(boom);
    engine.volumes(settings.volume, 1, 1);
    engine.update(now, input);
    engine.harbour(now, harbour(seconds), secondsPerHour);
    if (settings.fog) {
      engine.fogSignals(now, {
        seconds,
        listener,
        look: 0,
        lights: [
          {
            number: 3,
            east: settings.distance * 0.6,
            north: settings.distance * 0.8,
            phase: 0.25,
            fogSignal: FOG_SIGNAL_RULES.signals.findIndex((s) => s.device === 'diaphone'),
          },
        ],
        poorAt: () => true,
      });
    }
    engine.thunder(now, { seconds, listener, look: 0, flashes });
    if (ctx.currentTime >= readFrom) {
      reduction = Math.min(reduction, engine.reduction);
    }
  }, 50);

  // The keys.
  const key = (label: string, act: () => void): void => {
    const b = el('button', { type: 'button' }, label);
    b.addEventListener('click', act);
    shots.append(b);
  };
  const at = (): { east: number; north: number } => ({
    east: settings.distance * 0.6,
    north: settings.distance * 0.8,
  });
  key('Tack', () => {
    boom = -boom;
  });
  key('Gybe', () => {
    // The boom's thump is the gybe's: the wind across the stern, fast.
    input.apparentAngle = 2.9 * Math.sign(boom);
    input.boom = -boom * 3;
    input.boomRate = -2 * Math.sign(boom);
    engine.update(performance.now() + 100, input);
    boom = -boom;
  });
  key('Knock', () => engine.knock(knockOf(KNOCK, 1.2, 0, 0)));
  key('Bell', () => engine.bell(2));
  key('Gun', () => {
    const r = gunReport(GUN, at(), listener, 0, 1, false);
    if (r !== null) {
      engine.gun(r);
    }
  });
  key('Gun, a racer', () => {
    const r = gunReport(GUN, at(), listener, 0, 1, true);
    if (r !== null) {
      engine.gun(r);
    }
  });
  key('Cheer', () => engine.cheer(cheerOf(CHEER, 6, false, true)));
  key('Thunder', () => {
    const seconds = 1000 + (performance.now() - t0) / 1000;
    const p = at();
    flashes.push({
      tick: Math.round(seconds * 30),
      east: p.east,
      north: p.north,
      sea: true,
      base: 900,
      seed: flashes.length + 1,
    });
  });

  // The voices: each its synthesis (A) or a file (B), at a gain.
  void sources().then((files) => {
    for (const voice of Object.keys(VOICES) as Voice[]) {
      voiceList.append(voiceRow(ctx, engine, voice, files));
    }
  });

  // The meter, read out.
  setInterval(() => {
    const f = engine.families();
    const synth = Object.entries(f)
      .filter(([, v]) => v.synth < 0.999)
      .map(([k, v]) => `${k} ${Math.round(100 * (1 - v.synth))}%`)
      .join(', ');
    read.textContent = [
      `Integrated   ${fmt(mixMeter.integrated)} LUFS over ${fmt(mixMeter.seconds, 0)} s`,
      `Short-term   ${fmt(mixMeter.shortTerm)} LUFS`,
      `Momentary    ${fmt(mixMeter.momentary)} LUFS`,
      `True peak    ${fmt(mixMeter.truePeak)} dBTP`,
      `Above 2 kHz  ${Math.round(100 * mixMeter.above)}% of the mix, ${Math.round(100 * bedMeter.above)}% of the bed`,
      `Bed          ${fmt(bedMeter.integrated)} LUFS`,
      `Limiter      ${fmt(-reduction)} dB at most`,
      `Recorded     ${synth === '' ? 'none' : synth}`,
      `Played       ${engine.slaps} slaps, ${engine.sheets} sheets, ${engine.booms} booms, ${engine.taps} taps`,
    ].join('\n');
  }, 250);
  void ctx.resume();
  return { ctx, engine };
}

/** A voice's row: its file, its gain, and A and B. */
function voiceRow(
  ctx: AudioContext,
  engine: SoundEngine,
  voice: Voice,
  files: Source[],
): HTMLElement {
  const pick = el('select', {});
  pick.setAttribute('aria-label', `${voice}: file`);
  pick.append(el('option', { value: '' }, 'no file'));
  for (const f of files) {
    pick.append(el('option', { value: f.url }, `${f.from}: ${f.name}`));
  }
  const gain = el('input', { type: 'number', value: '0', step: '0.5' });
  gain.setAttribute('aria-label', `${voice}: gain, dB`);
  const a = el('button', { type: 'button', className: 'room-on' }, 'A');
  const b = el('button', { type: 'button' }, 'B');
  const state = el('span', { className: 'room-value' }, 'synthesis');
  const buffers = new Map<string, AudioBuffer>();
  const useA = (): void => {
    engine.useSynthesis(voice);
    a.className = 'room-on';
    b.className = '';
    state.textContent = 'synthesis';
  };
  const useB = async (): Promise<void> => {
    const url = pick.value;
    if (url === '') {
      return;
    }
    let buffer = buffers.get(url);
    if (buffer === undefined) {
      state.textContent = 'loading';
      try {
        buffer = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
        buffers.set(url, buffer);
      } catch (err) {
        state.textContent = `will not decode: ${String(err)}`;
        return;
      }
    }
    engine.useSynthesis(voice);
    engine.useRecording(voice, buffer, Number(gain.value) || 0, 0.05);
    a.className = '';
    b.className = 'room-on';
    state.textContent = `${fmt(buffer.duration)} s, ${buffer.numberOfChannels} ch`;
  };
  a.addEventListener('click', useA);
  b.addEventListener('click', () => void useB());
  gain.addEventListener('change', () => {
    if (b.className === 'room-on') {
      void useB();
    }
  });
  return el(
    'div',
    { className: 'room-voice' },
    el('span', { className: 'room-name' }, voice),
    pick,
    gain,
    a,
    b,
    state,
  );
}
