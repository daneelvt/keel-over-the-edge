// SPDX-License-Identifier: AGPL-3.0-only

// The week's weather on the world page: its spells as a strip coloured by
// regime, its fronts over the centre, warm or cold, its storms' and lows'
// births and the world's end marked on it, and a cursor at the tick now. A click or a drag on the
// strip, or its arrow keys, shows the weather at another tick, on the map
// as on the card; a double click, Escape or the button goes back to now and
// follows it. Below the strip the spell in effect, the next and when, the
// front if one is crossing, and the systems alive, each centring the map
// on it, with the swell it raises. The week is read every few seconds while it follows now, and a
// few times a second at the most while the strip is dragged.

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { getWeather, type Spell, type WeatherWeek } from './api';
import { brief, hidden } from './life';
import {
  fromNow,
  REGIME_COLOURS,
  regimeColour,
  STAGES,
  WEATHER_COLOURS,
  whereFrom,
} from './weather';

/** How often the week is read while it follows now, ms. */
export const WEATHER_EVERY = 6000;

/** The least time between two readings while the strip is dragged, ms. */
const DRAG_EVERY = 200;

/** The weather shown: as last read, the tick asked for (null following now), and how to ask for another. */
export interface Shown {
  weather: WeatherWeek | null;
  at: number | null;
  show: (at: number | null) => void;
}

/**
 * A world's week under prefix ("" for the current world's, "next/" for the
 * next's), read for each key it is given and none for a null key, at the
 * tick shown or now; every so many ms while it follows now, or never again
 * for a null every. A new key goes back to now. An answer overtaken by a
 * later one is dropped.
 */
export function useWeather(
  prefix: string,
  key: string | null,
  every: number | null,
  setError: (e: string) => void,
): Shown {
  const [asked, setAsked] = useState<{ key: string | null; at: number | null }>({
    key,
    at: null,
  });
  const [read, setRead] = useState<{ key: string | null; weather: WeatherWeek | null }>({
    key: null,
    weather: null,
  });
  const sent = useRef(0);
  const answered = useRef(0);
  const last = useRef(0);
  const at = asked.key === key ? asked.at : null;

  useEffect(() => {
    if (key === null) {
      return;
    }
    const get = (): void => {
      if (hidden()) {
        return;
      }
      sent.current += 1;
      const n = sent.current;
      last.current = performance.now();
      getWeather(prefix, at)
        .then((weather) => {
          if (n > answered.current) {
            answered.current = n;
            setRead({ key, weather });
          }
        })
        .catch((e: unknown) => setError(String(e)));
    };
    if (at !== null) {
      const t = setTimeout(get, Math.max(0, last.current + DRAG_EVERY - performance.now()));
      return () => clearTimeout(t);
    }
    get();
    if (every === null) {
      return;
    }
    const t = setInterval(get, every);
    return () => clearInterval(t);
  }, [prefix, key, at, every, setError]);

  const show = useCallback((t: number | null) => setAsked({ key, at: t }), [key]);
  return { weather: read.key === key ? read.weather : null, at, show };
}

/** A spell in a few words. */
function spellWords(w: WeatherWeek, s: Spell): string {
  return (
    `${w.regimes[s.regime] ?? s.regime}: ${s.knots.toFixed(1)} kn from ${s.from.toFixed(0)}°, ` +
    `${s.pressure.toFixed(1)} hPa${s.front ? (s.warm ? ', a warm front' : ', a cold front') : ''}${s.held ? ', held by the developer' : ''}`
  );
}

/** The names of the week's storms' kind, and of the kinds of its other lows. */
function lowNames(w: WeatherWeek): { storm: string; lows: string } {
  const names = (storm: boolean, none: string): string =>
    w.kinds
      .filter((k) => k.shape === 'low' && k.storm === storm)
      .map((k) => k.name || k.id)
      .join(' or ') || none;
  return { storm: names(true, 'Storm'), lows: names(false, 'Low') };
}

/** A kind's name, by its index. */
function kindName(w: WeatherWeek, k: number): string {
  return w.kinds[k]?.name || w.kinds[k]?.id || String(k);
}

function capital(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A tick's place along a strip of span ticks from start, as a share of its width. */
function along(t: number, start: number, span: number): string {
  return `${(100 * Math.min(Math.max(t - start, 0), span)) / span}%`;
}

/** A tick of a week as ms of UTC. */
function msOf(w: WeatherWeek, t: number): number {
  return w.epoch + (t / w.ticksPerSecond) * 1000;
}

/** The week as a strip: dragged, clicked or stepped by its keys to show a tick. */
function Strip({
  w,
  now,
  at,
  show,
}: {
  w: WeatherWeek;
  now: number;
  at: number | null;
  show: (at: number | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const start = Math.min(w.spells[0]?.begin ?? 0, now);
  const span = Math.max(1, w.until - start);
  const tps = w.ticksPerSecond;
  const clamp = (t: number): number => Math.round(Math.min(Math.max(t, start), w.until));
  const tickAt = (clientX: number): number => {
    const r = box.current?.getBoundingClientRect();
    return r === undefined || r.width === 0
      ? start
      : clamp(start + ((clientX - r.left) / r.width) * span);
  };
  const shown = at ?? now;
  // The spells, fronts, storms and days, made again with each reading of
  // the week, not at each second's: a world older than a week has a
  // thousand spells or more.
  const marks = useMemo(() => {
    const left = (t: number): string => along(t, start, span);
    const width = (ticks: number): string => `${(100 * Math.max(0, ticks)) / span}%`;
    const ms = (t: number): number => msOf(w, t);
    const names = lowNames(w);
    // The days: each midnight in the owner's own zone.
    const days: { tick: number; name: string }[] = [];
    const day = new Date(ms(start));
    day.setHours(24, 0, 0, 0);
    for (; day.getTime() < ms(w.until); day.setDate(day.getDate() + 1)) {
      days.push({
        tick: ((day.getTime() - w.epoch) / 1000) * w.ticksPerSecond,
        name: day.toLocaleDateString('en-GB', { weekday: 'short' }),
      });
    }
    return {
      strip: (
        <>
          {w.spells.map((s) => (
            <span
              key={s.begin}
              class="spell"
              style={{
                left: left(s.begin),
                width: width(s.end - Math.max(s.begin, start)),
                background: regimeColour(s.regime),
              }}
              title={`${brief(ms(s.begin))}: ${spellWords(w, s)}`}
            />
          ))}
          {w.spells
            .filter((s) => s.front)
            .map((s) => (
              <span
                key={`f${s.begin}`}
                class={s.warm ? 'mark front warm' : 'mark front'}
                style={{ left: left(s.begin + s.cross / 2) }}
                title={`A ${s.warm ? 'warm' : 'cold'} front over the centre, ${brief(ms(s.begin + s.cross / 2))}`}
              />
            ))}
          {w.storms.map((t) => (
            <span
              key={`s${t}`}
              class="mark born"
              style={{ left: left(t) }}
              title={`${names.storm} born, ${brief(ms(t))}`}
            />
          ))}
          {w.lows.map((t) => (
            <span
              key={`l${t}`}
              class="mark born low"
              style={{ left: left(t) }}
              title={`${names.lows} born, ${brief(ms(t))}`}
            />
          ))}
          <span
            class="mark end"
            style={{ left: left(w.ends) }}
            title={`The world ends, ${brief(ms(w.ends))}`}
          />
        </>
      ),
      days: days.map((d) => (
        <span key={d.tick} style={{ left: left(d.tick) }}>
          {d.name}
        </span>
      )),
    };
  }, [w, start, span]);
  return (
    <>
      <div
        ref={box}
        class="week"
        role="slider"
        tabIndex={0}
        aria-label="The tick shown"
        aria-valuemin={start}
        aria-valuemax={w.until}
        aria-valuenow={shown}
        aria-valuetext={brief(msOf(w, shown))}
        data-field="week"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragging.current = true;
          show(tickAt(e.clientX));
        }}
        onPointerMove={(e) => {
          if (dragging.current) {
            show(tickAt(e.clientX));
          }
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onDblClick={() => show(null)}
        onKeyDown={(e) => {
          const hour = 3600 * tps;
          const step: Record<string, number> = { ArrowLeft: -hour, ArrowRight: hour };
          if (e.key === 'Escape') {
            show(null);
          } else if (step[e.key] !== undefined) {
            e.preventDefault();
            show(clamp(shown + (step[e.key] ?? 0) * (e.shiftKey ? 6 : 1)));
          }
        }}
      >
        {marks.strip}
        <span class="mark now" style={{ left: along(now, start, span) }} />
        {at !== null ? <span class="mark shown" style={{ left: along(at, start, span) }} /> : null}
      </div>
      <div class="days small" aria-hidden="true">
        {marks.days}
      </div>
    </>
  );
}

/** The week's weather: the strip, the weather at the tick shown, the systems alive then. */
export function WeekCard({
  w,
  now,
  at,
  show,
  goTo,
}: {
  w: WeatherWeek | null;
  /** The world's tick now. */
  now: number;
  at: number | null;
  show: (at: number | null) => void;
  goTo: (east: number, north: number, scale?: number) => void;
}) {
  if (w === null) {
    return null;
  }
  const tps = w.ticksPerSecond;
  const when = (t: number): string =>
    `${fromNow(t - now, tps)} (${brief(w.epoch + (t / tps) * 1000)})`;
  const f = w.front;
  return (
    <section class="card" aria-label="The week's weather">
      <h2>The week's weather</h2>
      <Strip w={w} now={now} at={at} show={show} />
      <p class="small legend">
        {w.regimes.map((r, i) => (
          <span key={r}>
            <i class="swatch" style={{ background: REGIME_COLOURS[i % REGIME_COLOURS.length] }} />{' '}
            {r}
          </span>
        ))}
        <span>
          <i class="swatch" style={{ background: WEATHER_COLOURS.front }} /> cold front
        </span>
        <span>
          <i class="swatch" style={{ background: WEATHER_COLOURS.warm }} /> warm front
        </span>
        <span>
          <i class="swatch round" style={{ background: WEATHER_COLOURS.low }} /> {lowNames(w).storm}{' '}
          born
        </span>
        <span>
          <i class="swatch round" style={{ background: WEATHER_COLOURS.low, opacity: 0.5 }} />{' '}
          {lowNames(w).lows} born
        </span>
      </p>
      <p data-field="shown">
        {at === null ? 'Now' : capital(fromNow(w.at - now, tps))}: tick {w.at},{' '}
        {brief(w.epoch + (w.at / tps) * 1000)}.{' '}
        {at !== null ? (
          <button type="button" name="weather-now" onClick={() => show(null)}>
            Back to now
          </button>
        ) : null}
      </p>
      <dl>
        <dt>Spell</dt>
        <dd data-field="spell">{w.spell !== null ? spellWords(w, w.spell) : '—'}</dd>
        <dt>Next</dt>
        <dd data-field="next-spell">
          {w.next !== null ? `${spellWords(w, w.next)}; ${when(w.next.begin)}` : 'none this week'}
        </dd>
        <dt>Front</dt>
        <dd data-field="front">
          {f !== null
            ? `a ${f.warm ? 'warm' : 'cold'} front, its line ${(Math.abs(f.line) / 1000).toFixed(1)} km ${f.line < 0 ? 'short of' : 'past'} the centre, ` +
              `moving toward ${f.toward.toFixed(0)}° at ${f.knots.toFixed(1)} kn, ${f.depth.toFixed(1)} hPa deep; ` +
              `over Port Royal ${when(f.portRoyal)}; off the disk ${fromNow(f.leaves - now, tps)}`
            : 'none crossing'}
        </dd>
      </dl>
      <h3>Systems: {w.systems.length}</h3>
      {w.systems.length > 0 ? (
        <table class="systems">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Where</th>
              <th>Strength</th>
              <th>Stage</th>
              <th>Born</th>
              <th>Gone</th>
            </tr>
          </thead>
          <tbody>
            {w.systems.map((s) => (
              <tr key={s.slot} data-system={s.slot}>
                <td>
                  <button
                    type="button"
                    onClick={() => goTo(s.east, s.north, Math.max(1, s.size / 120))}
                  >
                    {kindName(w, s.kind)}
                    {s.length > 0 ? ` ${(s.length / 1852).toFixed(1)} M long` : ''}
                    {s.developer ? ' (developer)' : ''}
                  </button>
                </td>
                <td>{whereFrom(s.east, s.north)}</td>
                <td>
                  {s.strength.toFixed(2)}
                  {s.swell > 0 ? (
                    <span class="small" data-field="swell">
                      , swell {s.swell.toFixed(1)} m
                    </span>
                  ) : null}
                </td>
                <td>{STAGES[s.stage] ?? s.stage}</td>
                <td>{fromNow(s.born - now, tps)}</td>
                <td>{fromNow(s.gone - now, tps)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
