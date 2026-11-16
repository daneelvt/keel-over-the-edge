// SPDX-License-Identifier: AGPL-3.0-only

// The sound's loudness budget, measured: the real engine rendered offline
// at each scene of e2e/audioscenes.ts (e2e/audio.html, no GPU), at full
// volume, and held to it, so no change makes the game loud again. Typical
// sailing (the gentle and the fresh breeze together) at −20 ±2 LUFS, each
// step of weather at most 6 LU louder than the last and a gale at most
// −16; a calm heard, at least −36, and the harbour at most −24; the true
// peak at most −1 dBTP everywhere, nothing momentarily more than 10 LU
// over its scene, the limiter all but idle in typical weather (1 dB) and
// in a storm (3 dB); and at most 15% of the bed's energy above 2 kHz in
// typical weather, 30% in a storm. At the default volume, 70%, everything
// is 9.3 dB lower. The bow's slaps, the sheet and the boom, the halyards
// and the surf play in it as the scenes have them.
//
// The recordings: the game's own (the probe and the test sea) decode from
// both formats as long as their numbers say; a file not there, or not
// sound, leaves its voice synthesised while the rest load; and played in
// every bed's voice in place of its synthesis, a recording takes over at
// its synthesis's loudness, the budget holding. The sound room plays, lists
// every voice, plays a recording in one at B, and reads the meter.
//
// And the controls on the game's page: no audio context while the sound
// is off, the M key's mute held through the page hidden and shown, and
// the Sound block's sliders kept on the device.
//
// KEEL_AUDIO_OUT names a folder to write each scene's rendering into (WAV,
// and an AAC copy by ffmpeg) with the table, KEEL_AUDIO_SECONDS how long
// each is (2 minutes for listening; the scenes repeat every 30 s).

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import type { Measured } from './audio';

/** The scenes, as e2e/audioscenes.ts names them, and the weather each is sailed in for the budget. */
const SCENES = {
  calm: 'typical',
  harbour: 'typical',
  gentle: 'typical',
  fresh: 'typical',
  gale: 'storm',
  fog: 'typical',
  squall: 'storm',
  edge: 'typical',
  shore: 'typical',
  race: 'typical',
} as const;

type Scene = keyof typeof SCENES;

/** How long each scene is rendered, s: one turn of its script. */
const SECONDS = Number(process.env.KEEL_AUDIO_SECONDS ?? '30');

const OUT = process.env.KEEL_AUDIO_OUT ?? '';

/** A WAV of interleaved stereo 32-bit floats. */
function wav(samples: Buffer, rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + samples.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(3, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 8, 28);
  h.writeUInt16LE(8, 32);
  h.writeUInt16LE(32, 34);
  h.write('data', 36);
  h.writeUInt32LE(samples.length, 40);
  return Buffer.concat([h, samples]);
}

/** Writes the page's last rendering to OUT as name.wav and name.m4a. */
async function save(page: Page, name: string): Promise<void> {
  const parts: Buffer[] = [];
  for (let s = 0; s < SECONDS; s += 10) {
    const b64 = await page.evaluate(([a, b]) => globalThis.audio.pcm(a, b), [
      s,
      Math.min(SECONDS, s + 10),
    ] as const);
    parts.push(Buffer.from(b64, 'base64'));
  }
  const file = `${OUT}/${name}.wav`;
  writeFileSync(file, wav(Buffer.concat(parts), 48000));
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-i',
    file,
    '-b:a',
    '128k',
    `${OUT}/${name}.m4a`,
  ]);
}

test.describe('the loudness budget', () => {
  test.describe.configure({ mode: 'serial' });

  let page: Page;
  const m = {} as Record<Scene, Measured>;
  let fresh70: Measured;
  /** Typical sailing: the gentle and the fresh breeze heard one after the other, LUFS. */
  let typical = 0;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    page = await browser.newPage();
    await page.goto('/e2e/audio.html');
    await page.waitForFunction(() => globalThis.audio !== undefined);
    expect(await page.evaluate(() => globalThis.audio.scenes)).toEqual(Object.keys(SCENES));
    if (OUT !== '') {
      mkdirSync(OUT, { recursive: true });
    }
    for (const name of Object.keys(SCENES) as Scene[]) {
      m[name] = await page.evaluate(([n, s]) => globalThis.audio.render(n, s), [
        name,
        SECONDS,
      ] as const);
      if (OUT !== '') {
        await save(page, name);
      }
    }
    typical = await page.evaluate(() => globalThis.audio.typical(['gentle', 'fresh']));
    fresh70 = await page.evaluate(([s]) => globalThis.audio.render('fresh', s, { volume: 0.7 }), [
      SECONDS,
    ] as const);
    const rows = (Object.keys(SCENES) as Scene[]).map((n) => {
      const r = m[n];
      const f = (v: number): string => v.toFixed(1);
      return `| ${n} | ${f(r.integrated)} | ${f(r.samplePeak)} | ${f(r.truePeak)} | ${f(r.momentaryMax)} | ${f(r.range)} | ${Math.round(100 * r.bedAbove)}% | ${f(r.reduction)} |`;
    });
    const table = [
      '| Scene | Integrated, LUFS | Sample peak, dBFS | True peak, dBTP | Most momentary, LUFS | Range, LU | Bed above 2 kHz | Limiter, dB |',
      '|---|---|---|---|---|---|---|---|',
      ...rows,
      '',
      `Typical sailing (gentle and fresh): ${typical.toFixed(1)} LUFS; at the default volume (70%): ${(typical + fresh70.integrated - m.fresh.integrated).toFixed(1)} LUFS.`,
    ].join('\n');
    await test.info().attach('loudness', { body: table, contentType: 'text/markdown' });
    if (OUT !== '') {
      writeFileSync(`${OUT}/table.md`, `${table}\n`);
      writeFileSync(`${OUT}/table.json`, JSON.stringify({ ...m, typical, fresh70 }, null, 2));
    }
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('every scene plays what it is about', () => {
    expect(m.harbour.played.harbour).toBeGreaterThan(5);
    expect(m.gentle.played.life).toBeGreaterThan(0);
    expect(m.fresh.played.life).toBeGreaterThan(0);
    expect(m.fog.played.fog).toBeGreaterThan(0);
    expect(m.squall.played.thunder).toBeGreaterThanOrEqual(2);
    expect(m.race.played.guns).toBeGreaterThanOrEqual(4);
    expect(m.race.played.cheers).toBeGreaterThanOrEqual(2);
    // The boat's motion: the bow slapping in a sea, the sheet in a tack,
    // the boom in a gybe; and the halyards in port.
    for (const name of ['fresh', 'gale', 'squall'] as const) {
      expect(m[name].played.slaps, name).toBeGreaterThan(3);
    }
    expect(m.calm.played.slaps).toBe(0);
    expect(m.fresh.played.sheets).toBeGreaterThanOrEqual(1);
    expect(m.gentle.played.booms).toBeGreaterThanOrEqual(1);
    expect(m.harbour.played.taps).toBeGreaterThan(3);
  });

  test('typical sailing is at −20 ±2 LUFS', () => {
    expect(typical).toBeGreaterThanOrEqual(-22);
    expect(typical).toBeLessThanOrEqual(-18);
  });

  test('each step of weather is at most 6 LU louder, and a gale at most −16 LUFS', () => {
    expect(m.fresh.integrated - m.gentle.integrated).toBeLessThanOrEqual(6);
    expect(m.gale.integrated - m.fresh.integrated).toBeLessThanOrEqual(6);
    expect(m.gale.integrated).toBeLessThanOrEqual(-16);
    expect(m.squall.integrated).toBeLessThanOrEqual(-16);
  });

  test('a calm is heard, and the harbour is quiet', () => {
    expect(m.calm.integrated).toBeGreaterThanOrEqual(-36);
    expect(m.harbour.integrated).toBeLessThanOrEqual(-24);
  });

  test('no scene peaks over −1 dBTP or stands out more than 10 LU over itself', () => {
    for (const [name, r] of Object.entries(m)) {
      expect(r.truePeak, name).toBeLessThanOrEqual(-1);
      expect(r.momentaryMax - r.integrated, name).toBeLessThanOrEqual(10);
    }
  });

  test('the limiter all but idles: at most 1 dB in typical weather, 3 dB in a storm', () => {
    for (const [name, r] of Object.entries(m)) {
      expect(r.reduction, name).toBeLessThanOrEqual(SCENES[name as Scene] === 'storm' ? 3 : 1);
    }
  });

  test('the bed hisses little: at most 15% of its energy above 2 kHz in typical weather, 30% in a storm', () => {
    for (const [name, r] of Object.entries(m)) {
      expect(r.bedAbove, name).toBeLessThanOrEqual(SCENES[name as Scene] === 'storm' ? 0.3 : 0.15);
    }
  });

  test('at the default volume, 70%, the sound is 9.3 dB quieter', () => {
    expect(Math.abs(fresh70.integrated - m.fresh.integrated + 9.29)).toBeLessThan(0.2);
  });
});

test.describe('the recordings', () => {
  test.describe.configure({ mode: 'serial' });
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.goto('/e2e/audio.html');
    await page.waitForFunction(() => globalThis.audio !== undefined);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('the game’s own decode from WebM and from AAC, as long and as wide as their numbers say, within the sizes', async () => {
    const files = await page.evaluate(() => globalThis.audio.decodeOwn());
    expect(files).toHaveLength(4);
    for (const f of files) {
      const label = `${f.name}.${f.format}`;
      expect(f.channels, label).toBe(1);
      // AAC's frames round a short file up by a few milliseconds.
      expect(Math.abs(f.length / 48000 - f.seconds), label).toBeLessThan(0.05);
      const declared = await page.evaluate((n) => globalThis.audio.declared(n as 'probe'), f.name);
      expect(f.decoded, label).toBeLessThanOrEqual(declared * 1.05 + 4096 * 4);
    }
    // The probe is about a kilobyte in each format; the decoded set far
    // within its 40 MB, and what is fetched within its 3 MB.
    for (const f of files.filter((x) => x.name === 'probe')) {
      expect(f.bytes).toBeLessThanOrEqual(1536);
    }
    const decoded = files.filter((f) => f.format === 'webm').reduce((s, f) => s + f.decoded, 0);
    expect(decoded).toBeLessThanOrEqual(40 << 20);
    for (const format of ['webm', 'm4a']) {
      const bytes = files.filter((f) => f.format === format).reduce((s, f) => s + f.bytes, 0);
      expect(bytes, format).toBeLessThanOrEqual(3 << 20);
    }
  });

  test('a file not there, or not sound, leaves its voice synthesised; the rest load', async () => {
    const out = await page.evaluate(() => globalThis.audio.loadWithFaults());
    expect(out.format).toBe('webm');
    expect(out.loaded).toEqual(['test-sea']);
    expect([...out.failed].sort()).toEqual(['gone', 'not-sound']);
    expect(out.recorded).toEqual(['sea.moderate']);
  });

  test('in every bed’s voice, a recording takes over at its synthesis’s loudness, and the budget holds', async () => {
    test.setTimeout(120_000);
    const voices = [
      'wind.light',
      'wind.moderate',
      'wind.strong',
      'wind.gale',
      'hull.chuckle',
      'hull.wash',
      'hull.bow',
      'sea.calm',
      'sea.moderate',
      'sea.rough',
      'rain.light',
      'rain.heavy',
      'flog',
      'lapping',
      'halyards',
      'surf',
    ] as const;
    for (const name of ['calm', 'harbour', 'fresh', 'gale', 'squall', 'shore'] as const) {
      const [synth, rec] = await page.evaluate(
        async ([n, v]) => [
          await globalThis.audio.render(n, 30),
          await globalThis.audio.render(n, 30, { recorded: { voices: [...v], crossfade: 3 } }),
        ],
        [name, voices] as const,
      );
      expect(Math.abs(rec.bed - synth.bed), name).toBeLessThanOrEqual(
        SCENES[name] === 'storm' ? 3 : 1.5,
      );
      expect(rec.truePeak, name).toBeLessThanOrEqual(-1);
      expect(rec.momentaryMax - rec.integrated, name).toBeLessThanOrEqual(10);
      expect(rec.bedAbove, name).toBeLessThanOrEqual(SCENES[name] === 'storm' ? 0.3 : 0.15);
    }
  });
});

test('the sound room plays every voice, a file in one at B, and reads the meter', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto('/sounds.html');
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.locator('.room-voice')).toHaveCount(19);
  const sea = page.locator('.room-voice', { hasText: 'sea.moderate' });
  await sea.getByRole('combobox').selectOption({ label: 'recording: test-sea.webm' });
  await sea.getByRole('button', { name: 'B' }).click();
  await expect(sea).toContainText('2.0 s, 1 ch');
  await expect(page.locator('.room-meter')).toContainText(/Recorded +sea \d+%/);
  await expect(page.locator('.room-meter')).toContainText(/Integrated +-\d+\.\d LUFS/);
  await sea.getByRole('button', { name: 'A' }).click();
  await expect(page.locator('.room-meter')).toContainText(/Recorded +none/);
  // Laid out within a phone's width.
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(360);
});

test.describe('the sound’s controls', () => {
  /** The sandbox's page, drawing nothing, with the test hooks. */
  async function open(page: Page): Promise<void> {
    await page.goto('/?sandbox&test&draw=off');
    await page.waitForFunction(() => globalThis.keel !== undefined, null, { timeout: 30_000 });
    await page.evaluate(() => globalThis.keel.ready());
  }

  const state = (page: Page): Promise<string> => page.evaluate(() => globalThis.keel.soundState());
  const notice = (page: Page): Promise<string> =>
    page.evaluate(() => globalThis.keel.encounters().bump);
  const show = async (page: Page, shown: boolean): Promise<void> => {
    await page.evaluate((shown) => {
      Object.defineProperty(document, 'visibilityState', {
        value: shown ? 'visible' : 'hidden',
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    }, shown);
  };

  test('no context is made while the sound is off; M turns it on and starts it', async ({
    page,
  }) => {
    await open(page);
    await page.evaluate(() => globalThis.keel.settings({ sound: false }));
    await page.mouse.click(480, 200);
    await page.keyboard.press('KeyW');
    expect(await state(page)).toBe('none');
    await page.keyboard.press('KeyM');
    await page.waitForFunction(() => globalThis.keel.soundState() === 'running');
    expect(await notice(page)).toBe('Sound on');
  });

  test('M mutes, and the mute holds while the page is hidden and shown again', async ({ page }) => {
    await open(page);
    await page.mouse.click(480, 200);
    await page.waitForFunction(() => globalThis.keel.soundState() === 'running');
    await page.keyboard.press('KeyM');
    expect(await notice(page)).toBe('Sound off');
    // It fades out first, then is suspended.
    await page.waitForFunction(() => globalThis.keel.soundState() === 'suspended');
    await show(page, false);
    await show(page, true);
    await page.mouse.click(480, 200);
    await page.waitForTimeout(300);
    expect(await state(page)).toBe('suspended');
    await page.keyboard.press('KeyM');
    await page.waitForFunction(() => globalThis.keel.soundState() === 'running');
    expect(await notice(page)).toBe('Sound on');
    // Hidden, it is suspended; shown, it runs again.
    await show(page, false);
    await page.waitForFunction(() => globalThis.keel.soundState() === 'suspended');
    await show(page, true);
    await page.waitForFunction(() => globalThis.keel.soundState() === 'running');
  });

  test('the Sound block’s sliders start at 70%, 100% and 100%, apply as they move, and are kept', async ({
    page,
  }) => {
    await open(page);
    await page.getByRole('button', { name: 'Menu' }).click();
    const block = page.getByRole('group', { name: 'Sound' });
    const volume = block.getByRole('slider', { name: 'Volume' });
    await expect(block.getByRole('checkbox', { name: 'Sound' })).toBeChecked();
    await expect(volume).toHaveValue('0.7');
    await expect(volume).toHaveAttribute('aria-valuetext', '70%');
    await expect(block.getByRole('slider', { name: 'Sea and wind' })).toHaveValue('1');
    await expect(block.getByRole('slider', { name: 'Sounds' })).toHaveValue('1');
    await volume.fill('0.35');
    await expect(volume).toHaveAttribute('aria-valuetext', '35%');
    await block.getByRole('slider', { name: 'Sounds' }).fill('0.5');
    const kept = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('keel.settings') ?? '{}'),
    );
    expect(kept).toMatchObject({ volume: 0.35, soundsVolume: 0.5, seaVolume: 1 });
    await page.reload();
    await page.waitForFunction(() => globalThis.keel !== undefined, null, { timeout: 30_000 });
    await page.getByRole('button', { name: 'Menu' }).click();
    await expect(
      page.getByRole('group', { name: 'Sound' }).getByRole('slider', { name: 'Volume' }),
    ).toHaveValue('0.35');
  });
});
