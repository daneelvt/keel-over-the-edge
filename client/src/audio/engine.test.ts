// SPDX-License-Identifier: AGPL-3.0-only

// The engine's life: no context while the sound is off, the audio session
// ambient before one is made, a fade in as it starts, a fade out and then a
// suspend on a mute or a hidden page (and none undone by showing the page
// while muted), a resume and a fade in on unmuting, and the sliders on the
// cube. A stand-in context records what the engine asks of it.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CHEER, cheerOf } from './cheer';
import { SoundEngine } from './engine';
import { GUN, gunReport } from './gun';
import { KNOCK, knockOf } from './knock';
import type { WaterSound } from './life';
import { gainOf, MIX } from './mix';
import { type Recording, VOICES } from './recorded';
import type { SoundInput } from './voices';

/** An automation call: its name, the value and the time. */
type Call = [string, number, number];

/** An AudioParam that records its automation, and holds the last value set. */
class Param {
  value = 1;
  calls: Call[] = [];
  setValueAtTime(v: number, t: number): this {
    this.calls.push(['set', v, t]);
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number, t: number): this {
    this.calls.push(['ramp', v, t]);
    this.value = v;
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number): this {
    this.calls.push(['exp', v, t]);
    return this;
  }
  setTargetAtTime(v: number, t: number): this {
    this.calls.push(['target', v, t]);
    return this;
  }
  cancelScheduledValues(t: number): this {
    this.calls.push(['cancel', 0, t]);
    return this;
  }
  cancelAndHoldAtTime(t: number): this {
    this.calls.push(['hold', this.value, t]);
    return this;
  }
}

/** A node: connects and starts as asked, and makes a Param of any parameter read. */
function node(): AudioNode {
  const base: Record<string | symbol, unknown> = {
    connect: (n: unknown) => n,
    disconnect: () => {},
    start: () => {},
    stop: () => {},
    setPeriodicWave: () => {},
    reduction: 0,
  };
  return new Proxy(base, {
    get(t, k) {
      if (!(k in t)) {
        t[k] = new Param();
      }
      return t[k];
    },
  }) as unknown as AudioNode;
}

/** The stand-in context: its state, its clock, and the nodes it made. */
class Context {
  state: AudioContextState = 'suspended';
  currentTime = 10;
  sampleRate = 8000;
  destination = node();
  gains: GainNode[] = [];
  resumes = 0;
  suspends = 0;
  resume(): Promise<void> {
    this.resumes++;
    this.state = 'running';
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    this.suspends++;
    this.state = 'suspended';
    return Promise.resolve();
  }
  createGain(): GainNode {
    const g = node() as GainNode;
    this.gains.push(g);
    return g;
  }
  createBuffer(_channels: number, length: number): AudioBuffer {
    const data = new Float32Array(length);
    return { getChannelData: () => data } as unknown as AudioBuffer;
  }
  createBiquadFilter = node;
  sources: AudioBufferSourceNode[] = [];
  createBufferSource = (): AudioBufferSourceNode => {
    const n = node() as AudioBufferSourceNode;
    this.sources.push(n);
    return n;
  };
  oscillators: OscillatorNode[] = [];
  createOscillator = (): OscillatorNode => {
    const n = node() as OscillatorNode;
    this.oscillators.push(n);
    return n;
  };
  createWaveShaper = node;
  createStereoPanner = node;
  createDynamicsCompressor = node;
  createConstantSource = node;
  createPeriodicWave = node;
}

const made: Context[] = [];
const sessions: (string | undefined)[] = [];
let session: { type: string } | undefined;

function engine(): SoundEngine {
  return new SoundEngine(undefined, {
    context: () => {
      sessions.push(session?.type);
      const c = new Context();
      made.push(c);
      return c as unknown as AudioContext;
    },
  });
}

/** Lets the promises the engine waits on settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
};

const fadeOf = (e: SoundEngine): Param => e.mixer?.fade.gain as unknown as Param;

beforeEach(() => {
  made.length = 0;
  sessions.length = 0;
  session = { type: 'auto' };
  vi.stubGlobal('navigator', { audioSession: session });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the sound engine', () => {
  test('makes no context while the sound is off, however often it is tapped', () => {
    const e = engine();
    e.enabled = false;
    e.unlock();
    e.unlock();
    expect(made).toHaveLength(0);
    expect(e.state).toBe('none');
    // Turned on after a gesture: it starts at once.
    e.enabled = true;
    expect(made).toHaveLength(1);
  });

  test('sets the audio session to ambient before it makes the context', () => {
    const e = engine();
    e.unlock();
    expect(sessions).toEqual(['ambient']);
  });

  test('makes its context without an audio session where the browser has none', () => {
    vi.stubGlobal('navigator', {});
    const e = engine();
    e.unlock();
    expect(made).toHaveLength(1);
  });

  test('fades in from silence as it starts', () => {
    const e = engine();
    e.unlock();
    const f = fadeOf(e);
    const t = made[0]?.currentTime ?? 0;
    expect(f.calls).toContainEqual(['set', 0, t]);
    expect(f.calls).toContainEqual(['ramp', 1, t + MIX.fades.start]);
  });

  test('fades out on a mute, then suspends; showing the page while muted keeps it so; unmuting resumes and fades in', async () => {
    const e = engine();
    e.unlock();
    await settle();
    const c = made[0] as Context;
    expect(c.state).toBe('running');
    const f = fadeOf(e);
    f.calls.length = 0;
    e.enabled = false;
    expect(f.calls.at(-1)).toEqual(['ramp', 0, c.currentTime + MIX.fades.out]);
    // Not suspended mid-fade: that would click.
    expect(c.suspends).toBe(0);
    vi.advanceTimersByTime(MIX.fades.out * 1000 + 50);
    expect(c.suspends).toBe(1);
    expect(c.state).toBe('suspended');
    // Hidden and shown while muted: still suspended, still silent.
    const resumes = c.resumes;
    e.setHidden(true);
    e.setHidden(false);
    e.unlock();
    await settle();
    expect(c.resumes).toBe(resumes);
    expect(c.state).toBe('suspended');
    f.calls.length = 0;
    e.enabled = true;
    await settle();
    expect(c.resumes).toBe(resumes + 1);
    expect(f.calls.at(-1)).toEqual(['ramp', 1, c.currentTime + MIX.fades.in]);
  });

  test('fades out while the page is hidden and back in when it is shown', async () => {
    const e = engine();
    e.unlock();
    await settle();
    const c = made[0] as Context;
    const f = fadeOf(e);
    e.setHidden(true);
    expect(f.calls.at(-1)).toEqual(['ramp', 0, c.currentTime + MIX.fades.out]);
    vi.advanceTimersByTime(MIX.fades.out * 1000 + 50);
    expect(c.state).toBe('suspended');
    e.setHidden(false);
    await settle();
    expect(c.state).toBe('running');
    expect(f.calls.at(-1)).toEqual(['ramp', 1, c.currentTime + MIX.fades.in]);
  });

  test('takes back a mute undone within the fade: no suspend, a fade back from where it was', async () => {
    const e = engine();
    e.unlock();
    await settle();
    const c = made[0] as Context;
    e.enabled = false;
    e.enabled = true;
    vi.advanceTimersByTime(1000);
    expect(c.suspends).toBe(0);
    expect(fadeOf(e).calls.at(-1)).toEqual(['ramp', 1, c.currentTime + MIX.fades.in]);
  });

  test('sets the sliders on their cube, gliding: the volume on the master, at the mix’s own level, Sounds on every bus but the sea’s', () => {
    const e = engine();
    e.volumes(0.7, 1, 0.5);
    e.unlock();
    const m = e.mixer;
    if (m === null) {
      throw new Error('no mixer');
    }
    const c = made[0] as Context;
    const last = (p: AudioParam): Call | undefined => (p as unknown as Param).calls.at(-1);
    const master = last(m.master.gain);
    expect(master?.[0]).toBe('ramp');
    expect(master?.[1]).toBeCloseTo(0.343 * gainOf(MIX.master), 6);
    expect(master?.[2]).toBeCloseTo(c.currentTime + MIX.fades.slider, 9);
    e.volumes(0.7, 0.5, 1);
    const sea = last((m.output('sea') as GainNode).gain);
    const world = last((m.output('world') as GainNode).gain);
    expect(sea?.[1]).toBeCloseTo(0.125 * 10 ** (MIX.buses.sea.level / 20), 6);
    expect(world?.[1]).toBeCloseTo(10 ** (MIX.buses.world.level / 20), 6);
  });
});

/** A boat sailing in a moderate sea, for the bed's tests. */
function sailing(): SoundInput {
  return {
    apparentWind: 7,
    speed: 2,
    throughWater: 2,
    seaHeight: 1,
    whitecaps: 0,
    luffing: 0,
    time: 1000,
    lip: Number.POSITIVE_INFINITY,
    lipPan: 0,
    falling: false,
  };
}

/** A recording's buffer, as the stand-in context's sources need it. */
const buffer = { duration: 4, length: 4 * 8000, sampleRate: 8000 } as AudioBuffer;

describe('the bed’s recordings', () => {
  test('a recording takes over its layer from the synthesis over the crossfade, at equal power', async () => {
    const e = engine();
    e.unlock();
    await settle();
    const c = made[0] as Context;
    let now = 0;
    const step = (): void => {
      now += 100;
      e.update(now, sailing());
    };
    step();
    expect(e.families().sea.synth).toBe(1);
    e.useRecording('sea.moderate', buffer);
    expect(e.recorded.has('sea.moderate')).toBe(true);
    const seen: number[] = [];
    for (let t = 0; t <= MIX.layers.crossfade + 0.5; t += 0.5) {
      c.currentTime = 10 + t;
      step();
      const f = e.families().sea;
      const layer = f.layers['sea.moderate'];
      // At 1 m the moderate sea is all of the family.
      expect(layer?.share).toBeCloseTo(1, 9);
      expect(f.synth ** 2 + (layer?.take ?? 0) ** 2).toBeCloseTo(1, 9);
      seen.push(f.synth);
    }
    expect(seen[0]).toBe(1);
    expect(seen.at(-1)).toBe(0);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i] ?? 0).toBeLessThanOrEqual(seen[i - 1] ?? 0);
    }
  });

  test('the synthesis plays the share of the layers with no recording', async () => {
    const e = engine();
    e.unlock();
    await settle();
    const c = made[0] as Context;
    e.useRecording('wind.moderate', buffer);
    c.currentTime += 10;
    // Between the moderate's and the strong's centres.
    const x = { ...sailing(), apparentWind: 9.5 };
    e.update(100, x);
    const w = e.families().wind;
    expect(w.layers['wind.moderate']?.take).toBe(1);
    expect(w.synth).toBeCloseTo(w.layers['wind.strong']?.share ?? 0, 9);
    expect(w.synth).toBeGreaterThan(0.5);
    // Its recording let go: the synthesis is all of it again.
    e.useSynthesis('wind.moderate');
    e.update(200, x);
    expect(e.families().wind.synth).toBe(1);
    expect(e.recorded.size).toBe(0);
  });

  test('recordings that cannot be fetched or decoded leave the synthesis playing', async () => {
    const e = engine();
    e.unlock();
    await settle();
    const list = (['sea-moderate', 'wind-light'] as const).map((name, i) => ({
      name,
      voice: i === 0 ? 'sea.moderate' : 'wind.light',
      kind: 'bed' as const,
      gain: 0,
      seconds: 4,
      channels: 1,
      bytes: { webm: 1, m4a: 1 },
      urls: { webm: `${name}.webm`, m4a: `${name}.m4a` },
    }));
    const probe: Recording = {
      ...(list[0] as Recording),
      name: 'probe',
      kind: 'probe',
      urls: { webm: 'probe.webm', m4a: 'probe.m4a' },
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The probe decodes; the sea's recording does not.
    let decodes = 0;
    const out = await e.record(list, probe, {
      fetch: async (url) => {
        if (url === 'wind-light.webm') {
          throw new Error('404');
        }
        return new ArrayBuffer(8);
      },
      decode: async () => {
        if (decodes++ > 0) {
          throw new Error('EncodingError');
        }
        return buffer;
      },
      frame: async () => {},
    });
    expect(out?.failed.sort()).toEqual(['sea-moderate', 'wind-light']);
    expect(e.recorded.size).toBe(0);
    e.update(100, sailing());
    expect(e.families().sea.synth).toBe(1);
    expect(e.families().wind.synth).toBe(1);
  });

  test('asks for nothing while the game lists no recordings', async () => {
    const e = engine();
    const fetches = vi.fn();
    vi.stubGlobal('fetch', fetches);
    e.record();
    e.unlock();
    await settle();
    const out = await e.loading;
    expect(fetches).not.toHaveBeenCalled();
    expect(out?.loaded).toEqual([]);
  });
});

describe('the boat’s motion', () => {
  test('a slap as the bow turns up from a fast fall, through the sea bus', async () => {
    const e = engine();
    e.unlock();
    await settle();
    const x = sailing();
    let now = 0;
    for (let t = 0; t < 12; t += 0.05) {
      now += 50;
      // 12° every 3 s.
      x.pitchRate = 0.44 * Math.cos(((2 * Math.PI) / 3) * t);
      x.heaveRate = 0.5 * Math.cos(((2 * Math.PI) / 3) * t - 0.4);
      x.time = 1000 + t;
      e.update(now, x);
    }
    expect(e.slaps).toBe(4);
  });

  test('the sheet in a tack, the boom in a gybe', async () => {
    const e = engine();
    e.unlock();
    await settle();
    const x = sailing();
    const at = (boom: number, rate: number, angle: number, now: number): void => {
      x.boom = boom;
      x.boomRate = rate;
      x.apparentAngle = angle;
      e.update(now, x);
    };
    at(0.4, 0, 0.7, 100);
    at(-0.4, -0.3, -0.7, 200);
    expect(e.sheets).toBe(1);
    at(-1.2, 0, -2.9, 300);
    at(1.1, 2, 2.9, 400);
    expect(e.booms).toBe(1);
  });
});

/** Takes of a recording, told apart by their lengths. */
const takes = (n: number): AudioBuffer[] =>
  Array.from(
    { length: n },
    (_, i) => ({ duration: 1 + i, length: 8000 * (1 + i), sampleRate: 8000 }) as AudioBuffer,
  );

/** A splash heard, at a level, by its seed. */
const splash = (seed: number, level = 0.2): WaterSound => ({
  kind: 'splash',
  level,
  pan: 0,
  size: 1,
  seed,
});

/** A started engine, with its context. */
async function started(): Promise<[SoundEngine, Context]> {
  const e = engine();
  e.unlock();
  await settle();
  return [e, made.at(-1) as Context];
}

describe('the sounds played once', () => {
  test('every voice played once is in the mix, and the mix names no other', () => {
    const shots = Object.entries(VOICES)
      .filter(([, kind]) => kind === 'shot')
      .map(([v]) => v)
      .sort();
    expect(Object.keys(MIX.shots).sort()).toEqual(shots);
    for (const [voice, s] of Object.entries(MIX.shots)) {
      expect(s.family === null || s.family in MIX.voices.families, voice).toBe(true);
    }
  });

  test('a voice’s takes play round robin, never the same twice in a row, each varied by its seed', async () => {
    const [e] = await started();
    for (const b of takes(3)) {
      e.useRecording('splash', b);
    }
    for (let seed = 0; seed < 60; seed++) {
      e.water([splash(seed * 13 + 1)]);
      (made.at(-1) as Context).currentTime += 5;
    }
    const heard = e.heard.filter((h) => h.voice === 'splash');
    expect(heard).toHaveLength(60);
    for (let i = 1; i < heard.length; i++) {
      expect(heard[i]?.take).not.toBe(heard[i - 1]?.take);
    }
    expect(new Set(heard.map((h) => h.take)).size).toBe(3);
    // Pitched within a semitone, louder or softer within 2 dB.
    for (const h of heard) {
      expect(Math.abs(12 * Math.log2(h.rate))).toBeLessThanOrEqual(MIX.shots.splash.pitch + 1e-9);
      expect(Math.abs(20 * Math.log10(h.gain))).toBeLessThanOrEqual(MIX.shots.splash.level + 1e-9);
    }
    expect(new Set(heard.map((h) => h.rate)).size).toBeGreaterThan(30);
  });

  test('two pages hearing the same sounds hear the same takes, as varied', async () => {
    const pages = [await started(), await started()];
    for (const [e, c] of pages) {
      for (const buf of takes(4)) {
        e.useRecording('knock', buf);
      }
      for (const closing of [0.3, 0.8, 1.2, 1.2, 2, 0.5, 3]) {
        e.knock(knockOf(KNOCK, closing, 0, 0));
        c.currentTime += 5;
      }
    }
    const [a, b] = pages.map(([e]) => e) as [SoundEngine, SoundEngine];
    expect(a.heard.length).toBe(7);
    expect(b.heard).toEqual(a.heard);
  });

  test('signals are never varied: the bell, the gun and a fog signal play their first take as it is', async () => {
    const [e] = await started();
    for (const voice of ['bell', 'gun'] as const) {
      for (const buf of takes(3)) {
        e.useRecording(voice, buf);
      }
    }
    e.bell(4);
    for (let i = 0; i < 3; i++) {
      const r = gunReport(GUN, { east: 40, north: 30 }, { east: 0, north: 0 }, 0, 1 + i, true);
      if (r !== null) {
        e.gun(r);
      }
    }
    expect(e.heard).toHaveLength(7);
    for (const h of e.heard) {
      expect(h).toMatchObject({ take: 0, rate: 1, gain: 1 });
    }
  });

  test('a synthesised sound is varied too: a knock’s pitch by its seed, the same for the same knock', async () => {
    const [e, c] = await started();
    const thump = (closing: number): number => {
      e.knock(knockOf(KNOCK, closing, 0, 0));
      const tone = c.oscillators.at(-1)?.frequency as unknown as Param;
      return tone.calls[0]?.[1] ?? 0;
    };
    const ratios = [0.4, 0.9, 1.4, 2.2].map((v) => thump(v) / knockOf(KNOCK, v, 0, 0).thump);
    for (const r of ratios) {
      expect(Math.abs(12 * Math.log2(r))).toBeLessThanOrEqual(MIX.shots.knock.pitch + 1e-9);
    }
    expect(new Set(ratios).size).toBe(4);
    expect(thump(0.9)).toBe(thump(0.9));
    expect(e.heard).toHaveLength(0);
  });

  test('the crowd’s recordings crossfaded by the cheers, low-passed from the quay; the player’s own its own', async () => {
    const [e] = await started();
    e.useRecording('crowd.small', takes(1)[0] as AudioBuffer);
    e.useRecording('crowd.large', takes(2)[1] as AudioBuffer);
    e.useRecording('cheer.own', takes(1)[0] as AudioBuffer);
    e.cheer(cheerOf(CHEER, 1, false, true));
    expect(e.heard.map((h) => h.voice)).toEqual(['crowd.small']);
    e.heard.length = 0;
    e.cheer(cheerOf(CHEER, 40, false, true));
    expect(e.heard.map((h) => h.voice)).toEqual(['crowd.large']);
    e.heard.length = 0;
    // Between them, both.
    e.cheer(cheerOf(CHEER, 5, false, true));
    expect(e.heard.map((h) => h.voice).sort()).toEqual(['crowd.large', 'crowd.small']);
    e.heard.length = 0;
    e.cheer(cheerOf(CHEER, 3, true, false));
    expect(e.heard.map((h) => h.voice)).toEqual(['cheer.own']);
    expect(e.cheers).toBe(4);
  });

  test('a recording of one horn plays each fog signal at its device’s note', async () => {
    const [e, c] = await started();
    e.useRecording('fog', takes(1)[0] as AudioBuffer, 0, 0, { note: 105, loop: [0.2, 0.8] });
    e.fogSignals(0, {
      seconds: 1000,
      listener: { east: 0, north: 0 },
      look: 0,
      lights: [],
      poorAt: () => true,
    });
    // The diaphone's blast, heard 300 m off.
    e.fogSignals(100, {
      seconds: 1001.5,
      listener: { east: 0, north: 0 },
      look: 0,
      lights: [{ number: 1, east: 0, north: 300, phase: 0, fogSignal: 1 }],
      poorAt: () => true,
    });
    for (let t = 1002; t < 1062 && e.fogSignalEvents === 0; t += 1.5) {
      e.fogSignals((t - 1000) * 1000, {
        seconds: t,
        listener: { east: 0, north: 0 },
        look: 0,
        lights: [{ number: 1, east: 0, north: 300, phase: 0, fogSignal: 1 }],
        poorAt: () => true,
      });
    }
    expect(e.fogSignalEvents).toBeGreaterThan(0);
    const s = c.sources.at(-1) as unknown as Record<string, unknown>;
    const rate = s.playbackRate as unknown as Param;
    expect(rate.calls[0]?.[1]).toBeCloseTo(210 / 105, 9);
    expect(s.loop).toBe(true);
    expect(s.loopEnd).toBe(0.8);
    expect(e.heard.at(-1)).toMatchObject({ voice: 'fog', take: 0 });
    // A horn 300 m off is near: it dips the sea.
    expect(e.ducks).toBe(e.fogSignalEvents);
  });
});

describe('the voice limits', () => {
  test('a family full lets the quietest go: four splashes at most', async () => {
    const [e] = await started();
    e.water([0.1, 0.2, 0.3, 0.4, 0.5, 0.05].map((level, i) => splash(i, level)));
    expect(e.waterSounds).toBe(5);
    expect(e.letGo).toBe(2);
    expect(e.playingOnce).toBe(4);
  });

  test('twenty-four at once in all, the quietest faded out', async () => {
    const [e, c] = await started();
    for (let i = 0; i < 24; i++) {
      e.cheer(cheerOf(CHEER, 6, false, false, () => 0.5));
    }
    expect(e.playingOnce).toBe(24);
    const before = c.gains.length;
    // One more as loud: no room.
    e.cheer(cheerOf(CHEER, 6, false, false, () => 0.5));
    expect(e.cheers).toBe(24);
    // A louder one: the quietest goes, faded fast.
    const r = gunReport(GUN, { east: 0, north: 0 }, { east: 0, north: 0 }, 0, 1, true);
    if (r === null) {
      throw new Error('no report');
    }
    e.gun(r);
    expect(e.guns).toBe(1);
    expect(e.playingOnce).toBe(24);
    expect(e.letGo).toBe(2);
    const faded = c.gains
      .slice(0, before)
      .filter((g) =>
        (g.gain as unknown as Param).calls.some(
          (k) => k[0] === 'target' && k[1] === 0 && k[2] === c.currentTime,
        ),
      );
    expect(faded.length).toBeGreaterThanOrEqual(1);
  });
});

describe('the dips', () => {
  const duckOf = (e: SoundEngine): Param => e.mixer?.duck('sea') as unknown as Param;

  test('the gun dips the sea 4 dB for 1.5 s, in over 50 ms and back over 800 ms', async () => {
    const [e, c] = await started();
    const r = gunReport(GUN, { east: 40, north: 30 }, { east: 0, north: 0 }, 0, 1, true);
    if (r === null) {
      throw new Error('no report');
    }
    e.gun(r);
    const at = c.currentTime + r.delay;
    const d = MIX.duck;
    expect(d.depth).toBe(-4);
    expect(duckOf(e).calls).toEqual([
      ['hold', 1, at],
      ['ramp', gainOf(-4), at + d.attack],
      ['set', gainOf(-4), at + d.hold],
      ['ramp', 1, at + d.hold + d.release],
    ]);
    expect(e.ducks).toBe(1);
  });

  test('a dip within another holds it longer', async () => {
    const [e, c] = await started();
    const r = gunReport(GUN, { east: 0, north: 0 }, { east: 0, north: 0 }, 0, 1, true);
    if (r === null) {
      throw new Error('no report');
    }
    e.gun(r);
    c.currentTime += 1;
    e.gun(r);
    const last = duckOf(e).calls.at(-1);
    expect(last?.[2]).toBeCloseTo(c.currentTime + MIX.duck.hold + MIX.duck.release, 9);
  });

  test('the crowd’s cheer dips the sea, the player’s own does not; a far gun does not', async () => {
    const [e] = await started();
    e.cheer(cheerOf(CHEER, 1, true, false));
    expect(e.ducks).toBe(0);
    const far = gunReport(GUN, { east: 3000, north: 0 }, { east: 0, north: 0 }, 0, 1, false);
    if (far !== null) {
      e.gun(far);
    }
    expect(e.ducks).toBe(0);
    e.cheer(cheerOf(CHEER, 6, false, true));
    expect(e.ducks).toBe(1);
  });
});
