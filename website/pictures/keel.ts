// SPDX-License-Identifier: AGPL-3.0-only

// The game's test hooks, as much of them as the pictures use. The client's
// page puts them on window with ?test (client/src/dev/hooks.ts, where each
// is described); the staging runs in that page, so it sees them as
// globalThis.keel. Typed here by hand: the client's own types follow its
// whole scene, which the website does not build.

export interface CameraView {
  /** Radians round from astern, positive to starboard. */
  azimuth: number;
  /** Radians above the horizontal. */
  elevation: number;
  /** Metres from the boat, scaled by her size. */
  distance: number;
}

export interface Cloud {
  form: number;
  slot: number;
  east: number;
  north: number;
  top: number;
}

export interface Keel {
  ready(): Promise<void>;
  info(): { backend: string; tier: string; rung: number; pixelRatio: number };
  setRung(rung: number): void;
  freeze(t: number): void;
  freezeTick(tick: number): void;
  reset(): void;
  render(): void;
  show(): Promise<void>;
  camera(view: string | CameraView): void;
  setSky(hour: number, moon?: number | null): void;
  holdSky(on: boolean): void;
  placeBoat(east: number, north: number, heading?: number): void;
  setState(values: Record<string, number>): void;
  setControls(helm: number, sheet: number): void;
  setSea(name: string): void;
  setWind(knots: number, from: number): void;
  setWeather(id: string): void;
  setFog(core: number | null): void;
  advance(steps: number): void;
  sailFrames(frames: number, steps?: number): void;
  flashIn(seconds: number): void;
  flashes(): { flashes: { east: number; north: number }[]; segments: number };
  clouds(): { clouds: Cloud[]; rain: number } | null;
  boat(): { state: Record<string, number>; wind: Record<string, number> };
  showCrew(n: number, holder?: number): Promise<void>;
  crewReady(): Promise<void>;
  land(): { drawn: unknown[]; ready: boolean; stats: { inFlight: number; handed: number } } | null;
  flora(): { held: number; loaded: boolean } | null;
  features(): { parts: number } | null;
  raceTell(
    told?: Record<string, unknown>,
    entrants?: { name: string; boat: string; machine?: boolean }[],
  ): { marks: { east: number; north: number }[]; start: number } & Record<string, unknown>;
  racePicture(racers: Record<string, number | string>[], race?: number, eye?: number): void;
  racing(): { tracks: { number: number; points: number }[]; chart: Record<string, unknown> };
  openChart(mode: string | null): void;
  chartLayers(layers: Record<string, boolean>): void;
  zoomChart(f: number): void;
  chartFromBoat(distance: number): void;
  world: {
    ticks: number;
    wind: { meanFrom: number };
    pose: { east: number; north: number; heading: number };
  };
}

/** Small helpers the staging shares, put in the page beside the hooks. */
export interface Kit {
  /** Resolves after ms of real time. */
  sleep(ms: number): Promise<void>;
  /** Draws until the land in reach is drawn and settled (and a feature's parts, with parts). */
  landed(parts?: boolean): Promise<void>;
}

declare global {
  var keel: Keel;
  var kit: Kit;
}

/** Puts the kit in the page; run in it by page.evaluate. */
export function installKit(): void {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  globalThis.kit = {
    sleep,
    async landed(parts = false) {
      const k = globalThis.keel;
      // The sandbox hands the land again every half second after a move.
      await sleep(800);
      for (let i = 0; i < 360; i++) {
        k.render();
        const l = k.land();
        const f = k.flora();
        if (
          l !== null &&
          l.drawn.length > 0 &&
          l.stats.inFlight === 0 &&
          l.ready &&
          (f === null || f.held === 0 || f.loaded) &&
          (!parts || (k.features()?.parts ?? 0) > 0)
        ) {
          return;
        }
        await sleep(250);
      }
      throw new Error('the land was not drawn in 90 s');
    },
  };
}
