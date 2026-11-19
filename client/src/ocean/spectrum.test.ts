// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { catalog } from '../catalog';
import { DETAIL, KNOT } from './look';
import {
  detailPatch,
  finerPatch,
  newSpectrumInputs,
  REFIT,
  SpectrumFollower,
  spectrumInputs,
  type WaveWind,
} from './spectrum';

const sea = catalog.weather.sea;
const first = detailPatch(sea, 256, DETAIL.patch, DETAIL.period);
const fine = finerPatch(first, DETAIL.finePatch, DETAIL.fineLongest);

function wind(knots: number, degrees: number, nm = 6): WaveWind {
  const r = (degrees * Math.PI) / 180;
  return { speed: knots * KNOT, east: Math.cos(r), north: Math.sin(r), fetch: nm * 1852 };
}

describe('the spectrum under a moving wind', () => {
  it('works the fit out once for a steady wind, and gives what spectrumInputs gives', () => {
    const f = new SpectrumFollower(sea, first);
    const w = wind(14, 30);
    for (let i = 0; i < 10; i++) {
      f.follow(w);
    }
    expect(f.fits).toBe(1);
    expect(f.inputs).toEqual(spectrumInputs(sea, first, w, newSpectrumInputs()));
  });

  it('works it out again only past a step of speed, of fetch or of direction', () => {
    const f = new SpectrumFollower(sea, first);
    f.follow(wind(14, 30));
    const under = 1 - 1e-3;
    const over = 1 + 1e-3;
    // Within each step: no new fit.
    f.follow(wind(14 * (1 + REFIT.speed * under), 30));
    f.follow(wind(14 * (1 - REFIT.speed * under), 30));
    f.follow(wind(14, 30, 6 * (1 + REFIT.fetch * under)));
    f.follow(wind(14, 30 + (REFIT.turn * 180 * under) / Math.PI));
    f.follow(wind(14, 30 - (REFIT.turn * 180 * under) / Math.PI));
    expect(f.fits).toBe(1);
    // Past each: a new fit, from the wind it was past.
    f.follow(wind(14 * (1 + REFIT.speed * over), 30));
    expect(f.fits).toBe(2);
    f.follow(wind(14 * (1 + REFIT.speed * over), 30, 6 * (1 - REFIT.fetch * over)));
    expect(f.fits).toBe(3);
    f.follow(
      wind(
        14 * (1 + REFIT.speed * over),
        30 + (REFIT.turn * 180 * over) / Math.PI,
        6 * (1 - REFIT.fetch * over),
      ),
    );
    expect(f.fits).toBe(4);
    // A calm and the first breath after it.
    f.follow(wind(0, 0));
    expect(f.fits).toBe(5);
    f.follow({ ...wind(0, 0), speed: REFIT.least * over });
    expect(f.fits).toBe(6);
    f.forget();
    f.follow({ ...wind(0, 0), speed: REFIT.least * over });
    expect(f.fits).toBe(7);
  });

  it('holds the waves within half a percent of their height as the wind wanders, with a fit a few dozen frames', () => {
    for (const p of [first, fine]) {
      const f = new SpectrumFollower(sea, p);
      const frames = 4000;
      let worst = 0;
      for (let i = 0; i <= frames; i++) {
        // From a breath to a storm and back, turning one and a half times
        // round, over fetches from 2 to 6 miles.
        const t = i / frames;
        const w = wind(0.5 + 59.5 * Math.sin(Math.PI * t) ** 2, 540 * t, 2 + 4 * t);
        const got = f.follow(w);
        const exact = spectrumInputs(sea, p, w, newSpectrumInputs());
        // What the shader is given every frame is the wind's own.
        expect(got.level).toBe(exact.level);
        expect(got.peak).toBe(exact.peak);
        expect(got.east).toBe(exact.east);
        expect(got.north).toBe(exact.north);
        // A wave's height goes as the square root of level × fit.
        worst = Math.max(
          worst,
          Math.abs(Math.sqrt((got.level * got.fit) / (exact.level * exact.fit)) - 1),
        );
      }
      expect(worst).toBeLessThan(0.006);
      expect(f.fits).toBeLessThan(frames / 8);
    }
  });
});
