// SPDX-License-Identifier: AGPL-3.0-only

// The chart's weather controls: the time slider, by the minute, from now
// to ninety minutes ahead by the forecast or back ninety minutes in "what
// happened", with "Now" and Play, lettered with the moment's minutes and
// its time of day; the layers' switches, the wind's three under "Wind",
// folded into a sheet on a phone so the slider and its mode stay on the
// screen; the key to the chart's symbols; and a place's weather in its box
// at the slider's time, with its outlook, a gale warning at its head when
// its outlook reaches one.

import { useEffect, useState } from 'preact/hooks';
import type { Chart } from '../chart/chart';
import type { Forecasting } from '../chart/forecasting';
import { type PlaceWords, placeWords, pointsOf } from '../chart/placeweather';
import { formatPosition } from '../chart/position';
import {
  aheadReach,
  type Layer,
  type Moment,
  momentOf,
  pastReach,
  untilOf,
} from '../chart/weather';
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

/** The slider's lettering for a moment: "Now", "In 40 min · 4:20 pm", "40 min ago · 3:40 pm". */
export function momentText(m: Moment, clock: string): string {
  switch (m.kind) {
    case 'ahead':
      return `In ${m.minutes} min · ${clock}`;
    case 'past':
      return `${-m.minutes} min ago · ${clock}`;
  }
  return 'Now';
}

/** The slider's lettering for its moment now. */
function lettering(m: Moment, src: Forecasting): string {
  return momentText(m, clockText(momentClock(m, src.tick(), Date.now())));
}

/** The slider, its mode, "Now", Play, the layers, the key and its lettering. */
export function TimeBar({ chart, src }: { chart: Chart; src: Forecasting }) {
  const mode = chart.timeMode.value;
  const minutes = chart.minutes.value;
  const playing = chart.playing.value;
  const [, tick] = useState(0);
  const [key, setKey] = useState(false);
  const latest = src.forecasts.latest;
  const lo = mode === 'past' ? -pastReach(src) : 0;
  const hi = mode === 'past' ? 0 : aheadReach(src);
  const at = Math.min(Math.max(minutes, lo), hi);
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
      const end = chart.timeMode.value === 'past' ? 0 : aheadReach(src);
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
  const m = momentOf(mode, at, src);
  const valueText =
    m.kind === 'now'
      ? 'now'
      : m.kind === 'ahead'
        ? `${m.minutes} minutes ahead`
        : `${-m.minutes} minutes ago`;
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
        to = lo;
        break;
      case 'End':
        to = hi;
        break;
      default:
        return;
    }
    e.preventDefault();
    chart.playing.value = false;
    chart.minutes.value = Math.min(Math.max(to, lo), hi);
  };
  const end = src.end();
  return (
    <section class="chart-time" aria-label="The weather's time">
      <fieldset class="chart-time-modes" aria-label="Forecast or what happened">
        <button
          type="button"
          class={mode === 'forecast' ? 'chosen' : ''}
          aria-pressed={mode === 'forecast'}
          onClick={() => chart.setTimeMode('forecast')}
        >
          Forecast
        </button>
        <button
          type="button"
          class={mode === 'past' ? 'chosen' : ''}
          aria-pressed={mode === 'past'}
          onClick={() => chart.setTimeMode('past')}
        >
          What happened
        </button>
      </fieldset>
      <input
        type="range"
        class="chart-slider"
        min={lo}
        max={hi}
        step={1}
        value={at}
        aria-label="Time"
        aria-valuemin={lo}
        aria-valuemax={hi}
        aria-valuenow={at}
        aria-valuetext={valueText}
        onInput={(e) => {
          chart.playing.value = false;
          chart.minutes.value = Number(e.currentTarget.value);
        }}
        onKeyDown={onKey}
      />
      <div class="chart-time-buttons">
        <button
          type="button"
          onClick={() => {
            chart.playing.value = false;
            chart.minutes.value = 0;
          }}
          disabled={at === 0}
        >
          Now
        </button>
        <button
          type="button"
          aria-pressed={playing}
          disabled={hi <= lo}
          onClick={() => {
            if (!playing && at >= hi) {
              chart.minutes.value = lo;
            }
            chart.playing.value = !playing;
          }}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <LayerSheet chart={chart} />
        <button
          type="button"
          class="chart-key-open"
          aria-expanded={key}
          onClick={() => setKey(!key)}
        >
          Key
        </button>
      </div>
      <p class="chart-time-text" data-readout="chart-time">
        {lettering(m, src)}
        {mode === 'forecast' && latest !== null && end > 0 && end < untilOf(latest) && at === hi
          ? ' · The falls take this world'
          : ''}
        {latest === null && mode === 'forecast' ? ' · no forecast yet' : ''}
      </p>
      {key ? <ChartKey onClose={() => setKey(false)} /> : null}
    </section>
  );
}

/** The layers' switches, the wind's three under "Wind": a row on a wide screen, a sheet on a phone. */
function LayerSheet({ chart }: { chart: Chart }) {
  const [open, setOpen] = useState(false);
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
    <>
      <button
        type="button"
        class="chart-layers-open"
        aria-expanded={open}
        aria-controls="chart-layers"
        onClick={() => setOpen(!open)}
      >
        Layers
      </button>
      <fieldset id="chart-layers" class={open ? 'chart-layers open' : 'chart-layers'}>
        <legend>Layers</legend>
        <fieldset style={{ display: 'contents' }}>
          <legend>Wind</legend>
          <span class="chart-layer" aria-hidden="true">
            Wind:
          </span>
          {WIND_LAYERS.map(box)}
        </fieldset>
        {LAYER_NAMES.map(box)}
      </fieldset>
    </>
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
  const mode = chart.timeMode.value;
  const minutes = chart.minutes.value;
  const version = src.forecasts.version;
  useEffect(() => {
    let on = true;
    const ask = () => {
      const m = momentOf(mode, minutes, src);
      void placeWords(src, m, pointsOf(e), chart.store).then((w) => {
        if (on) {
          setWords(w);
        }
        chart.view.weatherChanged();
      });
    };
    ask();
    // Now moves on, and the minutes ahead and behind are minutes from now.
    const t = setInterval(ask, 5000);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, [chart, src, e, mode, minutes, version]);
  const when = lettering(momentOf(mode, minutes, src), src);
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
