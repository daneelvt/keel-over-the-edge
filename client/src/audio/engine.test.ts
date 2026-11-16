// SPDX-License-Identifier: AGPL-3.0-only

// The engine's life: no context while the sound is off, the audio session
// ambient before one is made, a fade in as it starts, a fade out and then a
// suspend on a mute or a hidden page (and none undone by showing the page
// while muted), a resume and a fade in on unmuting, and the sliders on the
// cube. A stand-in context records what the engine asks of it.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SoundEngine } from './engine';
import { MIX } from './mix';

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
