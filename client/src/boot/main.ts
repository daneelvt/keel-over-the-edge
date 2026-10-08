// SPDX-License-Identifier: AGPL-3.0-only

// The game's page: the player's boat at sea, sailed with two thumbs (or the
// keyboard), the physics module stepping it in the page. With no server yet,
// the page is the offline sandbox: one boat in a steady wind.
//
// Query strings, for development:
//   ?sandbox          the offline sandbox (for now the page is nothing else)
//   ?wind=12,45       the sandbox's wind: knots 10 m up, and the degrees it comes from
//   ?dev              the developer panel (loaded only when asked for)
//   ?backend=webgl2   the WebGL 2 back end even where WebGPU is offered
//   ?sea=gale         the test sea: calm, breeze, fresh or gale
//   ?view=bands       a camera preset: chase, sea, bands, aboard or high
//   ?test             the hooks the browser tests drive

import './game.css';
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
  mountScreen(document.body, {
    model: game.hud,
    settings: game.settings,
    helm: game.helm,
    sheet: game.sheet,
    labels: (el) => world.overlays.attachLabels(el),
  });
  game.listen(document, container);

  // The physics module compiles while the renderer starts, so neither waits
  // on the other; the boat is sailed from the first frame both are ready.
  const kind = world.kind;
  const begin = { ...START, wind: windFromQuery(query) ?? START.wind };
  const [, sandbox] = await Promise.all([
    world.start(),
    startSandbox(fetch(wasmUrl), kind.physics, begin).then((s) => {
      game.setDriver(s);
      return s;
    }),
  ]);
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
