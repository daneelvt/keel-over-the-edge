// SPDX-License-Identifier: AGPL-3.0-only

// The game's page: the player's boat at sea, sailed with two thumbs (or the
// keyboard), the physics module stepping it in the page ahead of the
// server. While the scene and the physics module load, the page asks the
// server whose session this browser holds: a returning player goes
// straight to sea, a new one gets the start screen first, and while the
// server cannot answer the page says so and asks again. Then the net
// worker opens the game connection, and the sea appears with the boat's
// first snapshot; the page goes on predicting it, and says so when the
// connection is poor or lost.
//
// Query strings, for development:
//   ?sandbox          the offline sandbox alone: no server, no account
//   ?wind=12,45       the sandbox's wind: knots 10 m up, and the degrees it comes from
//   ?sea=gale         the sandbox's wind by the sea it raises: calm, breeze, fresh or gale
//   ?dev              the developer panel (loaded only when asked for)
//   ?backend=webgl2   the WebGL 2 back end even where WebGPU is offered
//   ?tier=low         a tier, high, medium or low, held: adaptive quality is off
//   ?compat           a WebGPU device held to compatibility mode's limits
//   ?view=bands       a camera preset: chase, sea, bands, aboard or high
//   ?sky=dusk,0.5     the sky at an hour (dawn, noon, dusk, midnight, or 0 to 24)
//                     and the moon's age (0 new, 0.5 full), for the developer
//   ?test             the hooks the browser tests drive

import './game.css';
import { createGuest } from '../account/guest';
import { resolveSailor } from '../account/me';
import { backSoon, showStartScreen } from '../account/start';
import { CATALOG_VERSION, catalog } from '../catalog';
import { Game } from '../game/game';
import { Online } from '../net/online';
import { reloadForVersion } from '../net/reload';
import { LAYOUT_VERSION } from '../predict/layout.gen';
import { loadPhysics } from '../predict/physics';
import wasmUrl from '../predict/physics.wasm?url';
import { Predictor } from '../predict/predictor';
import { chooseBackend } from '../render/renderer';
import { CAMERA_PRESETS, SeaScene } from '../render/scene';
import {
  commonestWeather,
  START,
  STEADY,
  seaFromQuery,
  startSandbox,
  weatherFromQuery,
  windFromQuery,
} from '../sandbox/sandbox';
import { sandboxEpochUs, skyFromQuery, skyPeriods, skyTimeFor } from '../sky/skytime';
import { mountScreen } from '../ui/hud';
import { showQueue } from '../ui/queue';
import { settingsSignal } from '../ui/settings';

async function start(): Promise<void> {
  const query = new URLSearchParams(location.search);
  const backend = chooseBackend(query, 'gpu' in navigator);
  const container = document.createElement('div');
  container.className = 'stage';
  document.body.replaceChildren(container);

  const settings = settingsSignal();
  let store: Storage | null = null;
  try {
    store = localStorage;
  } catch {
    // Storage refused: nothing is remembered.
  }
  const world = new SeaScene(container, backend, {
    query,
    store,
    detail: settings.value.value.detail,
  });
  const dev = query.has('dev');

  const game = new Game(world, settings);

  const view = CAMERA_PRESETS[query.get('view') ?? ''];
  if (query.has('sandbox')) {
    // The physics module compiles while the renderer starts; the boat is
    // sailed once both are ready.
    // A steady wind where one is asked for, and for the tests, whose
    // pictures and recordings are of one wind; otherwise a spell of the
    // commonest regime, with its shifts and gusts.
    const wind = windFromQuery(query) ?? seaFromQuery(query);
    const begin = {
      ...START,
      wind: wind ?? START.wind,
      weather:
        weatherFromQuery(query, catalog.weather) ??
        (wind !== null || query.has('test') ? STEADY : commonestWeather(catalog.weather)),
    };
    const [, sandbox] = await Promise.all([
      world.start(),
      startSandbox(fetch(wasmUrl), world.kind.physics, catalog.weather, begin),
    ]);
    game.setDriver(sandbox);
    world.useSky(sandbox.physics, sandboxEpochUs(catalog.sky));
    chooseSky(world, query);
    mountScreen(document.body, {
      model: game.hud,
      settings: game.settings,
      helm: game.helm,
      sheet: game.sheet,
      labels: (el) => world.attachLabels(el),
      sailor: null,
      connection: null,
    });
    game.listen(document, container);
    if (view !== undefined) {
      world.placeCamera(view);
    }
    if (dev) {
      const { openPanel } = await import('../dev/panel');
      openPanel(world, game, sandbox, document.body);
    }
    if (query.has('test')) {
      const { exposeHooks } = await import('../dev/hooks');
      exposeHooks(world, game, { sandbox });
    }
    return;
  }

  // The physics module compiles while the renderer starts and the sailor is
  // found, so none waits on another; the controls listen only at sea, so
  // typing a name steers nothing.
  const notice = backSoon(document.body);
  const [, physics, me] = await Promise.all([
    world.start(),
    loadPhysics(fetch(wasmUrl)),
    resolveSailor({
      start: () =>
        showStartScreen(document.body, {
          sailors: catalog.sailors,
          create: (name, look) => createGuest(name, look),
        }),
      backSoon: notice,
    }),
  ]);
  const predictor = new Predictor(physics, world.kind.physics, catalog.weather);
  const worker = new Worker(new URL('../workers/net/worker.ts', import.meta.url), {
    type: 'module',
  });
  const online = new Online(worker, predictor, game);
  world.fleetSource = online.fleet;
  world.onQuality = (tier, scale) => online.quality(tier, scale);
  online.quality(world.tier.number, world.stage.pixelRatio());
  // The sky is counted from the world's epoch, which the Welcome tells.
  let chosen = false;
  online.onEpoch = (epochUs) => {
    world.useSky(predictor.physics, epochUs);
    if (!chosen) {
      chosen = true;
      chooseSky(world, query);
    }
  };
  online.onBump = (b) => game.bump(b, performance.now());
  connect(online);
  // "Back soon" while the first connection cannot be made, and the queue
  // while the sea is full.
  const waiting = online.status.subscribe((status) => notice(status === 'waiting'));
  const queue = showQueue(document.body, online.place);
  await online.ready;
  waiting();
  queue();
  notice(false);

  game.setDriver(predictor);
  game.pacer = online;
  mountScreen(document.body, {
    model: game.hud,
    settings: game.settings,
    helm: game.helm,
    sheet: game.sheet,
    labels: (el) => world.attachLabels(el),
    sailor: me.name,
    connection: { notice: online.notice, rtt: online.rtt, takeOver: () => online.takeOver() },
  });
  game.listen(document, container);
  if (view !== undefined) {
    world.placeCamera(view);
  }
  if (dev) {
    const { openNetPanel } = await import('../dev/panel');
    openNetPanel(world, online, predictor, document.body);
  }
  if (query.has('test')) {
    const { exposeHooks } = await import('../dev/hooks');
    exposeHooks(world, game, { online, predictor });
  }
}

/** With ?sky, draws the sky at the hour and moon asked for, from now on: the developer's sky alone. */
function chooseSky(world: SeaScene, query: URLSearchParams): void {
  const choice = skyFromQuery(query);
  const sky = world.skyTime;
  if (choice !== null && sky !== null) {
    sky.set(skyTimeFor(choice, skyPeriods(catalog.sky)), world.ticks);
  }
}

/** The game connection's URL: this page's own host, /ws. */
function gameURL(): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

/**
 * Starts the connection, and follows the page's life: a page shown again,
 * or a network back, stops the wait; a page that goes closes it; a session
 * gone goes to the start screen; a version mismatch reloads, once a minute
 * at most.
 */
function connect(online: Online): void {
  const versions = { catalog: CATALOG_VERSION, physicsLayout: LAYOUT_VERSION, build: 'web' };
  online.start(gameURL(), versions);
  window.addEventListener('online', () => online.wake());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      online.wake();
    }
  });
  window.addEventListener('pagehide', () => online.stop());
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
      online.start(gameURL(), versions);
    }
  });
  online.status.subscribe((status) => {
    if (status === 'signed-out') {
      location.reload();
    } else if (status === 'version') {
      let marks: Storage | null = null;
      try {
        marks = sessionStorage;
      } catch {
        // Storage refused.
      }
      if (reloadForVersion(marks, Date.now())) {
        location.reload();
      } else {
        online.notice.value = {
          text: 'An update is coming. Reload in a minute.',
          takeover: false,
        };
      }
    }
  });
}

start().catch((err: unknown) => {
  const p = document.createElement('p');
  p.className = 'failure';
  p.textContent = `The sea could not be drawn: ${err instanceof Error ? err.message : String(err)}`;
  document.body.replaceChildren(p);
  console.error(err);
});
