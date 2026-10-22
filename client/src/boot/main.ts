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
//   ?world=7          the sandbox in seed 7's world, from .dev/worlds/7.world (go run ./tools/dev -world 7)
//   ?wind=12,45       the sandbox's wind: knots 10 m up, and the degrees it comes from
//   ?sea=gale         the sandbox's wind by the sea it raises: calm, breeze, fresh or gale
//   ?weather=squall   the sandbox's weather: steady, a regime's id, front, or a kind of
//                     system's id to meet the boat three minutes in
//   ?front=40         a front crossing the boat that many minutes in, its sheets first
//   ?cloud=trade      a regime's weather, with its fair-weather cumulus
//   ?rain=20          rain held at the camera, mm an hour
//   ?swell=0.6,6,270  a swell of the sandbox's own: height m, period s, from degrees
//   ?edge=off         no mist, lip or falls
//   ?dev              the developer panel (loaded only when asked for)
//   ?backend=webgl2   the WebGL 2 back end even where WebGPU is offered
//   ?tier=low         a tier, high, medium or low, held: adaptive quality is off
//   ?compat           a WebGPU device held to compatibility mode's limits
//   ?view=bands       a camera preset: chase, sea, bands, aboard or high
//   ?sky=dusk,0.5     the sky at an hour (dawn, noon, dusk, midnight, or 0 to 24)
//                     and the moon's age (0 new, 0.5 full), for the developer
//   ?chart=sight      the sandbox's world charted as its lookout sees it, by the
//                     server's sight table, rather than whole (?chart=all)
//   ?test             the hooks the browser tests drive
//
// F flies the free camera off the boat and back, Escape brings it back: in
// the sandbox for anyone, online for an account with the owner's flag.

import './game.css';
import { signal } from '@preact/signals';
import { createGuest } from '../account/guest';
import { resolveSailor } from '../account/me';
import { backSoon, showStartScreen } from '../account/start';
import { CATALOG_VERSION, catalog } from '../catalog';
import { Forecasting } from '../chart/forecasting';
import { GaleNotices } from '../chart/gales';
import { chartSandbox, fetchSandboxChart, makeChart, sandboxModels } from '../chart/make';
import { Models } from '../chart/model';
import { STEPS_PER_SECOND } from '../game/clock';
import { Game } from '../game/game';
import { Land } from '../land/land';
import {
  FILE_WORLD,
  fetchWorldFile,
  handWorld,
  lightsSeen,
  placesSeen,
  type WorldFile,
} from '../land/world';
import { Online } from '../net/online';
import { reloadForVersion } from '../net/reload';
import { LAYOUT_VERSION, RECORDS } from '../predict/layout.gen';
import { loadPhysics, type Physics } from '../predict/physics';
import wasmUrl from '../predict/physics.wasm?url';
import { Predictor, prepareEncounters } from '../predict/predictor';
import { regimeIndex } from '../predict/weather';
import { ROAM_HIGH } from '../render/freecam';
import { flashNear } from '../render/lightning';
import { chooseBackend } from '../render/renderer';
import { CAMERA_PRESETS, SeaScene } from '../render/scene';
import { pointUp } from '../render/signals';
import { SandboxForecast } from '../sandbox/forecast';
import { swellFromQuery } from '../sandbox/localsea';
import {
  commonestWeather,
  FRONT,
  flashFromQuery,
  fogFromQuery,
  frontFromQuery,
  galeFromQuery,
  rainFromQuery,
  START,
  STEADY,
  seaFromQuery,
  startSandbox,
  weatherFromQuery,
  windFromQuery,
} from '../sandbox/sandbox';
import { sandboxEpochUs, skyFromQuery, skyPeriods, skyTimeFor } from '../sky/skytime';
import { Barometer } from '../ui/barometer';
import type { DialWord } from '../ui/barometerdial';
import { serverNews } from '../ui/chart';
import { Countdown, EndNotices, localShown } from '../ui/countdown';
import { mountScreen } from '../ui/hud';
import { saveNoticesOff } from '../ui/notices';
import { showQueue } from '../ui/queue';
import { settingsSignal } from '../ui/settings';
import { harbourWater, watchHarbour } from './harbour';

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
    const frontIn = frontFromQuery(query);
    // ?world=seed: a whole world, from the file go run ./tools/dev -world
    // writes, the boat at its start: its first mooring, facing the narrows.
    const seed = query.get('world');
    const file: WorldFile | null = seed === null ? null : await fetchWorldFile(seed);
    const place = file?.start.places[0];
    const begin = {
      ...START,
      ...(file === null || place === undefined
        ? {}
        : {
            east: place[0],
            north: place[1],
            heading: file.start.headings?.[0] ?? file.start.heading,
          }),
      wind: wind ?? START.wind,
      // ?front=minutes: a front that far off, its sheets ahead of it;
      // ?cloud=regime: that regime's weather, with its cumulus.
      weather:
        frontIn !== null
          ? FRONT
          : (weatherFromQuery(query, catalog.weather) ??
            (query.has('cloud') && regimeIndex(catalog.weather, query.get('cloud') ?? '') >= 0
              ? (query.get('cloud') as string)
              : wind !== null || query.has('test')
                ? STEADY
                : commonestWeather(catalog.weather))),
      ...(frontIn === null ? {} : { frontIn }),
    };
    const [, sandbox] = await Promise.all([
      world.start(),
      startSandbox(fetch(wasmUrl), world.kind.physics, catalog.weather, catalog.world, begin),
    ]);
    prepareEncounters(sandbox.physics, catalog.encounters);
    // The edge's rules, as a server keeps them; the world file's water's way.
    sandbox.edge = { fall: Math.round(catalog.world.edge.fall * STEPS_PER_SECOND) };
    sandbox.setCirculation(file?.circulation ?? 1);
    // ?swell=height,period,from: a swell of the developer's own.
    sandbox.startSwell = swellFromQuery(query);
    sandbox.sea.options.swell = sandbox.startSwell;
    sandbox.settleSea();
    game.setDriver(sandbox);
    if (file !== null) {
      const land = new Land(
        new Worker(new URL('../workers/mesh/worker.ts', import.meta.url), { type: 'module' }),
        catalog.world,
        catalog.weather.sea.breaking,
      );
      world.useLand(land);
      game.bedFriction = (east, north) => land.frictionAt(east, north);
      world.freeCam.ground = (east, north) => land.heightAt(east, north);
      land.setWorld(FILE_WORLD, true, sandbox.physics);
      const s = sandbox.physics.records.state;
      // The land about the boat, or about the free camera while it flies,
      // as a server hands it.
      const free = world.freeCam;
      const high = { ...catalog.world.handout, camera: ROAM_HIGH };
      await handWorld(
        land,
        file,
        catalog.world.handout,
        () => [s[RECORDS.state.x] ?? 0, s[RECORDS.state.y] ?? 0],
        { rule: high, where: () => (free.on ? [free.east, free.north] : null) },
        {
          places: placesSeen(file, catalog.world.places),
          lights: lightsSeen(file, catalog.world.lights.fogSignals, catalog.world.lights.fogSignal),
          drop: catalog.world.lights.drop,
          onPlaces: (p) => {
            world.lighthouses.setPlaces(p);
            world.wrecks.setPlaces(p);
          },
          onLights: (l, drop) => world.lighthouses.setLights(l, drop),
        },
      );
      // Every island's cap: the sandbox has the whole world.
      world.weather.setCaps(file.caps, 'all');
    }
    world.useSky(sandbox.physics, sandboxEpochUs(catalog.sky));
    // ?rain=mm: rain held at the camera.
    world.weather.heldRain = rainFromQuery(query);
    // ?fog=m: a fog bank of that core held on the boat; ?flash=s: the
    // nearest heaped cloud flashes to the sea that many seconds in.
    const fog = fogFromQuery(query);
    if (fog !== null) {
      sandbox.holdFog(fog);
    }
    // ?board: the boat in Port Royal's harbour, where the board is.
    if (query.has('board')) {
      const at = harbourWater(world);
      if (at !== null) {
        sandbox.place(at.east, at.north, 0);
      }
    }
    // ?gale=minutes: a storm to bring a gale to the boat that many minutes on.
    const gale = galeFromQuery(query);
    if (gale !== null) {
      const s = sandbox.physics.records.state;
      sandbox.meetGale(s[RECORDS.state.x] ?? 0, s[RECORDS.state.y] ?? 0, gale);
    }
    const flash = flashFromQuery(query);
    if (flash !== null) {
      const s = sandbox.physics.records.state;
      world.lightning.force(
        flashNear(
          world.weather.heaped,
          s[RECORDS.state.x] ?? 0,
          s[RECORDS.state.y] ?? 0,
          world.ticks,
          flash,
        ),
      );
    }
    chooseSky(world, query);
    // The forecast, made as a server makes it from the sandbox's own
    // weather, every ten minutes of world time.
    let sandboxForecast: SandboxForecast | null = null;
    const forecasting = new Forecasting({
      physics: sandbox.physics,
      boat: world.kind.physics,
      tick: () => world.ticks,
      present: () => ({
        keys: sandboxForecast === null ? [] : [sandboxForecast.keyframeAt(Math.floor(world.ticks))],
        spells: sandbox.weather.spells,
      }),
      skyTime: (t) => world.skyTime?.at(t) ?? null,
      end: () => 0,
    });
    // The world's chart, read once its land is handed, so the sea starts as
    // it does without one.
    const chartFile = seed === null ? null : await fetchSandboxChart(seed);
    const parts = makeChart(world, sandboxModels(chartFile), null, forecasting);
    sandboxForecast = new SandboxForecast(
      { physics: sandbox.physics, tick: () => world.ticks, spells: () => sandbox.weather.spells },
      forecasting.forecasts,
      catalog.weather.forecast.every * 60 * STEPS_PER_SECOND,
      (east, north) => {
        const e = parts.chart.store.nearestNamed(east, north);
        return e === undefined ? null : { subject: e.subject, number: e.number };
      },
    );
    const issuer = sandboxForecast;
    const baro = startBarometer(world, sandbox.physics, forecasting);
    // ?baro=hPa: a fall or a rise held, that much a quarter of an hour.
    const held = baroFromQuery(query);
    if (held !== null) {
      baro.barometer.held = { rate: held, from: world.ticks };
    }
    const gales = new GaleNotices(parts.chart.store, parts.notices);
    issuer.onIssue = (f) => {
      gales.issued(f);
      world.galeUp = f.gale === null ? null : pointUp(f.gale.from);
    };
    setInterval(() => issuer.tick(), 500);
    if (chartFile !== null) {
      chartSandbox(
        chartFile,
        parts.chart.store,
        query.get('chart') === 'sight' ? 'sight' : 'all',
        () => ({
          east: world.pose.east,
          north: world.pose.north,
          sun: world.sky.now.sunHeight,
          physics: world.ocean.source?.weather === true ? world.ocean.source.physics : null,
          tick: world.ticks,
        }),
      );
    }
    mountScreen(document.body, {
      model: game.hud,
      settings: game.settings,
      helm: game.helm,
      sheet: game.sheet,
      pilot: game,
      labels: (el) => world.attachLabels(el),
      sailor: null,
      connection: null,
      fly: {
        can: signal(true),
        flying: game.flying,
        back: game.backShown,
        fly: () => game.fly(),
        land: () => game.land(),
      },
      sea: parts.sea,
      notices: parts.notices,
      barometer: baro,
      harbour: {
        port: watchHarbour(world, parts.chart.store),
        src: forecasting,
        store: parts.chart.store,
      },
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
      exposeHooks(world, game, {
        sandbox,
        chart: parts,
        forecast: issuer,
        barometer: baro.barometer,
      });
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
  const predictor = new Predictor(
    physics,
    world.kind.physics,
    catalog.weather,
    catalog.world,
    catalog.encounters,
  );
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
  // The land: its chunks fetched and built off the page's thread.
  const land = new Land(
    new Worker(new URL('../workers/mesh/worker.ts', import.meta.url), { type: 'module' }),
    catalog.world,
    catalog.weather.sea.breaking,
  );
  world.useLand(land);
  game.bedFriction = (east, north) => land.frictionAt(east, north);
  world.freeCam.ground = (east, north) => land.heightAt(east, north);
  // The free camera is the owner's alone: the server hears it from no other.
  game.canFly = () => online.tools.value;
  game.onRoam = (on, east, north, height) => online.roam(on, east, north, height);
  let worldId = '';
  const models = new Models();
  online.onWorld = (id, sailed) => {
    if (id !== worldId) {
      // Another world: its places, lights and islands' models are its own,
      // and its weather.
      world.lighthouses.clear();
      world.wrecks.clear();
      models.clear();
      forecasting.forecasts.reset();
      gales.reset();
      worldId = id;
    }
    land.setWorld(id, sailed, sailed ? predictor.physics : null);
  };
  online.onChunks = (c) => land.hand(c.numbers, c.paths);
  online.onPlaces = (p) => {
    world.lighthouses.setPlaces(p);
    world.wrecks.setPlaces(p);
  };
  online.onLights = (l, drop) => world.lighthouses.setLights(l, drop);
  online.onCaps = (c, drop) => world.weather.setCaps(c, drop);
  // The forecast as the server issues it, and what has been, kept.
  const forecasting = new Forecasting({
    physics: predictor.physics,
    boat: world.kind.physics,
    tick: () => world.ticks,
    present: () => ({ keys: predictor.weather.keyframes, spells: predictor.weather.spells }),
    skyTime: (t) => world.skyTime?.at(t) ?? null,
    end: () =>
      online.endsMs > 0 && online.epochUs > 0
        ? Math.floor(((online.endsMs * 1000 - online.epochUs) * STEPS_PER_SECOND) / 1e6)
        : 0,
  });
  online.onWeather = (spells, keyframes) => forecasting.forecasts.keep(spells, keyframes);
  // The world's chart, as the server tells of it; the notices it raises,
  // switched off as the account has them.
  const parts = makeChart(world, models, serverNews, forecasting);
  const gales = new GaleNotices(parts.chart.store, parts.notices);
  online.onForecast = (f, past) => {
    forecasting.forecasts.receive(f, past);
    gales.issued(f);
    // The storm cone hangs while a warning is in force.
    world.galeUp = f.gale === null ? null : pointUp(f.gale.from);
  };
  parts.chart.store.me = me.name;
  parts.notices.off.value = new Set(me.noticesOff ?? []);
  parts.notices.save = (off) => saveNoticesOff(off);
  online.onChart = (entries, whole) => parts.chart.store.receive(entries, whole);
  // The countdown to the world's end, by the world clock, and the notices
  // of the world's life, worked out here from the end each Welcome tells.
  const countdown = new Countdown(() => online.utcMs());
  const endNotices = new EndNotices(
    countdown,
    catalog.notices.kinds,
    localShown(),
    (on, fill, now) => parts.notices.raise(on, fill, now),
  );
  online.onEnd = (e) => {
    // A new world after the old one's end rises out of the mist.
    const was = countdown.end.value;
    if (was !== null && was.world !== e.world && countdown.left <= 0) {
      world.rise();
    }
    countdown.setEnd(e);
    endNotices.welcome(performance.now());
  };
  // The staged end, by the world clock, the same on every page.
  world.endIn = () => {
    const e = countdown.end.value;
    const now = online.utcMs();
    return e === null || e.ends === 0 || Number.isNaN(now)
      ? Number.POSITIVE_INFINITY
      : (e.ends - now) / 1000;
  };
  setInterval(() => {
    countdown.tick();
    endNotices.tick(performance.now());
  }, 250);
  connect(online);
  // "Back soon" while the first connection cannot be made, and the queue
  // while the sea is full.
  const waiting = online.status.subscribe((status) => notice(status === 'waiting'));
  const queue = showQueue(document.body, online.place);
  await online.ready;
  // The land about the boat is drawn before the sea is shown, or the sea
  // shows after three seconds whatever has come.
  await nearLand(land, predictor, NEAR_LAND, NEAR_LAND_WAIT);
  waiting();
  queue();
  notice(false);

  game.setDriver(predictor);
  game.pacer = online;
  const baro = startBarometer(world, predictor.physics, forecasting);
  mountScreen(document.body, {
    model: game.hud,
    settings: game.settings,
    helm: game.helm,
    sheet: game.sheet,
    pilot: game,
    labels: (el) => world.attachLabels(el),
    sailor: me.name,
    connection: { notice: online.notice, rtt: online.rtt, takeOver: () => online.takeOver() },
    fly: {
      can: online.tools,
      flying: game.flying,
      back: game.backShown,
      fly: () => game.fly(),
      land: () => game.land(),
    },
    sea: parts.sea,
    notices: parts.notices,
    end: countdown,
    barometer: baro,
    harbour: {
      port: watchHarbour(world, parts.chart.store),
      src: forecasting,
      store: parts.chart.store,
    },
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
    exposeHooks(world, game, { online, predictor, chart: parts, barometer: baro.barometer });
  }
}

/** The barometer and the words about its dial. */
interface BarometerParts {
  barometer: Barometer;
  words: readonly DialWord[];
}

/** ?baro=hPa: a change held on the barometer, that much a quarter of an hour; null for none. */
function baroFromQuery(query: URLSearchParams): number | null {
  const v = Number.parseFloat(query.get('baro') ?? '');
  return Number.isFinite(v) ? v : null;
}

/**
 * The barometer aboard, read once a second at the boat from the first
 * module's weather now, its past from the truth kept.
 */
function startBarometer(
  world: SeaScene,
  physics: Physics,
  forecasting: Forecasting,
): BarometerParts {
  const b = catalog.world.instruments.barometer;
  const barometer = new Barometer({ range: [b.range[0] ?? 950, b.range[1] ?? 1040], set: b.set });
  setInterval(() => {
    const tick = world.ticks;
    const east = world.pose.east;
    const north = world.pose.north;
    barometer.update(
      tick,
      () => {
        physics.windDrawAt(tick);
        return physics.pressure(east, north);
      },
      (t) => forecasting.pressureBefore(t, east, north),
    );
  }, 1000);
  return { barometer, words: b.words };
}

/** The start screen waits for the chunks handed within this of the boat, m, or this long, ms. */
const NEAR_LAND = 300;
const NEAR_LAND_WAIT = 3000;

/** Resolves once the land within reach of the predicted boat has been had, or after wait ms. */
async function nearLand(
  land: Land,
  predictor: Predictor,
  reach: number,
  wait: number,
): Promise<void> {
  const until = performance.now() + wait;
  const s = predictor.records.state;
  while (
    performance.now() < until &&
    !land.ready(s[RECORDS.state.x] ?? 0, s[RECORDS.state.y] ?? 0, reach)
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
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
