// SPDX-License-Identifier: AGPL-3.0-only

// The chart's weather controls: the time slider, from now to the
// forecast's horizon in its steps or back ninety minutes in "what
// happened", with "Now" and Play, lettered with the issue's age; the
// layers' switches, folded into a sheet on a phone so the slider and its
// mode stay on the screen; and a place's weather in its box at the
// slider's time, with its outlook, a gale warning at its head when its
// outlook reaches one.

import { useEffect, useState } from 'preact/hooks';
import type { Chart } from '../chart/chart';
import type { Forecasting } from '../chart/forecasting';
import { type PlaceWords, placeWords, pointsOf } from '../chart/placeweather';
import { formatPosition } from '../chart/position';
import { type Layer, type Moment, momentOf, PAST_STEPS } from '../chart/weather';
import type { ChartEntry } from '../net/messages';
import { issueOf, stepsOf } from '../predict/forecast';

const MINUTE = 60 * 30;

/** The layers' switches and their names. */
const LAYER_NAMES: [Layer, string][] = [
  ['gusts', 'Gusts'],
  ['rain', 'Rain'],
  ['fog', 'Fog'],
  ['systems', 'Systems'],
  ['pressure', 'Pressure'],
];

/** The slider's lettering for a moment: "Now", "Forecast · +30 min", "What happened · −40 min". */
export function momentText(m: Moment, stepMinutes: number): string {
  switch (m.kind) {
    case 'forecast':
      return `Forecast · +${m.step * stepMinutes} min`;
    case 'past':
      return `What happened · −${-m.step * 10} min`;
  }
  return 'Now';
}

/** The issue's age: "issued 6 min ago". */
export function ageText(issue: number, now: number): string {
  const m = Math.max(0, Math.floor((now - issue) / MINUTE));
  return m === 0 ? 'issued just now' : `issued ${m} min ago`;
}

/** The slider, its mode, "Now", Play and its lettering. */
export function TimeBar({ chart, src }: { chart: Chart; src: Forecasting }) {
  const mode = chart.timeMode.value;
  const step = chart.step.value;
  const playing = chart.playing.value;
  const [, tick] = useState(0);
  const latest = src.forecasts.latest;
  const steps = latest === null ? 1 : stepsOf(latest).steps;
  const stepMinutes = latest === null ? 10 : Math.round(stepsOf(latest).step / MINUTE);
  // The world's end: the slider stops at the last step before it.
  const end = src.end();
  let last = steps - 1;
  if (mode === 'forecast' && latest !== null && end > 0) {
    while (last > 0 && issueOf(latest) + last * stepsOf(latest).step > end) {
      last--;
    }
  }
  const lo = mode === 'past' ? -PAST_STEPS : 0;
  const hi = mode === 'past' ? 0 : Math.max(last, 0);
  useEffect(() => {
    // The issue's age and the moment move on.
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!playing) {
      return;
    }
    // A step a second, to the end, then stop.
    const t = setInterval(() => {
      const s = chart.step.value;
      if (s >= hi) {
        chart.playing.value = false;
        return;
      }
      chart.step.value = s + 1;
    }, 1000);
    return () => clearInterval(t);
  }, [playing, hi, chart]);
  const m = momentOf(mode, step, src);
  const valueText =
    m.kind === 'now'
      ? 'now'
      : m.kind === 'forecast'
        ? `${m.step * stepMinutes} minutes ahead`
        : `${-m.step * 10} minutes ago`;
  const onKey = (e: KeyboardEvent) => {
    let to = step;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        to = step + 1;
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        to = step - 1;
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
    chart.step.value = Math.min(Math.max(to, lo), hi);
  };
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
        value={step}
        aria-label="Time"
        aria-valuemin={lo}
        aria-valuemax={hi}
        aria-valuenow={step}
        aria-valuetext={valueText}
        onInput={(e) => {
          chart.playing.value = false;
          chart.step.value = Number(e.currentTarget.value);
        }}
        onKeyDown={onKey}
      />
      <div class="chart-time-buttons">
        <button
          type="button"
          onClick={() => {
            chart.playing.value = false;
            chart.step.value = 0;
          }}
          disabled={step === 0}
        >
          Now
        </button>
        <button
          type="button"
          aria-pressed={playing}
          onClick={() => {
            if (!playing && step >= hi) {
              chart.step.value = lo;
            }
            chart.playing.value = !playing;
          }}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <LayerSheet chart={chart} />
      </div>
      <p class="chart-time-text" data-readout="chart-time">
        {momentText(m, stepMinutes)}
        {mode === 'forecast' && latest !== null ? ` · ${ageText(issueOf(latest), src.tick())}` : ''}
        {mode === 'forecast' && end > 0 && step === hi && hi < steps - 1
          ? ' · The falls take this world'
          : ''}
        {latest === null && mode === 'forecast' ? ' · no forecast yet' : ''}
      </p>
      <InsideCount chart={chart} />
    </section>
  );
}

/** In "what happened", how many of the forecast's systems lay inside their cones. */
function InsideCount({ chart }: { chart: Chart }) {
  const [text, setText] = useState('');
  useEffect(() => {
    const t = setInterval(() => {
      const s = chart.view.weather?.scene ?? null;
      setText(
        s !== null && s.moment.kind === 'past' && s.judged > 0
          ? `Inside the cones: ${s.inside} of ${s.judged}`
          : '',
      );
    }, 500);
    return () => clearInterval(t);
  }, [chart]);
  return text === '' ? null : (
    <p class="chart-inside" data-readout="chart-inside">
      {text}
    </p>
  );
}

/** The layers' switches: a row on a wide screen, a sheet on a phone. */
function LayerSheet({ chart }: { chart: Chart }) {
  const [open, setOpen] = useState(false);
  const layers = chart.layers.value;
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
        <label class="chart-layer">
          <input type="checkbox" checked disabled />
          <span>Wind</span>
        </label>
        {LAYER_NAMES.map(([layer, name]) => (
          <label class="chart-layer" key={layer}>
            <input
              type="checkbox"
              name={`layer-${layer}`}
              checked={layers[layer]}
              onChange={(e) => chart.setLayer(layer, e.currentTarget.checked)}
            />
            <span>{name}</span>
          </label>
        ))}
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
  const step = chart.step.value;
  const version = src.forecasts.version;
  useEffect(() => {
    let on = true;
    const ask = () => {
      const m = momentOf(mode, step, src);
      void placeWords(src, m, pointsOf(e), chart.store).then((w) => {
        if (on) {
          setWords(w);
        }
        chart.view.weatherChanged();
      });
    };
    ask();
    // Now moves on; the forecast at a step stays as it is.
    const t = mode === 'forecast' && step > 0 ? undefined : setInterval(ask, 5000);
    return () => {
      on = false;
      if (t !== undefined) {
        clearInterval(t);
      }
    };
  }, [chart, src, e, mode, step, version]);
  const latest = src.forecasts.latest;
  const when = momentText(
    momentOf(mode, step, src),
    latest === null ? 10 : Math.round(stepsOf(latest).step / MINUTE),
  );
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
