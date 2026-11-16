// SPDX-License-Identifier: AGPL-3.0-only

// The page written out from its source: every picture from the manifest,
// with its words, at its widths, lazy but for the opening; the opening's
// every hour in the page's data; the AI apps' links in its keys.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { claudeLink, cursorLink, MCP, vscodeLink } from '../src/words';
import { builtName, manifest, openings, writeOut } from './site';

const source = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const m = manifest();
const page = writeOut(source, m);

function attr(tag: string, name: string): string | null {
  const r = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return r === null ? null : (r[1] ?? '');
}

describe('the page written out', () => {
  test('no picture left unwritten, and every picture the manifest groups is on the page', () => {
    expect(page).not.toContain('<keel-');
    const groups = (
      JSON.parse(
        readFileSync(new URL('../../../art/website/manifest.json', import.meta.url), 'utf8'),
      ) as {
        groups: Record<string, string[]>;
      }
    ).groups;
    for (const name of Object.values(groups).flat()) {
      const p = m.pictures[name];
      expect(p, name).toBeDefined();
      for (const f of p?.files.avif ?? []) {
        expect(page, f.file).toContain(`/${builtName(f.file)} ${f.width}w`);
      }
    }
  });

  test('every picture with its words; the opening never lazy, first to load; the rest lazy', () => {
    const imgs = [...page.matchAll(/<img\b[^>]*>/g)].map((x) => x[0]);
    expect(imgs.length).toBeGreaterThan(20);
    for (const img of imgs) {
      expect(attr(img, 'alt'), img).not.toBeNull();
    }
    const opening = imgs.filter((i) => i.includes('data-o="wide jpeg"'));
    expect(opening).toHaveLength(1);
    expect(attr(opening[0] ?? '', 'fetchpriority')).toBe('high');
    expect(attr(opening[0] ?? '', 'loading')).toBeNull();
    expect(attr(opening[0] ?? '', 'alt')).toBe(m.pictures['edge-dusk']?.alt);
    // Every picture from the manifest has its words, and all but the opening wait to be near.
    for (const img of imgs.filter((i) => i.includes('/assets/') && !i.includes('data-o'))) {
      if ((attr(img, 'srcset') ?? '') !== '') {
        expect(attr(img, 'loading'), img).toBe('lazy');
        expect(attr(img, 'alt'), img).not.toBe('');
      }
    }
  });

  test('the opening upright on a phone held upright, wide else, AVIF first', () => {
    const tags = /<picture class="opening-picture">([\s\S]*?)<\/picture>/.exec(page)?.[1] ?? '';
    const order = [...tags.matchAll(/data-o="([^"]+)"/g)].map((x) => x[1]);
    expect(order).toEqual(['upright avif', 'upright jpeg', 'wide avif', 'wide jpeg']);
    expect(tags).toContain(`media="${m.opening.upright}"`);
  });

  test('each hour’s opening in the page’s data, for the Worker and the script', () => {
    const data = /<script type="application\/json" id="openings">([^<]*)<\/script>/.exec(page)?.[1];
    expect(data).toBeDefined();
    const o = JSON.parse(data ?? '{}') as Record<string, Record<string, string>>;
    expect(Object.keys(o).toSorted()).toEqual(['dawn', 'day', 'dusk', 'night']);
    expect(o).toEqual(JSON.parse(JSON.stringify(openings(m))));
    for (const hour of Object.values(o)) {
      for (const k of ['upright avif', 'upright jpeg', 'wide avif', 'wide jpeg', 'src', 'alt']) {
        expect(hour[k], k).toBeTruthy();
      }
    }
  });

  test('the AI apps’ links and the address in the keys, as words.ts makes them', () => {
    const amp = (s: string) => s.replaceAll('&', '&amp;');
    expect(page).toContain(`data-link="claude" href="${amp(claudeLink())}"`);
    expect(page).toContain(`data-link="cursor" href="${amp(cursorLink())}"`);
    expect(page).toContain(`data-link="vscode" href="${amp(vscodeLink())}"`);
    expect(page).toContain(`<code id="mcp">${MCP}</code>`);
    expect(page).not.toContain('href="#"');
    expect(page).not.toContain('@MCP@');
  });

  test('Set sail and the watch keys go into the game, as its links have them', () => {
    expect(page).toContain('class="go" href="https://play.keelovertheedge.com/"');
    expect(page).toContain('href="https://play.keelovertheedge.com/?watch"');
    expect(page).toContain('href="https://play.keelovertheedge.com/?watch=pick"');
  });
});
