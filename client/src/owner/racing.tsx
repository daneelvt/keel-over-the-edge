// SPDX-License-Identifier: AGPL-3.0-only

// Racing, on the world page's Settings tab: the limits every sailor
// races by (races entered ahead, races started a day, races made a day,
// races owned not yet finished), how long before the world's end the last
// race may start, how often the Harbourmaster's races are run and in which
// boats, and the share of the Greenhorn Cups set at hours that suit the
// US. A change is first checked, keel saying in words what it would do,
// then set, as the page's other settings are.

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
  const saved = fieldsOf(settings);
  const changes = change === null ? 0 : Object.keys(change).length;
  const set = (f: Partial<RaceFields>) => {
    setFields({ ...fields, ...f });
    setAsked(null);
  };
  /** A field's label, marked while it differs from what is set. */
  const field = (k: keyof RaceFields): string =>
    `racing-field${fields[k] !== saved[k] ? ' changed' : ''}`;
  const number = (
    k: keyof Omit<RaceFields, 'boats' | 'every'>,
    label: string,
    unit: string,
    step = 1,
  ) => (
    <label class={field(k)} key={k}>
      <span>{label}</span>
      <span class="with-unit">
        <input
          type="number"
          inputmode="decimal"
          name={`racing-${k}`}
          min={0}
          step={step}
          value={fields[k]}
          onInput={(e) => set({ [k]: e.currentTarget.value })}
        />
        <span class="unit">{unit}</span>
      </span>
    </label>
  );
  // The harbour's boats in their turn, as the field holds them.
  const turn = fields.boats
    .split(',')
    .map((b) => b.trim())
    .filter((b) => b !== '');
  const setTurn = (boats: string[]): void => set({ boats: boats.join(', ') });

  const check = (): void => {
    if (change === null || changes === 0) {
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
      <form
        class="racing-form"
        data-field="racing"
        onSubmit={(e) => {
          e.preventDefault();
          check();
        }}
      >
        <h3>A sailor's limits</h3>
        {number('ahead', 'Entered ahead', 'races')}
        {number('daily', 'Started a day', 'races')}
        {number('made', 'Made a day', 'races')}
        {number('owned', 'Owned, not finished', 'races')}
        <h3>The world's races</h3>
        {number('cutoff', 'Last start before the end', 'hours', 0.25)}
        {number('greenhornUS', 'Greenhorn Cups at US hours', '%')}
        <label class={field('every')}>
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
        <div class={`${field('boats')} racing-boats`}>
          <span>Harbour boats, in their turn</span>
          <ol class="turn" data-field="racing-boats">
            {turn.map((b, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a boat may come twice; its place is what it is.
              <li key={i}>
                {boatName(b)}
                <button
                  type="button"
                  class="drop"
                  aria-label={`Take ${boatName(b)} out of place ${i + 1}`}
                  onClick={() => setTurn(turn.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </li>
            ))}
            <li class="add">
              <select
                name="racing-add-boat"
                aria-label="Add a boat to the turn"
                value=""
                onChange={(e) => {
                  if (e.currentTarget.value !== '') {
                    setTurn([...turn, e.currentTarget.value]);
                  }
                }}
              >
                <option value="">Add a boat…</option>
                {catalog.boats.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </li>
          </ol>
        </div>
        <p class="racing-keys">
          <button
            type="submit"
            name="racing-check"
            class={changes === 0 ? '' : 'primary'}
            disabled={busy || changes === 0}
          >
            {changes === 0 ? 'Nothing changed' : `Check ${plural(changes, 'change')}`}
          </button>
          {fields.boats !== saved.boats || changes > 0 || change === null ? (
            <button type="button" name="racing-reset" onClick={() => set(saved)}>
              Put back
            </button>
          ) : null}
        </p>
      </form>
      {change === null ? (
        <p class="small" data-field="racing-why">
          Whole numbers of races, hours, a percentage from 0 to 100, and a boat or more in the turn.
        </p>
      ) : null}
      {why !== '' ? <p class="small error">{why}</p> : null}
      {asked !== null ? (
        <div class="confirm" data-field="racing-confirmation">
          <p>{asked.words}</p>
          <button
            type="button"
            name="racing-set"
            class="primary"
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
