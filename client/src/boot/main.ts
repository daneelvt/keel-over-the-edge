// SPDX-License-Identifier: AGPL-3.0-only

// The game's page: the player's boat at sea, sailed with two thumbs (or the
// keyboard), the physics module stepping it in the page. While the scene
// and the physics module load, the page asks the server whose session this
// browser holds: a returning player goes straight to sea, a new one gets
// the start screen first, and while the server cannot answer the page says
// so and asks again. At sea it is still the offline sandbox: one boat in a
// steady wind.
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
import { type Me, resolveSailor } from '../account/me';
import { backSoon, showStartScreen } from '../account/start';
import { catalog } from '../catalog';
import { Game } from '../game/game';
import wasmUrl from '../predict/physics.wasm?url';
import { chooseBackend } from '../render/renderer';
import { CAMERA_PRESETS, SeaScene } from '../render/scene';
import { START, startSandbox, windFromQuery } from '../sandbox/sandbox';
import { mountScreen } from '../ui/hud';
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

  // The physics module compiles while the renderer starts and the sailor is
  // found, so none waits on another; the boat is sailed once all three are
  // ready, and the controls listen only then, so typing a name steers
  // nothing.
  const sailor: Promise<Me | null> = query.has('sandbox')
    ? Promise.resolve(null)
    : resolveSailor({
        start: () =>
          showStartScreen(document.body, {
            sailors: catalog.sailors,
            create: (name, look) => createGuest(name, look),
          }),
        backSoon: backSoon(document.body),
      });
  const kind = world.kind;
  const begin = { ...START, wind: windFromQuery(query) ?? START.wind };
  const [, sandbox, me] = await Promise.all([
    world.start(),
    startSandbox(fetch(wasmUrl), kind.physics, begin),
    sailor,
  ]);
  game.setDriver(sandbox);
  mountScreen(document.body, {
    model: game.hud,
    settings: game.settings,
    helm: game.helm,
    sheet: game.sheet,
    labels: (el) => world.overlays.attachLabels(el),
    sailor: me?.name ?? null,
  });
  game.listen(document, container);
  const view = CAMERA_PRESETS[query.get('view') ?? ''];
  if (view !== undefined) {
    world.placeCamera(view);
  }

  if (dev) {
    const { openPanel } = await import('../dev/panel');
    openPanel(world, game, sandbox, document.body);
  }
  if (query.has('test')) {
    const { exposeHooks } = await import('../dev/hooks');
    exposeHooks(world, game, sandbox);
  }
}

start().catch((err: unknown) => {
  const p = document.createElement('p');
  p.className = 'failure';
  p.textContent = `The sea could not be drawn: ${err instanceof Error ? err.message : String(err)}`;
  document.body.replaceChildren(p);
  console.error(err);
});
