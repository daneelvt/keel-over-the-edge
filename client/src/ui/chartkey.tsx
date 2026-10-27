// SPDX-License-Identifier: AGPL-3.0-only

// The chart's key: a panel over the chart listing every symbol its weather
// is drawn with, each in the chart's own drawing beside its one line, so a
// sailor can learn the weather chart's language as it is read.

import { useEffect, useMemo, useRef } from 'preact/hooks';
import { catalog } from '../catalog';
import { type KeyEntry, keyEntries, paintSwatch, SWATCH } from '../chart/key';
import { kindDraws } from '../chart/weather';
import { weatherLooks } from '../chart/weatherlayer';
import type { WeatherLook } from '../chart/weatherpaint';
import './chartkey.css';

/** An entry's swatch, painted once it is in the page. */
function Swatch({ entry, look }: { entry: KeyEntry; look: WeatherLook }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (canvas.current !== null) {
      paintSwatch(canvas.current, entry, look, globalThis.devicePixelRatio || 1);
    }
  }, [entry, look]);
  return (
    <canvas
      ref={canvas}
      class="chart-key-swatch"
      style={{ width: `${SWATCH.width}px`, height: `${SWATCH.height}px` }}
    />
  );
}

/** The key: every symbol of the chart's weather with its line, and a way to close it. */
export function ChartKey({ onClose }: { onClose: () => void }) {
  const { look, entries } = useMemo(() => {
    const paint = weatherLooks().paint;
    return {
      look: paint,
      entries: keyEntries(kindDraws(catalog.weather.systems), catalog.world.chart.look.weather.key),
    };
  }, []);
  return (
    <section class="chart-panel chart-key" aria-label="Key" data-readout="chart-key">
      <header class="chart-key-head">
        <h2>Key</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>
      <ul>
        {entries.map((e) => (
          <li key={e.id} data-key={e.id}>
            <Swatch entry={e} look={look} />
            <p>
              <strong>{e.name}.</strong> {e.line}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
