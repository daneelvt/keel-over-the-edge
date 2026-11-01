// SPDX-License-Identifier: AGPL-3.0-only

// The chart's weather controls, one row in a case as the instruments at
// sea are: Play, the time slider, by the minute, from now to ninety
// minutes ahead by the forecast, lettered with the moment's minutes and its
// time of day; the layers' switches, the wind's three under "Wind", in a
// sheet over it; and the key to the chart's symbols. And a place's weather
// in its box at the slider's time, with its outlook, a gale warning at its
// head when its outlook reaches one.

import { useEffect, useState } from 'preact/hooks';
import type { Chart } from '../chart/chart';
import type { Forecasting } from '../chart/forecasting';
import { type PlaceWords, placeWords, pointsOf } from '../chart/placeweather';
import { formatPosition } from '../chart/position';
import { aheadReach, type Layer, type Moment, momentOf, untilOf } from '../chart/weather';
import type { ChartEntry } from '../net/messages';
import { ChartKey } from './chartkey';

const SECOND = 30;

/** Play runs the slider on this many minutes a second: the whole ninety in about nine seconds. */
const PLAY_RATE = 10;

/** The wind's switches, under "Wind", and the other layers', with their names. */
const WIND_LAYERS: [Layer, string][] = [
  ['wash', 'Wash'],
  ['barbs', 'Barbs'],
  ['streaks', 'Streaks'],
];
const LAYER_NAMES: [Layer, string][] = [
  ['gusts', 'Gusts'],
  ['rain', 'Rain'],
  ['fog', 'Fog'],
  ['systems', 'Systems'],
  ['pressure', 'Pressure'],
];

/** A time of day, ms of UTC, as the device's clock gives it: "4:20 pm" or "16:20". */
export function clockText(at: number, locale?: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone }).format(
    at,
  );
}

/** The time of day of a moment, ms of UTC, from the world's tick now and the clock now. */
export function momentClock(m: Moment, tick: number, ms: number): number {
  return ms + ((m.tick - tick) / SECOND) * 1000;
}

/** The slider's lettering for a moment: "Now", "In 40 min · 4:20 pm". */
export function momentText(m: Moment, clock: string): string {
  return m.kind === 'ahead' ? `In ${m.minutes} min · ${clock}` : 'Now';
}

/** The slider's lettering for its moment now. */
function lettering(m: Moment, src: Forecasting): string {
  return momentText(m, clockText(momentClock(m, src.tick(), Date.now())));
}

/** Play's mark, and Pause's. */
function PlayMark({ playing }: { playing: boolean }) {
  return (
    <svg class="chart-play-mark" viewBox="0 0 16 16" aria-hidden="true">
      {playing ? <path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z" /> : <path d="M4 2l10 6-10 6z" />}
    </svg>
  );
}

/** The slider with Play, its lettering above it, the layers and the key beside it. */
export function TimeBar({ chart, src }: { chart: Chart; src: Forecasting }) {
  const minutes = chart.minutes.value;
  const playing = chart.playing.value;
  const [, tick] = useState(0);
  const [open, setOpen] = useState<'' | 'layers' | 'key'>('');
  const latest = src.forecasts.latest;
  const hi = aheadReach(src);
  const at = Math.min(Math.max(minutes, 0), hi);
  useEffect(() => {
    // The moment's time of day and the slider's reach move on.
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!playing) {
      return;
    }
    // On from where it is to its end, then stop: the weather is painted
    // as fast as its painter keeps up, a minute skipped if it falls behind.
    const from = chart.minutes.value;
    const start = performance.now();
    const t = setInterval(() => {
      const end = aheadReach(src);
      const m = Math.min(from + Math.floor(((performance.now() - start) / 1000) * PLAY_RATE), end);
      if (m !== chart.minutes.value) {
        chart.minutes.value = m;
      }
      if (m >= end) {
        chart.playing.value = false;
      }
    }, 50);
    return () => clearInterval(t);
  }, [playing, chart, src]);
  const m = momentOf(at, src);
  const valueText = m.kind === 'now' ? 'now' : `${m.minutes} minutes ahead`;
  const onKey = (e: KeyboardEvent) => {
    let to = at;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        to = at + 1;
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        to = at - 1;
        break;
      case 'PageUp':
        to = at + 10;
        break;
      case 'PageDown':
        to = at - 10;
        break;
      case 'Home':
        to = 0;
        break;
      case 'End':
        to = hi;
        break;
      default:
        return;
    }
    e.preventDefault();
    chart.playing.value = false;
    chart.minutes.value = Math.min(Math.max(to, 0), hi);
  };
  const end = src.end();
  const toggle = (which: 'layers' | 'key') => setOpen(open === which ? '' : which);
  return (
    <section class="chart-case chart-time" aria-label="The weather's time">
      <button
        type="button"
        class="chart-button chart-play"
        aria-label={playing ? 'Pause' : 'Play'}
        aria-pressed={playing}
        disabled={hi <= 0}
        onClick={() => {
          if (!playing && at >= hi) {
            chart.minutes.value = 0;
          }
          chart.playing.value = !playing;
        }}
      >
        <PlayMark playing={playing} />
      </button>
      <div class="chart-time-track">
        <p class="chart-time-text" data-readout="chart-time">
          {lettering(m, src)}
          {latest !== null && end > 0 && end < untilOf(latest) && at === hi
            ? ' · The falls take this world'
            : ''}
          {latest === null ? ' · no forecast yet' : ''}
        </p>
        <input
          type="range"
          class="chart-slider"
          min={0}
          max={hi}
          step={1}
          value={at}
          aria-label="Time"
          aria-valuemin={0}
          aria-valuemax={hi}
          aria-valuenow={at}
          aria-valuetext={valueText}
          onInput={(e) => {
            chart.playing.value = false;
            chart.minutes.value = Number(e.currentTarget.value);
          }}
          onKeyDown={onKey}
        />
      </div>
      <button
        type="button"
        class="chart-button"
        aria-expanded={open === 'layers'}
        aria-controls="chart-layers"
        onClick={() => toggle('layers')}
      >
        Layers
      </button>
      <button
        type="button"
        class="chart-button"
        aria-expanded={open === 'key'}
        onClick={() => toggle('key')}
      >
        Key
      </button>
      {open === 'layers' ? <LayerSheet chart={chart} /> : null}
      {open === 'key' ? <ChartKey onClose={() => setOpen('')} /> : null}
    </section>
  );
}

/** The layers' switches, each a key with its lamp, the wind's three under "Wind". */
function LayerSheet({ chart }: { chart: Chart }) {
  const layers = chart.layers.value;
  const box = ([layer, name]: [Layer, string]) => (
    <label class="chart-layer" key={layer}>
      <input
        type="checkbox"
        name={`layer-${layer}`}
        checked={layers[layer]}
        onChange={(e) => chart.setLayer(layer, e.currentTarget.checked)}
      />
      <span>{name}</span>
    </label>
  );
  return (
    <fieldset id="chart-layers" class="chart-case chart-layers">
      <legend class="visually-hidden">Layers</legend>
      <fieldset class="chart-layer-group">
        <legend class="chart-legend">Wind</legend>
        <div class="chart-layer-keys">{WIND_LAYERS.map(box)}</div>
      </fieldset>
      <fieldset class="chart-layer-group">
        <legend class="chart-legend">Weather</legend>
        <div class="chart-layer-keys">{LAYER_NAMES.map(box)}</div>
      </fieldset>
    </fieldset>
  );
}

/** A place's weather in its box, at the slider's time: its lines, its outlook, a gale warning at its head. */
export function PlaceWeatherLines({
  chart,
  src,
  e,
}: {
  chart: Chart;
  src: Forecasting;
  e: ChartEntry;
}) {
  const [words, setWords] = useState<PlaceWords | null>(null);
  const minutes = chart.minutes.value;
  const version = src.forecasts.version;
  useEffect(() => {
    let on = true;
    const ask = () => {
      const m = momentOf(minutes, src);
      void placeWords(src, m, pointsOf(e), chart.store).then((w) => {
        if (on) {
          setWords(w);
        }
        chart.view.weatherChanged();
      });
    };
    ask();
    // Now moves on, and the minutes ahead are minutes from now.
    const t = setInterval(ask, 5000);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, [chart, src, e, minutes, version]);
  const when = lettering(momentOf(minutes, src), src);
  return (
    <div class="chart-weather" data-readout="place-weather">
      {words?.warning != null ? <p class="chart-warning">Gale warning. {words.warning}.</p> : null}
      <p class="chart-weather-when">{when}</p>
      {words === null ? (
        <p>…</p>
      ) : (
        <dl>
          <dt>Wind</dt>
          <dd>{words.box.wind}</dd>
          <dt>Gusts</dt>
          <dd>{words.box.gusts}</dd>
          <dt>Sky</dt>
          <dd>{words.box.sky}</dd>
          <dt>Visibility</dt>
          <dd>{words.box.visibility}</dd>
          <dt>Barometer</dt>
          <dd>{words.box.barometer}</dd>
        </dl>
      )}
      {words !== null && words.outlook !== '' ? (
        <p class="chart-outlook">
          <em>Next 90 min.</em> {words.outlook}
        </p>
      ) : null}
      <p class="chart-place-position">{formatPosition(e.east, e.north)}</p>
    </div>
  );
}
