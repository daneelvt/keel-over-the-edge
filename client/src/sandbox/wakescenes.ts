// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox's wake scenes, ?sandbox&wake=…, for looking at a boat's wake
// in a sea of the developer's choosing (?sea=calm|breeze|fresh): the boat
// steered on its own, as the golden scenarios steer, through what makes a
// wake read as water or not.
//
//   reach   a steady beam reach, eastward, the wind from the north
//   turn    the reach, then a 90° turn to the south, the sheet eased
//   stop    the reach, then head to wind with the sheet let fly: the boat
//           stops in a few lengths and its waves run on
//   cross   the reach, and a second boat crossing its track some ten
//           metres astern, southward
//
// The browser tests take their pictures of the same scenes.

import { type DrawnBoat, newDrawnBoat } from '../game/fleet';
import { steer } from '../predict/golden';
import { RECORDS } from '../predict/layout.gen';

export const WAKE_SCENES = ['reach', 'turn', 'stop', 'cross'] as const;
export type WakeSceneName = (typeof WAKE_SCENES)[number];

/** Reads ?wake=reach|turn|stop|cross, or null. */
export function wakeSceneFromQuery(query: URLSearchParams): WakeSceneName | null {
  const w = query.get('wake');
  return (WAKE_SCENES as readonly string[]).includes(w ?? '') ? (w as WakeSceneName) : null;
}

/** The scenes' timing and course, seconds of world time, radians and m/s. */
export const WAKE_SCENE = {
  /** The reach's heading: east, abeam of the wind from the north. */
  heading: Math.PI / 2,
  /** The turn or the stop comes this long after the start. */
  change: 20,
  /** The turn's new heading: south, the sheet eased. */
  turnTo: Math.PI,
  turnSheet: 0.75,
  /** The other boat's speed, its heading (south), and how far astern of the boat it crosses the track, and when. */
  crossSpeed: 3,
  crossHeading: Math.PI,
  crossAstern: 10,
  crossAt: 18,
} as const;

/** The boat's way at the start, m/s, by the sea's name. */
const START_SURGE: Record<string, number> = { calm: 2, breeze: 3, fresh: 3.5, gale: 4 };

/** What a scene drives. */
export interface WakeSceneHost {
  game: {
    beforeStep: (() => void) | null;
    helm: { target: number };
    sheet: { target: number };
    clock: { steps: number; alpha: number };
  };
  /** The boat's state now, and a way to set some of it. */
  state(): Float64Array;
  setState(values: Record<string, number>): void;
  world: {
    fleetSource: { drawn: readonly DrawnBoat[]; count: number } | null;
    onFrame: (() => void) | null;
  };
}

/**
 * Starts a scene: the boat put on the reach at the sea's way, and steered
 * from now on; for cross, the other boat drawn. Returns what stops it.
 */
export function startWakeScene(host: WakeSceneHost, name: WakeSceneName, sea: string): () => void {
  const s = WAKE_SCENE;
  host.setState({
    heading: s.heading,
    surge: START_SURGE[sea] ?? 3,
    sway: 0,
    yawRate: 0,
    sheetLimit: 0.5,
  });
  host.game.helm.target = 0;
  host.game.sheet.target = 0.3;
  let steps = 0;
  host.game.beforeStep = () => {
    steps++;
    const t = steps / 30;
    let heading: number = s.heading;
    if (name === 'turn' && t > s.change) {
      heading = s.turnTo;
      host.game.sheet.target = s.turnSheet;
    } else if (name === 'stop' && t > s.change) {
      heading = 0;
      host.game.sheet.target = 1;
    }
    host.game.helm.target = steer(heading, host.state());
  };
  if (name !== 'cross') {
    return () => {
      host.game.beforeStep = null;
    };
  }
  // The other boat: southward, crossing the boat's track crossAstern behind
  // where the boat is at crossAt, at the reach's starting way.
  const start = host.state();
  const east0 = start[RECORDS.state.x] ?? 0;
  const north0 = start[RECORDS.state.y] ?? 0;
  const way = START_SURGE[sea] ?? 3;
  const crossEast = east0 + way * s.crossAt - s.crossAstern;
  const other: DrawnBoat = { ...newDrawnBoat(), slot: 0, opacity: 1, look: -1 };
  const drawn = [other];
  host.world.fleetSource = { drawn, count: 1 };
  const first = host.game.clock.steps;
  const before = host.world.onFrame;
  const place = (): void => {
    const t = (host.game.clock.steps + host.game.clock.alpha - first) / 30;
    other.east = crossEast + Math.sin(s.crossHeading) * s.crossSpeed * (t - s.crossAt);
    other.north = north0 + Math.cos(s.crossHeading) * s.crossSpeed * (t - s.crossAt);
    other.heading = s.crossHeading;
    other.speed = s.crossSpeed;
    other.boom = 1.2;
  };
  place();
  host.world.onFrame = () => {
    before?.();
    place();
  };
  return () => {
    host.game.beforeStep = null;
    host.world.onFrame = before;
    host.world.fleetSource = null;
  };
}

/** The host a page's game, sandbox and scene make. */
export function wakeSceneHost(
  game: WakeSceneHost['game'],
  sandbox: { states: { current: Float64Array }; setState(values: Record<string, number>): void },
  world: WakeSceneHost['world'],
): WakeSceneHost {
  return {
    game,
    state: () => sandbox.states.current,
    setState: (v) => sandbox.setState(v),
    world,
  };
}
