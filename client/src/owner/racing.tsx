// SPDX-License-Identifier: AGPL-3.0-only

// Racing, on the world page's Accounts tab: the limits every sailor
// races by (races entered ahead, races started a day, races made a day,
// races owned not yet finished), how long before the world's end the last
// race may start, how often the Harbourmaster's races are run and in which
// boats, and the share of the Greenhorn Cups set at hours that suit the
// US. A change is first checked, keel saying in words what it would do,
// then set, as the page's other settings are.

import { Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { catalog } from '../catalog';
import { control, getJSON } from './api';
import type { Act } from './lifecycle';
import { plural } from './machines';

/** GET /owner/api/races. */
export interface RaceSettings {
  ahead: number;
  daily: number;
  made: number;
  owned: number;
  /** How long before the world's end the last race may start, s. */
  cutoff: number;
  /** How often the harbour races are run, hours. */
  every: number;
  /** The harbour races' boats, by catalog id, in their turn. */
  boats: string[];
  /** The Greenhorn Cups at hours that suit the US, %. */
  greenhornUS: number;
}

/** The hours the harbour races may be run every. */
export const EVERY = [1, 2, 3, 4, 6, 8, 12] as const;

/** The form's fields, as typed. */
export interface RaceFields {
  ahead: string;
  daily: string;
  made: string;
  owned: string;
  /** Hours. */
  cutoff: string;
  every: string;
  /** The boats in their turn, by catalog id, comma separated. */
  boats: string;
  greenhornUS: string;
}

/** The form filled with the settings as they are. */
export function fieldsOf(s: RaceSettings): RaceFields {
  return {
    ahead: String(s.ahead),
    daily: String(s.daily),
    made: String(s.made),
    owned: String(s.owned),
    cutoff: String(Math.round((s.cutoff / 3600) * 100) / 100),
    every: String(s.every),
    boats: s.boats.join(', '),
    greenhornUS: String(s.greenhornUS),
  };
}

/**
 * The change the form asks for: the fields that differ from the settings,
 * as keel takes them; null while a field is not a number keel could take.
 */
export function changeOf(s: RaceSettings, f: RaceFields): Partial<RaceSettings> | null {
  const whole = (v: string): number | null => {
    const n = Number(v);
    return v.trim() !== '' && Number.isInteger(n) && n >= 0 ? n : null;
  };
  const out: Partial<RaceSettings> = {};
  for (const k of ['ahead', 'daily', 'made', 'owned', 'every', 'greenhornUS'] as const) {
    const n = whole(f[k]);
    if (n === null) {
      return null;
    }
    if (n !== s[k]) {
      out[k] = n;
    }
  }
  const hours = Number(f.cutoff);
  if (f.cutoff.trim() === '' || !Number.isFinite(hours) || hours < 0) {
    return null;
  }
  const cutoff = Math.round(hours * 3600);
  if (cutoff !== s.cutoff) {
    out.cutoff = cutoff;
  }
  const boats = f.boats
    .split(',')
    .map((b) => b.trim())
    .filter((b) => b !== '');
  if (boats.length === 0 || boats.some((b) => !catalog.boats.some((k) => k.id === b))) {
    return null;
  }
  if (boats.join(',') !== s.boats.join(',')) {
    out.boats = boats;
  }
  return out;
}

/** A boat's name, by its catalog id. */
function boatName(id: string): string {
  return catalog.boats.find((b) => b.id === id)?.name ?? id;
}

/** The settings in words, a line each. */
export function racingWords(s: RaceSettings): [string, string][] {
  return [
    ['Races entered ahead', plural(s.ahead, 'race')],
    ['Races started a day', plural(s.daily, 'race')],
    ['Races made a day', plural(s.made, 'race')],
    ['Races owned not finished', plural(s.owned, 'race')],
    ['Last start before the end', plural(Math.round((s.cutoff / 3600) * 100) / 100, 'hour')],
    ['Harbour races', `every ${plural(s.every, 'hour')}`],
    ['Harbour boats', s.boats.map(boatName).join(', ') || 'none'],
    ['Greenhorn Cups at US hours', `${s.greenhornUS}%`],
  ];
}

/** keel's answer to a check or a change. */
interface RaceAnswer {
  settings: RaceSettings;
  words: string;
}

/** The owner's hand on racing: read, checked, then set. */
export function RacingSettings({ act }: { act: Act }) {
  const [settings, setSettings] = useState<RaceSettings | null>(null);
  const [fields, setFields] = useState<RaceFields | null>(null);
  const [asked, setAsked] = useState<{ body: Partial<RaceSettings>; words: string } | null>(null);
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);

  const read = (): void => {
    void getJSON<RaceSettings>('races')
      .then((s) => {
        setSettings(s);
        setFields(fieldsOf(s));
      })
      .catch((e: unknown) => setWhy(`Failed: ${String(e)}`));
  };
  useEffect(read, []);

  if (settings === null || fields === null) {
    return (
      <section class="card racing" aria-label="Racing">
        <h2>Racing</h2>
        <p class="small">{why === '' ? '—' : why}</p>
      </section>
    );
  }
  const change = changeOf(settings, fields);
  const set = (f: Partial<RaceFields>) => {
    setFields({ ...fields, ...f });
    setAsked(null);
  };
  const number = (k: keyof Omit<RaceFields, 'boats' | 'every'>, label: string, step = 1) => (
    <label class="racing-field" key={k}>
      <span>{label}</span>
      <input
        type="number"
        name={`racing-${k}`}
        min={0}
        step={step}
        value={fields[k]}
        onInput={(e) => set({ [k]: e.currentTarget.value })}
      />
    </label>
  );

  const check = (): void => {
    if (change === null || Object.keys(change).length === 0) {
      return;
    }
    setBusy(true);
    setWhy('');
    void control('races', { ...change, check: true })
      .then((a) => {
        if (!a.ok) {
          setWhy(`Refused (${a.status}): ${a.text}`);
          return;
        }
        setAsked({ body: change, words: (JSON.parse(a.text) as RaceAnswer).words });
      })
      .catch((e: unknown) => setWhy(`Failed: ${String(e)}`))
      .finally(() => setBusy(false));
  };

  return (
    <section class="card racing" aria-label="Racing">
      <h2>Racing</h2>
      <dl data-field="racing">
        {racingWords(settings).map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </Fragment>
        ))}
      </dl>
      <form
        class="racing-form"
        onSubmit={(e) => {
          e.preventDefault();
          check();
        }}
      >
        {number('ahead', 'Entered ahead')}
        {number('daily', 'Started a day')}
        {number('made', 'Made a day')}
        {number('owned', 'Owned not finished')}
        {number('cutoff', 'Hours before the end', 0.25)}
        <label class="racing-field">
          <span>Harbour races every</span>
          <select
            name="racing-every"
            value={fields.every}
            onChange={(e) => set({ every: e.currentTarget.value })}
          >
            {EVERY.map((h) => (
              <option key={h} value={String(h)}>
                {plural(h, 'hour')}
              </option>
            ))}
          </select>
        </label>
        {number('greenhornUS', 'Greenhorn Cups at US hours, %')}
        <label class="racing-field racing-boats">
          <span>
            Harbour boats in their turn, by id: {catalog.boats.map((b) => b.id).join(', ')}
          </span>
          <input
            type="text"
            name="racing-boats"
            autocomplete="off"
            spellcheck={false}
            value={fields.boats}
            onInput={(e) => set({ boats: e.currentTarget.value })}
          />
        </label>
        <button
          type="submit"
          name="racing-check"
          disabled={busy || change === null || Object.keys(change).length === 0}
        >
          Check
        </button>
      </form>
      {change === null ? (
        <p class="small" data-field="racing-why">
          Whole numbers of races, hours, a percentage from 0 to 100, and the catalog's boats by id.
        </p>
      ) : null}
      {why !== '' ? <p class="small error">{why}</p> : null}
      {asked !== null ? (
        <div class="confirm" data-field="racing-confirmation">
          <p>{asked.words}</p>
          <button
            type="button"
            name="racing-set"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void act('races', asked.body, 'racing settings changed').then(() => {
                setBusy(false);
                setAsked(null);
                read();
              });
            }}
          >
            Set
          </button>{' '}
          <button type="button" name="racing-cancel" onClick={() => setAsked(null)}>
            Cancel
          </button>
        </div>
      ) : null}
    </section>
  );
}
