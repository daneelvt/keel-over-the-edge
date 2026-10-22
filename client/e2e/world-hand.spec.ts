// SPDX-License-Identifier: AGPL-3.0-only

// The world by hand on the world page, against keel (tools/e2e): each
// control opens a confirmation in its card, which sends nothing when
// cancelled; confirmed, a new next world is made, and made again in its
// place; a confirmation left open across a switch is refused, and
// the page says so; the beginning's confirmation names the world's end in
// the schedule's zone, UTC's and the page's own, the time left counted
// down by keel's clock; the whole world is charted, and the control then
// says so. The page's zone is New Zealand's, unlike either of the others.
// It ends and charts the shared world, so the spec's name sorts it after
// the others that sail it; it reads the world's life as keel has it rather
// than assuming any.

import { type APIRequestContext, expect, type Locator, type Page, test } from '@playwright/test';

const internal = 'http://127.0.0.1:19090';
const owner = 'http://localhost:5184/owner/';

test.use({ timezoneId: 'Pacific/Auckland' });

test.beforeEach(() => {
  test.skip(test.info().project.name !== 'webgl2', 'the world page: one back end is enough');
});

type Next = { number: number; seed: string; created: number; stored: boolean };

type Life = {
  now: number;
  zone: string;
  world: number;
  ends: number;
  remakeUntil: number;
  switching: boolean;
  making: boolean;
  next: Next | null;
};

/** The world's life as keel's internal listener has it. */
async function life(request: APIRequestContext): Promise<Life> {
  const res = await request.get(`${internal}/owner/api/lifecycle.json`);
  expect(res.status()).toBe(200);
  return (await res.json()) as Life;
}

/** What is charted of the world, and how many subjects it has. */
async function charted(request: APIRequestContext): Promise<{ subjects: number; done: number }> {
  const res = await request.get(`${internal}/owner/api/charted.json`);
  expect(res.status()).toBe(200);
  const c = (await res.json()) as { subjects: number; charted: unknown[] };
  return { subjects: c.subjects, done: c.charted.length };
}

/** The world's life once nothing is under way: no switch, no next world being made. */
async function settled(request: APIRequestContext): Promise<Life> {
  let l: Life | null = null;
  await expect
    .poll(
      async () => {
        l = await life(request);
        return !l.switching && !l.making && (l.next === null || l.next.stored);
      },
      { timeout: 180_000, message: 'the world settled' },
    )
    .toBe(true);
  return l as unknown as Life;
}

/** Skips a test of making or beginning when the world's end is too near for either. */
function skipLate(l: Life): void {
  test.skip(l.remakeUntil > 0 && l.now > l.remakeUntil, 'too near the world’s end');
}

/**
 * The next world once stored, another than the one made at the moment given: keel here makes
 * every world from one seed, so a world made again is told apart by when its row was made.
 */
async function madeAgain(request: APIRequestContext, number: number, not = 0): Promise<Next> {
  let n: Next | null = null;
  await expect
    .poll(
      async () => {
        const l = await life(request);
        n = l.next;
        return !l.making && n !== null && n.stored && n.created !== not ? n.number : 0;
      },
      { timeout: 180_000, message: 'the next world made' },
    )
    .toBe(number);
  return n as unknown as Next;
}

/** Opens the world page and waits for its card of the world by hand. */
async function openHand(page: Page): Promise<Locator> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(owner);
  const card = page.locator('section[aria-label="The world by hand"]');
  await expect(card).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
  return card;
}

/** The page's POSTs from now on: a cancelled confirmation sends none. */
function posts(page: Page): string[] {
  const sent: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST') {
      sent.push(r.url());
    }
  });
  return sent;
}

/** A span counted down, "1d 03:12:09", in seconds. */
function seconds(countdown: string): number {
  const m = /^(\d+)d (\d+):(\d+):(\d+)$/.exec(countdown.trim());
  expect(m, countdown).not.toBeNull();
  const [d, h, mi, s] = (m as RegExpExecArray).slice(1).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  return ((d * 24 + h) * 60 + mi) * 60 + s;
}

test('a new next world: cancelled, nothing; confirmed, made, and made again', async ({
  page,
  request,
}) => {
  test.setTimeout(420_000);
  const before = await settled(request);
  skipLate(before);
  const m = before.world + 1;
  const card = await openHand(page);
  const sent = posts(page);
  const make = card.locator('button[name="make-next"]');
  const ask = card.locator('[data-field="confirmation"]');

  // Cancelled: nothing sent, the next world as it was.
  await expect(make).toBeEnabled({ timeout: 15_000 });
  await make.click();
  await expect(ask).toContainText(
    before.next === null ? `Make world ${m} now?` : `Discard world ${m} (seed`,
  );
  await card.locator('button[name="cancel"]').click();
  await expect(ask).toHaveCount(0);
  await page.waitForTimeout(1000);
  expect(sent).toEqual([]);
  expect((await life(request)).next?.seed).toBe(before.next?.seed);

  // Confirmed: a next world made under the next number.
  await make.click();
  await card.locator('button[name="confirm"]').click();
  await expect(page.locator('p.message')).toContainText(`Done: world ${m} to be made`);
  const made = await madeAgain(request, m, before.next?.created);

  // Made again: another world, the same number.
  await expect(make).toBeEnabled({ timeout: 30_000 });
  await make.click();
  await expect(ask).toContainText(`Discard world ${m} (seed ${made.seed.slice(0, 4)}`);
  await expect(ask).toContainText('which no one has sailed');
  await card.locator('button[name="confirm"]').click();
  await expect(page.locator('p.message')).toContainText(`Done: world ${m} to be made`);
  const again = await madeAgain(request, m, made.created);
  expect(again.created).toBeGreaterThan(made.created);
});

test('the beginning’s confirmation names the end in three zones and counts down by keel’s clock', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const l = await settled(request);
  skipLate(l);
  expect(l.ends).toBeGreaterThan(0);
  const card = await openHand(page);
  const sent = posts(page);
  await expect(card.locator('button[name="begin-next"]')).toBeEnabled({ timeout: 15_000 });
  await card.locator('button[name="begin-next"]').click();
  const ask = card.locator('[data-field="confirmation"]');
  await expect(ask).toContainText(`End world ${l.world} now and begin world ${l.world + 1}?`);
  await expect(ask).toContainText(`Every boat goes with world ${l.world}.`);

  // The end, in the schedule's zone, UTC's and the page's own: as the
  // page's bar at the top has it.
  const ends = ask.locator('[data-field="confirm-ends"]');
  const bar = (await page.locator('[data-field="ends"]').textContent()) ?? '';
  await expect(ends).toHaveText(bar);
  expect(bar).toContain('UTC');
  expect(bar).toMatch(/NZ[DS]T|GMT\+1[23]/);
  if (l.zone === 'America/New_York') {
    expect(bar).toMatch(/E[DS]T/);
  }

  // The time left, from one second to the next, by keel's clock.
  const left = ask.locator('[data-field="confirm-countdown"]');
  const first = (await left.textContent()) ?? '';
  await expect
    .poll(async () => (await left.textContent()) ?? '', { timeout: 5000 })
    .not.toBe(first);
  const k = await life(request);
  const shown = seconds((await left.textContent()) ?? '');
  expect(Math.abs(shown - (k.ends - k.now) / 1000)).toBeLessThan(5);

  await card.locator('button[name="cancel"]').click();
  await expect(ask).toHaveCount(0);
  await page.waitForTimeout(1000);
  expect(sent).toEqual([]);
  expect((await life(request)).world).toBe(l.world);
});

test('a confirmation left open across a switch is refused, and says so', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const l = await settled(request);
  skipLate(l);
  const w = l.world;
  const card = await openHand(page);
  await expect(card.locator('button[name="begin-next"]')).toBeEnabled({ timeout: 15_000 });
  await card.locator('button[name="begin-next"]').click();
  const ask = card.locator('[data-field="confirmation"]');
  await expect(ask).toContainText(`End world ${w} now`);

  // The world switched by another hand meanwhile.
  const res = await request.post(`${internal}/owner/api/world`, { data: { number: w } });
  expect(res.status(), await res.text()).toBe(202);
  await expect.poll(async () => (await life(request)).world, { timeout: 180_000 }).toBe(w + 1);
  await expect(page.locator('section.switch')).toContainText(`World ${w + 1}`, {
    timeout: 30_000,
  });

  // The confirmation still names the world it was opened on: refused.
  await expect(ask).toContainText(`End world ${w} now`);
  await card.locator('button[name="confirm"]').click();
  await expect(page.locator('p.message')).toContainText('Refused (409)');
  expect((await life(request)).world).toBe(w + 1);
});

test('the whole world charted: cancelled, nothing; confirmed, every subject', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  let l = await settled(request);
  let c = await charted(request);
  if (c.subjects > 0 && c.done >= c.subjects) {
    // Charted whole already, as a run before this one may have left it:
    // a new world first.
    skipLate(l);
    const res = await request.post(`${internal}/owner/api/world`, { data: { number: l.world } });
    expect(res.status(), await res.text()).toBe(202);
    await expect
      .poll(async () => (await life(request)).world, { timeout: 180_000 })
      .toBe(l.world + 1);
    l = await settled(request);
    c = await charted(request);
  }
  const w = l.world;
  expect(c.done).toBeLessThan(c.subjects);
  const card = await openHand(page);
  const sent = posts(page);
  const chart = card.locator('button[name="chart-whole"]');
  const ask = card.locator('[data-field="confirmation"]');
  await expect(chart).toHaveText('Chart the whole world', { timeout: 15_000 });
  await expect(chart).toBeEnabled();

  // Cancelled: nothing sent, nothing more charted.
  await chart.click();
  await expect(ask).toContainText(
    `Chart the ${c.subjects - c.done} subject${c.subjects - c.done === 1 ? '' : 's'} of world ${w} not yet charted (${c.done} of ${c.subjects} are)`,
  );
  await expect(ask).toContainText('credited to no one');
  await expect(ask).toContainText(`nothing will be left to discover in world ${w}`);
  await card.locator('button[name="cancel"]').click();
  await expect(ask).toHaveCount(0);
  await page.waitForTimeout(1000);
  expect(sent).toEqual([]);
  expect((await charted(request)).done).toBe(c.done);

  // Confirmed: every subject charted, and the control says so.
  await chart.click();
  await card.locator('button[name="confirm"]').click();
  await expect(page.locator('p.message')).toContainText(`Done: world ${w} to be charted whole`);
  await expect
    .poll(
      async () => {
        const now = await charted(request);
        return now.done >= now.subjects;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect(chart).toHaveText(`World ${w} is charted whole`, { timeout: 15_000 });
  await expect(chart).toBeDisabled();
});
