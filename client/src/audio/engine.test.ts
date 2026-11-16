// SPDX-License-Identifier: AGPL-3.0-only

// The engine's life: no context while the sound is off, the audio session
// ambient before one is made, a fade in as it starts, a fade out and then a
// suspend on a mute or a hidden page (and none undone by showing the page
// while muted), a resume and a fade in on unmuting, and the sliders on the
// cube. A stand-in context records what the engine asks of it.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SoundEngine } from './engine';
import { MIX } from './mix';
import type { Recording } from './recorded';
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
  createBufferSource = node;
  createOscillator = node;
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

  test('sets the sliders on their cube, gliding: the volume on the master, Sounds on every bus but the sea’s', () => {
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
    expect(master?.[1]).toBeCloseTo(0.343, 6);
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
      // 6° every 3 s.
      x.pitchRate = 0.22 * Math.cos(((2 * Math.PI) / 3) * t);
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
