// SPDX-License-Identifier: AGPL-3.0-only

// The recordings' loading: nothing fetched while none is listed; the
// format chosen by decoding the probe, WebM first; then one at a time,
// beds before shots and what is heard most first, each decoded after a
// frame; and a file missing or refused by the decoder left to its
// synthesis while the rest load. And the recordings' numbers' files name
// voices the engine has.

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  decodedBytes,
  type LoaderHost,
  load,
  type Numbers,
  RECORDED,
  type Recording,
  recordings,
  VOICES,
} from './recorded';

const dir = new URL('../../../art/sound/recorded/', import.meta.url);

function rec(name: string, voice: string, kind: 'bed' | 'shot'): Recording {
  return {
    name,
    voice,
    kind,
    gain: 0,
    seconds: 1,
    channels: 1,
    bytes: { webm: 1, m4a: 1 },
    urls: { webm: `${name}.webm`, m4a: `${name}.m4a` },
  };
}

const probe = rec('probe', '', 'bed');
probe.kind = 'probe';

/** A host whose files are those named, each decoding unless refused; it logs what it was asked, in order. */
function host(
  files: string[],
  refuses: string[] = [],
  need: Record<string, number> = {},
): LoaderHost & { log: string[]; loadedNames: string[] } {
  const log: string[] = [];
  const loadedNames: string[] = [];
  let busy = 0;
  return {
    log,
    loadedNames,
    async fetch(url) {
      log.push(`fetch ${url}`);
      if (!files.includes(url)) {
        throw new Error(`${url}: 404`);
      }
      return new TextEncoder().encode(url).buffer as ArrayBuffer;
    },
    async frame() {
      log.push('frame');
    },
    async decode(data) {
      busy++;
      expect(busy).toBe(1);
      const url = new TextDecoder().decode(data);
      log.push(`decode ${url}`);
      await Promise.resolve();
      busy--;
      if (refuses.includes(url)) {
        throw new Error('EncodingError');
      }
      return { length: 100 } as AudioBuffer;
    },
    need: (r) => need[r.name] ?? 0,
    loaded: (r) => {
      loadedNames.push(r.name);
    },
  };
}

describe('loading the recordings', () => {
  test('the game lists none yet, so it fetches nothing', async () => {
    expect(RECORDED.voices).toEqual([]);
    const h = host([]);
    const out = await load(h, RECORDED.voices, RECORDED.probe);
    expect(h.log).toEqual([]);
    expect(out.format).toBeNull();
  });

  test('the format is WebM where its probe decodes', async () => {
    const h = host(['probe.webm', 'probe.m4a', 'sea.webm']);
    const out = await load(h, [rec('sea', 'sea.moderate', 'bed')], probe);
    expect(out.format).toBe('webm');
    expect(h.log.filter((l) => l.startsWith('fetch'))).toEqual([
      'fetch probe.webm',
      'fetch sea.webm',
    ]);
    expect(out.loaded).toEqual(['sea']);
  });

  test('AAC where WebM will not decode', async () => {
    const h = host(['probe.webm', 'probe.m4a', 'sea.m4a'], ['probe.webm']);
    const out = await load(h, [rec('sea', 'sea.moderate', 'bed')], probe);
    expect(out.format).toBe('m4a');
    expect(out.loaded).toEqual(['sea']);
  });

  test('nothing more where neither decodes: every voice stays synthesised', async () => {
    const h = host(['probe.webm', 'probe.m4a'], ['probe.webm', 'probe.m4a']);
    const out = await load(
      h,
      [rec('sea', 'sea.moderate', 'bed'), rec('slap', 'slap', 'shot')],
      probe,
    );
    expect(out.format).toBeNull();
    expect(out.failed).toEqual(['sea', 'slap']);
    expect(h.log.filter((l) => l.startsWith('fetch'))).toEqual([
      'fetch probe.webm',
      'fetch probe.m4a',
    ]);
    expect(h.loadedNames).toEqual([]);
  });

  test('beds before shots, the most needed first, one at a time, each decoded after a frame', async () => {
    const list = [
      rec('slap', 'slap', 'shot'),
      rec('wind', 'wind.moderate', 'bed'),
      rec('lapping', 'lapping', 'bed'),
      rec('sea', 'sea.calm', 'bed'),
    ];
    const h = host(['probe.webm', 'slap.webm', 'wind.webm', 'lapping.webm', 'sea.webm'], [], {
      lapping: 0.3,
      sea: 0.1,
      wind: 0.05,
      slap: 1,
    });
    const out = await load(h, list, probe);
    expect(out.loaded).toEqual(['lapping', 'sea', 'wind', 'slap']);
    // Every decode but the probe's follows a frame.
    const rest = h.log.slice(h.log.indexOf('decode probe.webm') + 1);
    for (let i = 0; i < rest.length; i++) {
      if (rest[i]?.startsWith('decode')) {
        expect(rest[i - 1]).toBe('frame');
      }
    }
  });

  test('a file missing, or refused by the decoder, stays synthesised; the rest load', async () => {
    const failed: string[] = [];
    const h = host(['probe.webm', 'wind.webm', 'sea.webm'], ['sea.webm']);
    h.failed = (r) => failed.push(r.name);
    const out = await load(
      h,
      [rec('gone', 'surf', 'bed'), rec('sea', 'sea.calm', 'bed'), rec('wind', 'wind.light', 'bed')],
      probe,
    );
    expect(out.loaded).toEqual(['wind']);
    expect(out.failed.sort()).toEqual(['gone', 'sea']);
    expect(failed.sort()).toEqual(['gone', 'sea']);
  });

  test('stops when told to', async () => {
    let n = 0;
    const h = host(['probe.webm', 'a.webm', 'b.webm']);
    const out = await load(
      h,
      [rec('a', 'surf', 'bed'), rec('b', 'flog', 'bed')],
      probe,
      () => n++ > 0,
    );
    expect(out.loaded.length).toBeLessThan(2);
  });
});

describe('the recordings listed', () => {
  test('only those of a voice the engine has, of that voice’s kind, with both files', () => {
    const n = (voice: string, kind: Numbers['kind']): Numbers => ({
      kind,
      voice,
      gain: 0,
      seconds: 2,
      channels: 1,
      bytes: { webm: 1, m4a: 1 },
    });
    const { voices, probe } = recordings(
      {
        'x/probe.json': n('', 'probe'),
        'x/sea-calm.json': n('sea.calm', 'bed'),
        'x/slap-1.json': n('slap', 'shot'),
        'x/odd.json': n('trumpet', 'bed'),
        'x/wrong.json': n('slap', 'bed'),
        'x/lonely.json': n('surf', 'bed'),
      },
      {
        'x/probe.webm': 'p.webm',
        'x/probe.m4a': 'p.m4a',
        'x/sea-calm.webm': 's.webm',
        'x/sea-calm.m4a': 's.m4a',
        'x/slap-1.webm': 'l.webm',
        'x/slap-1.m4a': 'l.m4a',
        'x/odd.webm': 'o.webm',
        'x/odd.m4a': 'o.m4a',
        'x/wrong.webm': 'w.webm',
        'x/wrong.m4a': 'w.m4a',
        'x/lonely.webm': 'y.webm',
      },
    );
    expect(voices.map((v) => v.name)).toEqual(['sea-calm', 'slap-1']);
    expect(voices[0]?.urls).toEqual({ webm: 's.webm', m4a: 's.m4a' });
    expect(probe?.urls.webm).toBe('p.webm');
  });

  test('every numbers’ file in art/sound/recorded is a probe, or names a voice of its kind (or none)', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files).toContain('probe.json');
    for (const f of files) {
      const n = JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as Numbers;
      if (n.kind === 'probe' || n.voice === '') {
        continue;
      }
      expect(VOICES[n.voice as keyof typeof VOICES], f).toBe(n.kind);
    }
  });

  test('the game’s probe is listed; the tests’ own recording is not', () => {
    expect(RECORDED.probe?.name).toBe('probe');
    expect(RECORDED.voices.some((r) => r.name.startsWith('test-'))).toBe(false);
  });

  test('decoded, a recording is its samples as 32-bit floats', () => {
    expect(decodedBytes({ seconds: 30, channels: 2 })).toBe(30 * 48000 * 2 * 4);
  });
});
