// SPDX-License-Identifier: AGPL-3.0-only

// The page, as the Worker serves it: the built file, with the hour at sea
// written into it, so that it arrives in the hour's light with no script.
// The root element is given the hour's step of the page's colours
// (data-sky) and which picture opens it (data-opening), and the opening
// picture's sources are changed to that hour's, from the data the build
// wrote into the page (#openings). The hour is the sky's at the moment
// served, from the clock alone, as the game counts it; or the one the
// address asks for (?hour=8.5). Nothing here waits for keel.

import catalog from '../../../client/src/catalog/catalog.gen.json';
import { hourAt, hourFromQuery, openingAt, type SkyClock, skyStep } from '../../site/src/sky';

const SKY: SkyClock = {
  day: catalog.sky.day,
  epoch: catalog.sky.epoch,
  sunAtEpoch: catalog.sky.sunAtEpoch,
};

/** The hour the page is served at: the address's, or the sky's now. */
export function servedHour(url: URL, now: number): number {
  return hourFromQuery(url.searchParams) ?? hourAt(now, SKY);
}

/** The built page with the hour written in; anything but the page as it came. */
export function inTheHour(page: Response, hour: number): Response {
  if (page.status !== 200 || !(page.headers.get('Content-Type') ?? '').startsWith('text/html')) {
    return page;
  }
  const opening = openingAt(hour);
  let data = '';
  let sets: Record<string, string> | null = null;
  const sources = () => {
    if (sets === null) {
      try {
        const all = JSON.parse(data) as Record<string, Record<string, string>>;
        sets = all[opening] ?? {};
      } catch {
        sets = {};
      }
    }
    return sets;
  };
  const out = new HTMLRewriter()
    .on('html', {
      element(el) {
        el.setAttribute('data-sky', String(skyStep(hour)));
        el.setAttribute('data-opening', opening);
      },
    })
    .on('script#openings', {
      text(t) {
        data += t.text;
      },
    })
    .on('.opening-picture [data-o]', {
      element(el) {
        const o = sources();
        const set = o[el.getAttribute('data-o') ?? ''];
        if (set !== undefined) {
          el.setAttribute('srcset', set);
        }
        if (el.tagName === 'img') {
          if (o.src !== undefined) {
            el.setAttribute('src', o.src);
          }
          if (o.alt !== undefined) {
            el.setAttribute('alt', o.alt);
          }
        }
      },
    })
    .transform(page);
  // Each answer its own hour's: never kept as the file is.
  const r = new Response(out.body, out);
  r.headers.delete('ETag');
  r.headers.delete('Content-Length');
  r.headers.set('Cache-Control', 'no-cache');
  return r;
}
