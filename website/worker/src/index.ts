// SPDX-License-Identifier: AGPL-3.0-only

// The website's Worker, on keelovertheedge.com. The page, its pictures and
// fonts are static files, served without it; it answers what is live:
//
//   /           the page, in the hour's light (page.ts)
//   /live       the game's numbers, JSON, from keel's status
//   /map.svg    the world's chart now, as the game's chart draws it
//   /share.png  the share picture: the map, the name and the numbers
//   /next.ics   the world's end, every week, for a calendar
//
// keel's status is fetched through Cloudflare Access with the website's
// service token, and kept in this data centre's cache for 30 s; the map
// and the share picture are drawn when their 10 minutes there run out.
// Every 10 minutes a cron fetches the status and draws the map into KV:
// the last good copy, which a request reads only when keel does not
// answer, and serves marked resting; with none, a map with no world.
// A request never writes KV: the cron is its one writer.

import { secured } from './headers';
import { calendar } from './ics';
import { drawMap, markResting } from './map/draw';
import { inTheHour, servedHour } from './page';
import { sharePng } from './share';
import { isStatus, type Status } from './status';

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** The last good copy: the status and the map, written by the cron alone. */
  WEBSITE: KVNamespace;
  /** keel's status, behind Access. */
  STATUS_URL: string;
  /** The website's Access service token (secrets). */
  ACCESS_CLIENT_ID?: string;
  ACCESS_CLIENT_SECRET?: string;
}

/** The cache's keys, on the apex, and how long each is kept there, s. */
const APEX = 'https://keelovertheedge.com';
export const KEYS = {
  status: `${APEX}/live/status.json`,
  map: `${APEX}/map.svg`,
  share: `${APEX}/share.png`,
} as const;
export const KEPT = {
  status: 30,
  picture: 600,
  /** What is served resting, kept briefly: the sea comes back soon. */
  resting: 60,
  calendar: 3600,
} as const;

/** KV's keys for the last good copy. */
export const KV = { status: 'status', map: 'map.svg' } as const;

/** What the Worker reaches out with: fetch, the clock and the cache; tests give their own. */
export interface Outside {
  fetch: typeof fetch;
  now: () => number;
  cache: () => Cache;
}

const OUTSIDE: Outside = {
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
  cache: () => (caches as unknown as { default: Cache }).default,
};

/** The status held: keel's, or the last good copy's when keel does not answer (resting), or none. */
interface Held {
  status: Status | null;
  resting: boolean;
}

/** keel's status through Access, or null if it does not answer as it should. */
export async function fetchStatus(env: Env, out: Outside): Promise<Status | null> {
  if (!env.ACCESS_CLIENT_ID || !env.ACCESS_CLIENT_SECRET || !env.STATUS_URL) {
    return null;
  }
  try {
    const r = await out.fetch(env.STATUS_URL, {
      headers: {
        'CF-Access-Client-Id': env.ACCESS_CLIENT_ID,
        'CF-Access-Client-Secret': env.ACCESS_CLIENT_SECRET,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (r.status !== 200) {
      return null;
    }
    const s: unknown = await r.json();
    return isStatus(s) ? s : null;
  } catch {
    return null;
  }
}

function cacheable(
  body: BodyInit,
  type: string,
  seconds: number,
  more: Record<string, string> = {},
): Response {
  return new Response(body, {
    headers: { 'Content-Type': type, 'Cache-Control': `public, max-age=${seconds}`, ...more },
  });
}

/** The status, from the cache, else keel, else KV's last good copy. */
async function held(env: Env, ctx: ExecutionContext, out: Outside): Promise<Held> {
  const cache = out.cache();
  const hit = await cache.match(KEYS.status);
  if (hit !== undefined) {
    return (await hit.json()) as Held;
  }
  const fresh = await fetchStatus(env, out);
  let h: Held;
  if (fresh !== null) {
    h = { status: fresh, resting: false };
  } else {
    const kept: unknown = await env.WEBSITE.get(KV.status, 'json');
    h = { status: isStatus(kept) ? kept : null, resting: true };
  }
  const seconds = h.resting ? KEPT.resting : KEPT.status;
  ctx.waitUntil(cache.put(KEYS.status, cacheable(JSON.stringify(h), 'application/json', seconds)));
  return h;
}

/** The numbers the page shows, and whether the sea rests. */
function live(h: Held): Record<string, unknown> {
  const s = h.status;
  if (s === null) {
    return { resting: true };
  }
  return {
    atSea: s.atSea,
    machinesAtSea: s.machinesAtSea,
    queued: s.queued,
    world: s.world,
    ...(s.endsAt === undefined ? {} : { endsAt: s.endsAt }),
    closing: s.closing,
    ...(s.turn === undefined ? {} : { turn: s.turn }),
    charted: s.charted,
    hour: s.hour,
    at: s.at,
    resting: h.resting,
  };
}

/** The map: drawn from keel's status, or KV's last good one marked resting, or a resting map with no world. */
async function mapOf(
  env: Env,
  ctx: ExecutionContext,
  out: Outside,
): Promise<{ svg: string; held: Held }> {
  const h = await held(env, ctx, out);
  if (!h.resting && h.status !== null) {
    return { svg: drawMap({ status: h.status, resting: false }), held: h };
  }
  const kept = await env.WEBSITE.get(KV.map, 'text');
  return {
    svg: kept !== null ? markResting(kept) : drawMap({ status: null, resting: true }),
    held: h,
  };
}

const SVG = 'image/svg+xml; charset=utf-8';

async function map(env: Env, ctx: ExecutionContext, out: Outside): Promise<Response> {
  const cache = out.cache();
  const hit = await cache.match(KEYS.map);
  if (hit !== undefined) {
    return hit;
  }
  const m = await mapOf(env, ctx, out);
  const r = cacheable(m.svg, SVG, m.held.resting ? KEPT.resting : KEPT.picture);
  ctx.waitUntil(cache.put(KEYS.map, r.clone()));
  return r;
}

async function share(env: Env, ctx: ExecutionContext, out: Outside): Promise<Response> {
  const cache = out.cache();
  const hit = await cache.match(KEYS.share);
  if (hit !== undefined) {
    return hit;
  }
  const kept = await cache.match(KEYS.map);
  const m =
    kept !== undefined
      ? { svg: await kept.text(), held: await held(env, ctx, out) }
      : await mapOf(env, ctx, out);
  const png = await sharePng(m.svg, m.held.status, m.held.resting);
  const r = cacheable(
    png as Uint8Array<ArrayBuffer>,
    'image/png',
    m.held.resting ? KEPT.resting : KEPT.picture,
  );
  ctx.waitUntil(cache.put(KEYS.share, r.clone()));
  return r;
}

async function ics(env: Env, ctx: ExecutionContext, out: Outside): Promise<Response> {
  const h = await held(env, ctx, out);
  const turn = h.status?.turn;
  if (turn === undefined) {
    return new Response('The calendar is not to hand just now. Try again soon.\n', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '600' },
    });
  }
  return cacheable(
    calendar(turn, h.status?.endsAt, out.now()),
    'text/calendar; charset=utf-8',
    KEPT.calendar,
    {
      'Content-Disposition': 'attachment; filename="keel-over-the-edge.ics"',
    },
  );
}

/** Answers a request: each live address, and the page, all with the security headers. */
export async function answer(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  out: Outside = OUTSIDE,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return secured(
      new Response('Only GET here.\n', { status: 405, headers: { Allow: 'GET, HEAD' } }),
    );
  }
  let r: Response;
  switch (url.pathname) {
    case '/':
      r = inTheHour(await env.ASSETS.fetch(request), servedHour(url, out.now()));
      break;
    case '/live':
      r = cacheable(
        JSON.stringify(live(await held(env, ctx, out))),
        'application/json',
        KEPT.status,
      );
      break;
    case '/map.svg':
      r = await map(env, ctx, out);
      break;
    case '/share.png':
      r = await share(env, ctx, out);
      break;
    case '/next.ics':
      r = await ics(env, ctx, out);
      break;
    default:
      r = new Response('Not here.\n', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
  }
  r = secured(r);
  return request.method === 'HEAD' ? new Response(null, r) : r;
}

/** The cron: keel's status and the map drawn from it into KV, the last good copy; nothing when keel does not answer. */
export async function refresh(env: Env, out: Outside = OUTSIDE): Promise<boolean> {
  const s = await fetchStatus(env, out);
  if (s === null) {
    console.warn('website: keel did not answer; the last good copy stays');
    return false;
  }
  await env.WEBSITE.put(KV.status, JSON.stringify(s));
  await env.WEBSITE.put(KV.map, drawMap({ status: s, resting: false }));
  return true;
}

export default {
  fetch(request, env, ctx) {
    return answer(request, env, ctx);
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(refresh(env));
  },
} satisfies ExportedHandler<Env>;
