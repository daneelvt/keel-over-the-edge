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
//   ?dev              the developer panel (loaded only when asked for)
//   ?backend=webgl2   the WebGL 2 back end even where WebGPU is offered
//   ?sea=gale         the test sea: calm, breeze, fresh or gale
//   ?view=bands       a camera preset: chase, sea, bands, aboard or high
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
import { START, startSandbox, windFromQuery } from '../sandbox/sandbox';
import { mountScreen } from '../ui/hud';
import { showQueue } from '../ui/queue';
import { settingsSignal } from '../ui/settings';

async function start(): Promise<void> {
  const query = new URLSearchParams(location.search);
  const backend = chooseBackend(query, 'gpu' in navigator);
  const container = document.createElement('div');
  container.className = 'stage';
  document.body.replaceChildren(container);

  const world = new SeaScene(container, backend);
  const sea = query.get('sea');
  if (sea !== null) {
    world.setTestSea(sea);
  }
  const dev = query.has('dev');
  world.stage.timestamps = dev;
  world.stats.gpuTiming = dev;

  const game = new Game(world, settingsSignal());

  const view = CAMERA_PRESETS[query.get('view') ?? ''];
  if (query.has('sandbox')) {
    // The physics module compiles while the renderer starts; the boat is
    // sailed once both are ready.
    const begin = { ...START, wind: windFromQuery(query) ?? START.wind };
    const [, sandbox] = await Promise.all([
      world.start(),
      startSandbox(fetch(wasmUrl), world.kind.physics, begin),
    ]);
    game.setDriver(sandbox);
    mountScreen(document.body, {
      model: game.hud,
      settings: game.settings,
      helm: game.helm,
      sheet: game.sheet,
      labels: (el) => world.overlays.attachLabels(el),
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
  const predictor = new Predictor(physics, world.kind.physics);
  const worker = new Worker(new URL('../workers/net/worker.ts', import.meta.url), {
    type: 'module',
  });
  const online = new Online(worker, predictor, game);
  world.fleetSource = online.fleet;
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
    labels: (el) => world.overlays.attachLabels(el),
    sailor: me.name,
    connection: { notice: online.notice, rtt: online.rtt, takeOver: () => online.takeOver() },
  });
  game.listen(document, container);
  if (view !== undefined) {
    world.placeCamera(view);
  }
  if (dev) {
    const { openNetPanel } = await import('../dev/panel');
    openNetPanel(online, predictor, document.body);
  }
  if (query.has('test')) {
    const { exposeHooks } = await import('../dev/hooks');
    exposeHooks(world, game, { online, predictor });
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
