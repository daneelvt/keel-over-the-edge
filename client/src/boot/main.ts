// SPDX-License-Identifier: AGPL-3.0-only

// The game's page. For now: the sea, the sky and the Jolly boat, with an
// orbit camera for looking.
//
// Query strings, for development:
//   ?dev              the developer panel (loaded only when asked for)
//   ?backend=webgl2   the WebGL 2 back end even where WebGPU is offered
//   ?sea=gale         the test sea: calm, breeze, fresh or gale
//   ?view=bands       a camera preset: sea, bands, aboard or high
//   ?test             the hooks the browser tests drive

import './game.css';
import { chooseBackend } from '../render/renderer';
import { CAMERA_PRESETS, SeaScene } from '../render/scene';

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
  await world.start();
  const view = CAMERA_PRESETS[query.get('view') ?? ''];
  if (view !== undefined) {
    world.placeCamera(view);
  }

  if (dev) {
    const { openPanel } = await import('../dev/panel');
    openPanel(world, document.body);
  }
  if (query.has('test')) {
    const { exposeHooks } = await import('../dev/hooks');
    exposeHooks(world);
  }
}

start().catch((err: unknown) => {
  const p = document.createElement('p');
  p.className = 'failure';
  p.textContent = `The sea could not be drawn: ${err instanceof Error ? err.message : String(err)}`;
  document.body.replaceChildren(p);
  console.error(err);
});
