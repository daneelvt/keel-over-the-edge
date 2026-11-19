// SPDX-License-Identifier: AGPL-3.0-only

// keel's status for the page's checks, as Access lets it through to the
// Worker: seed 1's recorded status, its world ending this coming Sunday
// at 6 pm in New York, from a port of its own. Run by the checks'
// configuration (playwright.config.ts) beside wrangler dev.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 5296);
const seed = JSON.parse(
  readFileSync(new URL('../../internal/status/testdata/seed1.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

/** This coming Sunday, 6 pm in New York, as the schedule's turn: within a week from now. */
function sunday(now: number): string {
  for (let d = 0; d <= 7; d++) {
    const t = new Date(now + d * 86400000);
    const ny = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'long',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(t);
    const p = (k: string) => ny.find((x) => x.type === k)?.value ?? '';
    if (p('weekday') === 'Sunday') {
      // 6 pm in New York is 23:00 UTC in winter, 22:00 in summer: either, roughly.
      const at = Date.parse(`${p('year')}-${p('month')}-${p('day')}T23:00:00Z`);
      if (at > now) {
        return new Date(at).toISOString().replace('.000', '');
      }
    }
  }
  return new Date(now + 7 * 86400000).toISOString();
}

createServer((req, res) => {
  if (req.url !== '/api/status') {
    res.writeHead(404).end();
    return;
  }
  const now = Date.now();
  const body = JSON.stringify({
    ...seed,
    atSea: 23,
    machinesAtSea: 6,
    endsAt: sunday(now),
    at: new Date(now).toISOString().replace(/\.\d+Z$/, 'Z'),
  });
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
}).listen(port, '127.0.0.1');
