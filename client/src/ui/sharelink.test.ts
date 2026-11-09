// SPDX-License-Identifier: AGPL-3.0-only

// Sharing a link to watch: through the share sheet, or copied where there
// is none; a share closed is not copied. Make a new link, and the state
// each link keeps. The picture's crop, upright and sideways, and its
// share: with the file where the phone can share one, otherwise saved and
// the link copied.

import { describe, expect, test } from 'vitest';
import type { Fetch } from '../account/me';
import { linkState, makeNew, newLink, type Sharer, shareLink } from './sharelink';
import { cropOf, HEIGHT, sharePicture, stripWords, WIDTH } from './snapshot';

/** A sharer that records what it was asked, and fails as told. */
function sharer({
  share = true,
  canShare = true,
  fails = '',
  copyFails = false,
}: {
  share?: boolean;
  canShare?: boolean;
  /** The name of the error the share sheet throws; '' for none. */
  fails?: string;
  copyFails?: boolean;
} = {}): Sharer & { log: string[]; data: ShareData[] } {
  const log: string[] = [];
  const data: ShareData[] = [];
  return {
    log,
    data,
    ...(share
      ? {
          share: async (d: ShareData) => {
            data.push(d);
            log.push('share');
            if (fails !== '') {
              const e = new Error(fails);
              e.name = fails;
              throw e;
            }
          },
          canShare: () => canShare,
        }
      : {}),
    copy: async (t: string) => {
      log.push(`copy ${t}`);
      if (copyFails) {
        throw new Error('no clipboard');
      }
    },
  };
}

const link = { url: 'https://p/?w=k3x7q2mbwa', text: 'Watch Daneel sail: https://p/?w=k3x7q2mbwa' };

describe('sharing a link', () => {
  test('through the share sheet, the link in the text', async () => {
    const s = sharer();
    expect(await shareLink(link, s)).toBe('shared');
    expect(s.data).toEqual([{ text: link.text }]);
    expect(s.log).toEqual(['share']);
  });

  test('copied where there is no share sheet, or it refuses', async () => {
    const none = sharer({ share: false });
    expect(await shareLink(link, none)).toBe('copied');
    expect(none.log).toEqual([`copy ${link.url}`]);
    const refused = sharer({ fails: 'NotAllowedError' });
    expect(await shareLink(link, refused)).toBe('copied');
    expect(refused.log).toEqual(['share', `copy ${link.url}`]);
  });

  test('a share closed is not copied; a copy that fails is said to fail', async () => {
    const closed = sharer({ fails: 'AbortError' });
    expect(await shareLink(link, closed)).toBe('failed');
    expect(closed.log).toEqual(['share']);
    expect(await shareLink(link, sharer({ share: false, copyFails: true }))).toBe('failed');
  });
});

/** A server answering POST /api/me/link/new with status and body, recording what it was asked. */
function server(status: number, body: unknown): { f: Fetch; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    f: async (input, init) => {
      asked.push(`${init?.method} ${input} ${String(init?.body)}`);
      return new Response(JSON.stringify(body), { status });
    },
  };
}

describe('making a link anew', () => {
  test('asks for the link named, and answers its new code', async () => {
    const s = server(200, { code: 'newcode234' });
    expect(await newLink({ which: 'machine', machine: 'id-1' }, s.f)).toBe('newcode234');
    expect(s.asked).toEqual(['POST /api/me/link/new {"which":"machine","machine":"id-1"}']);
    expect(await newLink({ which: 'me' }, server(500, {}).f)).toBeNull();
    expect(await newLink({ which: 'me' }, server(200, {}).f)).toBeNull();
  });

  test('the link’s state takes the new code, and says so; or says none was made', async () => {
    const st = linkState('test-new', 'oldcode234');
    st.asking.value = true;
    st.copied.value = true;
    await makeNew(st, { which: 'fleet' }, server(200, { code: 'newcode234' }).f);
    expect(st.code.value).toBe('newcode234');
    expect(st.copied.value).toBe(false);
    expect(st.asking.value).toBe(false);
    expect(st.said.value).toBe('A new link: the old one no longer works.');
    await makeNew(st, { which: 'fleet' }, server(503, { error: 'unavailable' }).f);
    expect(st.code.value).toBe('newcode234');
    expect(st.said.value).toBe('A new link cannot be made just now. Try again.');
  });

  test('a link’s state is kept by its name, and takes a newer code the server tells', () => {
    const a = linkState('test-kept', 'one');
    a.code.value = 'made-here';
    expect(linkState('test-kept', 'one')).toBe(a);
    expect(a.code.value).toBe('made-here');
    linkState('test-kept', 'two');
    expect(a.code.value).toBe('two');
  });
});

describe('the picture', () => {
  test('16:9 from the middle: upright, the full width and the middle band', () => {
    expect(WIDTH / HEIGHT).toBeCloseTo(16 / 9, 3);
    expect(cropOf(1080, 1920)).toEqual({ x: 0, y: 656, w: 1080, h: 608 });
    expect(cropOf(1080, 1920).w / cropOf(1080, 1920).h).toBeCloseTo(16 / 9, 2);
  });

  test('sideways, the full height and the middle', () => {
    expect(cropOf(2400, 1080)).toEqual({ x: 240, y: 0, w: 1920, h: 1080 });
    expect(cropOf(1600, 900)).toEqual({ x: 0, y: 0, w: 1600, h: 900 });
  });

  test('its strip: the game’s name, and the sailor’s own', () => {
    expect(stripWords('Iron Mary')).toEqual({
      title: 'Keel Over the Edge',
      line: 'Watch Iron Mary sail',
    });
  });

  const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });

  test('shared as a file with the link at the end of its text', async () => {
    const s = sharer();
    const saved: Blob[] = [];
    expect(await sharePicture(blob, 'Daneel', link.url, s, (b) => saved.push(b))).toBe('shared');
    const d = s.data[0];
    expect(d?.text).toBe(`Watch Daneel sail on Keel Over the Edge: ${link.url}`);
    expect(d?.files?.[0]?.name).toBe('keel-over-the-edge.jpg');
    expect(d?.files?.[0]?.type).toBe('image/jpeg');
    expect(saved).toEqual([]);
  });

  test('saved and the link copied where a file cannot be shared, or the share refuses', async () => {
    for (const s of [
      sharer({ canShare: false }),
      sharer({ share: false }),
      sharer({ fails: 'NotAllowedError' }),
    ]) {
      const saved: Blob[] = [];
      expect(await sharePicture(blob, 'Daneel', link.url, s, (b) => saved.push(b))).toBe('saved');
      expect(saved).toEqual([blob]);
      expect(s.log.at(-1)).toBe(`copy ${link.url}`);
    }
  });

  test('a share closed is neither shared nor saved', async () => {
    const saved: Blob[] = [];
    const s = sharer({ fails: 'AbortError' });
    expect(await sharePicture(blob, 'Daneel', link.url, s, (b) => saved.push(b))).toBe('failed');
    expect(saved).toEqual([]);
    expect(s.log).toEqual(['share']);
  });
});
