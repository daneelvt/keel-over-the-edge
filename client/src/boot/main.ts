// SPDX-License-Identifier: AGPL-3.0-only

// The game's page: the player's boat at sea, sailed with two thumbs (or the
// keyboard), the physics module stepping it in the page ahead of the
// server. The page's cover, painted first from its HTML, stays over it
// until the world under it is ready (gate.ts), and the start screen stands
// on it. While the scene and the physics module load, the page asks the
// server whose session this browser holds: a returning player goes
// straight to sea (one with machine sailors is shown them first), a new
// one gets the start screen first, and while the server cannot answer the
// page says so and asks again. Then the net
// worker opens the game connection, and the sea appears with the boat's
// first snapshot; the page goes on predicting it, and says so when the
// connection is poor or lost. A page opened at a link to watch, a
// sailor's (?w=<code>) or a fleet's (?f=<code>), or a sailor chosen to
// watch on the start screen, watches that sailor's boat instead, from its
// own place: nothing steers it, and the player may watch another or sail
// from there; a link that opens no watch lands on the player's own panel,
// saying why. A page opened at a link to come aboard (?s=<token>) offers,
// once signed in, to knock on the skipper's boat rather than plain Set
// sail. A page opened at a race's link (?r=<code>) shows its card once
// signed in, or once a new visitor has made their sailor, before their
// own Set sail. Each change of boat goes through the
// cover again: down over the screen, the world changed under it, and up
// once the new boat's world is ready.
//
// Query strings, for development:
//   ?sandbox          the offline sandbox alone: no server, no account
//   ?boat=keelboat    the sandbox's boat: any of the catalog's, by its id
//   ?world=7          the sandbox in seed 7's world, from .dev/worlds/7.world (go run ./tools/dev -world 7)
//   ?wind=12,45       the sandbox's wind: knots 10 m up, and the degrees it comes from
//   ?sea=gale         the sandbox's wind by the sea it raises: calm, breeze, fresh or gale
//   ?wake=turn        a wake scene, the boat steered on its own: reach, turn, stop or cross
//   ?weather=squall   the sandbox's weather: steady, a regime's id, front, or a kind of
//                     system's id to meet the boat three minutes in
//   ?front=40         a front crossing the boat that many minutes in, its sheets first
//   ?cloud=trade      a regime's weather, with its fair-weather cumulus
//   ?rain=20          rain held at the camera, mm an hour
//   ?swell=0.6,6,270  a swell of the sandbox's own: height m, period s, from degrees
//   ?edge=off         no mist, lip or falls
//   ?life=sooty-tern  the sandbox with a group of the sea's life of that kind by the boat
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
//   ?w=<code>         watches the sailor of that link rather than sail, once signed in
//   ?f=<code>         watches the liveliest of that fleet's machine sailors at sea
//   ?s=<token>        asks to come aboard the skipper's boat of that link
//   ?r=<code>         opens that race's card, once signed in, before the sea
//   ?races            the sandbox with races ashore, its routes the tests' own
//
// F flies the free camera off the boat and back, Escape brings it back: in
// the sandbox for anyone, online for an account with the owner's flag.

import './game.css';
import { effect, signal } from '@preact/signals';
import { sailFromQuery } from '../account/comeaboardwords';
import { NOT_WATCHED, watchRefused } from '../account/letwatch';
import { forgetParams } from '../account/links';
import { type Me, resolveSailor } from '../account/me';
import { openLink } from '../account/openlink';
import { backSoon, showAddPasskey, showSailor, showStartScreen } from '../account/start';
import { SETTING_SAIL } from '../account/yoursailor';
import { CATALOG_VERSION, catalog } from '../catalog';
import { codeOf, lookFrom } from '../catalog/looks';
import { Forecasting } from '../chart/forecasting';
import { GaleNotices } from '../chart/gales';
import {
  type ChartParts,
  chartSandbox,
  fetchSandboxChart,
  makeChart,
  sandboxModels,
} from '../chart/make';
import { Models } from '../chart/model';
import { warningInForce } from '../chart/placeweather';
import { STEPS_PER_SECOND } from '../game/clock';
import { Game } from '../game/game';
import { PILOT_HEADING, stepsOf } from '../input/pilot';
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
import { signalFlag } from '../render/committee';
import { PERSON_DEFAULT } from '../render/fleet';
import { ROAM_HIGH } from '../render/freecam';
import { flashNear } from '../render/lightning';
import { chooseBackend } from '../render/renderer';
import { CAMERA_PRESETS, SeaScene } from '../render/scene';
import { pointUp } from '../render/signals';
import { cameraSceneFromQuery, startCameraScene } from '../sandbox/camerascenes';
import { crewFromQuery } from '../sandbox/crewscene';
import { SandboxForecast } from '../sandbox/forecast';
import {
  aboardFromQuery,
  aboardScene,
  lifeKindFromQuery,
  lifeScene,
  raiseScene,
} from '../sandbox/lifescene';
import { swellFromQuery } from '../sandbox/localsea';
import {
  boatFromQuery,
  boatLookFromQuery,
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
import { startWakeScene, wakeSceneFromQuery, wakeSceneHost } from '../sandbox/wakescenes';
import { hourAt, sandboxEpochUs, skyFromQuery, skyPeriods, skyTimeFor } from '../sky/skytime';
import { Barometer } from '../ui/barometer';
import type { DialWord } from '../ui/barometerdial';
import { ClearView, type Needed, needed } from '../ui/clearview';
import { ShipsClock } from '../ui/clock';
import { Countdown, EndNotices, localShown } from '../ui/countdown';
import { deckOf } from '../ui/decklazy';
import { mountScreen, type ScreenProps } from '../ui/hud';
import { setLogHost } from '../ui/loglazy';
import { AGROUND } from '../ui/model';
import { openNews, setNewsHost } from '../ui/newslazy';
import { serverNews } from '../ui/newsread';
import { saveNoticesOff } from '../ui/notices';
import { showQueue } from '../ui/queue';
import { RACE_PARAM, raceFromQuery } from '../ui/raceapi';
import { loadRaces, pollRaces, type RacesView, racesOf } from '../ui/raceslazy';
import { settingsSignal } from '../ui/settings';
import { shipmatesOf } from '../ui/shipmatesview';
import { checkStatements, statementsOf } from '../ui/statementlazy';
import { loadWatch, type WatchView } from '../ui/watchlazy';
import { FLEET_PARAM, linkFromQuery, SAILOR_PARAM } from '../ui/watchwords';
import { type Cover, DROP, LIFT, LIFT_REDUCED, QUIET, takeCover } from './cover';
import { browserEnv, fullScreen } from './fullscreen';
import { Gate, type Revealed, WAITING_WORDS, type Waiting } from './gate';
import { harbourWater, watchHarbour } from './harbour';
import { harbourBoats, sandboxBoats } from './harbourboats';
import { harbourLook, sandboxHarbourLook } from './harbourlook';
import { lookStage } from './lookstage';

/** How long the camera comes down into the first view, s: at the start, and after a change of boat. */
const DESCENT = 2.5;
const DESCENT_CHANGE = 1.5;

/** Whether the reader asks for less motion. */
function reducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/** Resolves after n animation frames: the scene's update has run since. */
function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const next = (left: number) =>
      left <= 0 ? resolve() : requestAnimationFrame(() => next(left - 1));
    next(n);
  });
}

/**
 * Waits on the gate, from start (ms), the cover saying what it waits for
 * once the wait passes a second; the frame loop draws once the frames are
 * waited for. Resolves with what it waited for, and when.
 */
async function untilReady(
  gate: Gate,
  world: SeaScene,
  cover: Cover,
  start: number,
): Promise<Pick<Revealed, 'waits' | 'at' | 'timedOut' | 'drawn'>> {
  const waits: { waiting: Waiting; at: number }[] = [];
  let drawn = 0;
  world.onDrawn = (work) => {
    drawn++;
    gate.drawn(work);
  };
  for (;;) {
    const now = performance.now();
    const w = gate.step(now);
    if (waits[waits.length - 1]?.waiting !== w) {
      waits.push({ waiting: w, at: Math.round(now - start) });
    }
    if (w === 'ready') {
      break;
    }
    if (w === 'sail' && world.drawsWhenReady) {
      world.stage.loopDraws = true;
    }
    if (now - start >= QUIET) {
      cover.say(WAITING_WORDS[w]);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  world.onDrawn = null;
  if (world.drawsWhenReady) {
    world.stage.loopDraws = true;
  }
  return { waits, at: Math.round(performance.now() - start), timedOut: gate.timedOut, drawn };
}

/**
 * The world revealed: the cover fades out as the camera comes down into
 * the first view over descent seconds, the screen at sea coming in after
 * it. With less motion asked for, a short fade and no descent; on a page
 * under test, at once.
 */
function reveal(world: SeaScene, cover: Cover, descent: number): void {
  if (world.underTest) {
    void cover.lift(0);
    return;
  }
  const reduced = reducedMotion();
  world.camera.descend(reduced ? 0 : descent);
  void cover.lift(reduced ? LIFT_REDUCED : LIFT);
}

/** The clear view, the scene's overlays hidden with the screen. */
function clearView(world: SeaScene): ClearView {
  const clear = new ClearView();
  clear.onChange = (on) => {
    world.clearView = on;
  };
  return clear;
}

async function start(): Promise<void> {
  const query = new URLSearchParams(location.search);
  const backend = chooseBackend(query, 'gpu' in navigator);
  const cover = takeCover(document);
  const container = document.createElement('div');
  container.className = 'stage';
  document.body.replaceChildren(container, cover.el);

  const settings = settingsSignal();
  const full = fullScreen(browserEnv(), settings);
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
  // The camera comes back behind the own boat by itself, as the player chooses.
  effect(() => {
    world.camera.easesBack = settings.value.value.cameraBack;
  });
  // A big sea moves the view, unless the player chooses not, or the device
  // asks for reduced motion (the camera's own check).
  effect(() => {
    world.camera.seaMoves = settings.value.value.seaMotion;
  });
  const camera = { resting: world.resting, behind: () => world.camera.behind() };
  const clear = clearView(world);

  const view = CAMERA_PRESETS[query.get('view') ?? ''];
  if (query.has('sandbox')) {
    // The physics module compiles while the renderer starts; the boat is
    // sailed once both are ready.
    // A steady wind where one is asked for, and for the tests, whose
    // pictures and recordings are of one wind; otherwise a spell of the
    // commonest regime, with its shifts and gusts.
    // ?camera=scene: the boat still beside seed 1's land, the camera into it.
    const cameraScene = cameraSceneFromQuery(query);
    const wind =
      windFromQuery(query) ??
      seaFromQuery(query) ??
      (cameraScene === null ? null : { speed: 0, from: 0 });
    const frontIn = frontFromQuery(query);
    // ?world=seed: a whole world, from the file go run ./tools/dev -world
    // writes, the boat at its start: its first mooring, facing the narrows.
    const seed = query.get('world') ?? (cameraScene === null ? null : '1');
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
    // ?look=code: the sailor in a look of the developer's own.
    const sandboxLook = Number(query.get('look') ?? PERSON_DEFAULT) || PERSON_DEFAULT;
    world.sailAs(sandboxLook);
    // ?paint=id&cloth=id&number=n&boatname=text: the boat in a look of the
    // developer's own.
    const boatLook = boatLookFromQuery(query, catalog);
    world.setBoatLook(boatLook.look, boatLook.name);
    // ?boat=id: any of the catalog's boats; every kind is prepared, so the
    // developer panel can change it.
    const kind = boatFromQuery(
      query,
      catalog.boats.map((b) => b.id),
    );
    await game.useKind(kind ?? 0);
    // ?crew=N: N people aboard at their stations, one of them at the helm.
    const crew = crewFromQuery(query, catalog.boats[kind ?? 0]?.capacity ?? 1, catalog);
    if (crew !== null) {
      void world.showCrew(crew);
    }
    const [, sandbox] = await Promise.all([
      world.start(),
      startSandbox(
        fetch(wasmUrl),
        catalog.boats.map((b) => b.physics),
        catalog.weather,
        catalog.world,
        begin,
        kind ?? 0,
      ),
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
            world.race.setPlaces(p);
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
    if (cameraScene !== null && !query.has('test')) {
      startCameraScene(
        {
          place: (east, north, heading) => sandbox.place(east, north, heading),
          landNear: () =>
            world.land !== null &&
            world.land.heightAt(world.pose.east, world.pose.north) !== null &&
            world.land.ready(world.pose.east, world.pose.north, catalog.world.look.keepGrids),
          placeCamera: (v) => world.placeCamera(v),
        },
        cameraScene,
      );
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
    // ?wake=scene: the boat steered through a wake scene of its own.
    const wakeScene = wakeSceneFromQuery(query);
    if (wakeScene !== null && !query.has('test')) {
      startWakeScene(wakeSceneHost(game, sandbox, world), wakeScene, query.get('sea') ?? 'breeze');
    }
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
      {
        physics: sandbox.physics,
        tick: () => world.ticks,
        spells: () => sandbox.weather.spells,
        keyframes: catalog.weather.keyframe.every * STEPS_PER_SECOND,
      },
      forecasting.forecasts,
      catalog.weather.forecast.every * 60 * STEPS_PER_SECOND,
      (east, north) => {
        const e = parts.chart.store.nearestNamed(east, north);
        return e === undefined ? null : { subject: e.subject, number: e.number };
      },
    );
    const issuer = sandboxForecast;
    const baro = startBarometer(world, sandbox.physics, forecasting);
    const clock = startClock(world);
    // ?baro=hPa: a fall or a rise held, that much a quarter of an hour.
    const held = baroFromQuery(query);
    if (held !== null) {
      baro.barometer.hold(held, world.ticks);
    }
    const gales = steerByChart(game, world, parts, forecasting);
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
    // No world ends in the sandbox: its countdown is told an end only by
    // the tests.
    const countdown = new Countdown(() => Date.now());
    setInterval(() => countdown.tick(), 1000);
    // The screen comes back by itself when the sailor goes in the water.
    let was = false;
    effect(() => {
      const now = overboard(game.hud.sailor.value);
      if (now && !was) {
        clear.show();
      }
      was = now;
    });
    const screen: ScreenProps = {
      model: game.hud,
      settings: game.settings,
      helm: game.helm,
      sheet: game.sheet,
      pilot: game,
      reef: game,
      labels: (el) => world.attachLabels(el),
      fullScreen: full,
      sailor: null,
      connection: null,
      end: countdown,
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
      clock: clock.clock,
      harbour: {
        port: watchHarbour(world, parts.chart.store),
        src: forecasting,
        store: parts.chart.store,
        look: sandboxHarbourLook(world, sandboxLook),
        boats: sandboxBoats(catalog),
      },
      camera,
      clear,
    };
    // ?races: races ashore on the sandbox, its routes answered by the tests.
    if (query.has('races')) {
      const races = racesOf();
      pollRaces(races, parts.notices, catalog.notices.kinds);
      screen.races = races;
      if (screen.harbour != null) {
        screen.harbour.races = races;
      }
    }
    let unmount = mountScreen(document.body, screen);
    // A name tapped opens its log on the chart screen's Log tab, as online.
    setLogHost((who) => parts.chart.showLog(who));
    setNewsHost((day) => parts.chart.showNews(day));
    game.listen(document, container);
    // The boat set down, then the world shown.
    await frames(2);
    if (view !== undefined) {
      world.placeCamera(view);
    } else {
      world.placeFirstView();
    }
    // ?life=id: a group of the sea's life of that kind by the boat, its
    // middle 200 m ahead 40 s on (or with the boat, for a kind that
    // follows boats), for pictures of it.
    const lifeKind = lifeKindFromQuery(query, catalog.life);
    const raised = aboardFromQuery(query)
      ? aboardScene(catalog.life, world.ticks, 0)
      : lifeScene(catalog.life, lifeKind, world.ticks, world.pose, 0);
    if (raised !== null) {
      raiseScene(world, raised, catalog.life);
    }
    const start = performance.now();
    const ready = untilReady(
      new Gate(
        { epoch: () => true, boat: () => true, view: () => true, land: () => true },
        { start, draws: world.drawsWhenReady },
      ),
      world,
      cover,
      start,
    );
    if (dev) {
      const { openPanel } = await import('../dev/panel');
      openPanel(world, game, sandbox, document.body, {
        forecasting,
        weather: parts.weather,
        warning: () => warningInForce(forecasting, parts.chart.store),
        barometer: baro.barometer,
      });
    }
    if (query.has('test')) {
      const { exposeHooks } = await import('../dev/hooks');
      exposeHooks(world, game, {
        sandbox,
        fullScreen: full,
        chart: parts,
        forecast: issuer,
        barometer: baro.barometer,
        readBarometer: baro.read,
        clock: clock.clock,
        readClock: clock.read,
        countdown,
        // The screen again, with a watch's parts or without, and sailing
        // together's: the layout's tests.
        remount: (watch, deck = null, statements = null) => {
          unmount();
          unmount = mountScreen(
            document.body,
            watch === null && deck === null ? screen : { ...screen, watch, deck, statements },
          );
        },
      });
    }
    await ready;
    reveal(world, cover, view === undefined ? DESCENT : 0);
    return;
  }

  // The physics module compiles while the renderer starts and the sailor is
  // found, so none waits on another; the controls listen only at sea, so
  // typing a name steers nothing. Every way to sea ends at the player's own
  // sailor and its Set sail; a link to watch goes straight to the watch, or,
  // refused, to the player's own sailor, saying why.
  const notice = backSoon(document.body);
  const linked = linkFromQuery(query);
  // The wait begins at the tap that sets sail, or at once with no screen
  // to tap; the cover answers the tap at once.
  let tapped = performance.now();
  // The player's own sailor is loaded as soon as their look is known: at
  // their own panel, or as the start screen sets sail.
  const own = (me: Me): Me => {
    world.sailAs(codeOf(catalog, lookFrom(me)), true);
    return me;
  };
  const set = (me: Me): Me => {
    tapped = performance.now();
    cover.say(SETTING_SAIL);
    // The look chosen at the start: drawn now, though the own was loaded.
    world.sailAs(codeOf(catalog, lookFrom(me)));
    return me;
  };
  // The picker's stage behind the start screen and the player's own panel,
  // on a page that draws.
  const stage = world.drawsWhenReady ? lookStage(world, cover) : undefined;
  // A link to come aboard (?s=<token>): once signed in, or the sailor
  // made, the skipper's boat and the knock in place of Set sail.
  const sailLink = linked === null ? sailFromQuery(query) : '';
  // A race's link (?r=<code>): its card once signed in, or the sailor
  // made, before the player's own Set sail; Make a race beside Set sail.
  const raceCode = linked === null && sailLink === '' ? raceFromQuery(query) : null;
  const startRaces = racesOf();
  const raceLinked = async (me: Me): Promise<Me> => {
    if (raceCode !== null) {
      const m = await loadRaces();
      startRaces.card.value = raceCode;
      await m.showRaces(document.body, startRaces);
      // Seen: a reload just sails.
      forgetParams(RACE_PARAM);
    }
    return me;
  };
  const yours = (me: Me): Promise<Me> =>
    raceLinked(me).then((m) =>
      showSailor(document.body, own(m), catalog, stage, catalog, startRaces),
    );
  const aboard = (me: Me): Promise<Me> =>
    import('../account/comeaboard').then((m) =>
      m.showComeAboard(document.body, own(me), sailLink, catalog, catalog),
    );
  // A link to watch, once signed in: the sailor it opens, watched at once;
  // or, opening none, the player's own sailor with why at its head.
  const watchLinked = async (me: Me): Promise<Me> => {
    if (linked === null) {
      return me;
    }
    const o = await openLink(linked);
    if ('watch' in o) {
      return { ...me, watch: o.watch };
    }
    const linkNote = { refusal: o.refusal, code: linked.kind === 'sailor' ? linked.code : '' };
    return showSailor(
      document.body,
      own({ ...me, linkNote }),
      catalog,
      stage,
      catalog,
      startRaces,
    ).then(set);
  };
  const [, physics, me] = await Promise.all([
    world.start(),
    loadPhysics(fetch(wasmUrl)),
    resolveSailor({
      start: () =>
        showStartScreen(document.body, {
          looks: catalog,
          boats: catalog,
          ...(stage === undefined ? {} : { stage }),
          ...(linked === null && sailLink === '' && raceCode === null
            ? {}
            : { panel: false, straight: true }),
          ...(linked === null ? {} : { watching: true }),
          ...(raceCode === null ? {} : { racing: true }),
          races: startRaces,
        })
          .then((me) =>
            sailLink !== ''
              ? aboard(me)
              : linked !== null
                ? watchLinked(me)
                : raceCode !== null
                  ? yours(me)
                  : me,
          )
          .then(set),
      addPasskey: (me) => showAddPasskey(document.body, me),
      sailor: (me: Me) =>
        sailLink !== ''
          ? aboard(me).then(set)
          : linked !== null
            ? watchLinked(me)
            : yours(me).then(set),
      backSoon: notice,
    }).then(own),
  ]);
  const watchFirst = me.watch ?? '';
  // Sailing, the link to watch is done with: a reload sails. Watching the
  // sailor it opened, it stays, so that a reload watches again.
  if (watchFirst === '') {
    forgetParams(SAILOR_PARAM, FLEET_PARAM);
  }
  const predictor = new Predictor(
    physics,
    catalog.boats.map((b) => b.physics),
    catalog.weather,
    catalog.world,
    catalog.encounters,
  );
  const worker = new Worker(new URL('../workers/net/worker.ts', import.meta.url), {
    type: 'module',
  });
  const online = new Online(worker, predictor, game);
  // The boat in view's kind, as each Welcome tells it: drawn as its own,
  // under the cover, as every change of boat is.
  online.onKind = (kind) => {
    predictor.kind = kind;
    void game.useKind(kind);
  };
  if (watchFirst !== '') {
    // The connection's first Hello asks to watch.
    online.watch(watchFirst);
  }
  const knock = me.knock;
  const sending = me.knockMachine;
  if (knock !== undefined && sending !== undefined) {
    // A machine sailor of the player's sent aboard: the knock once the
    // watch of it has begun.
    let sent = false;
    effect(() => {
      if (!sent && online.watching.value?.sailor === sending) {
        sent = true;
        online.knock(knock, sending);
      }
    });
  } else if (knock !== undefined) {
    // Asked to come aboard: the knock once the player's own boat is in.
    void whenArrived(online, 0).then(() => online.knock(knock));
  }
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
  online.onBump = (b) => game.bump(b, performance.now(), online.watching.value?.sailor ?? null);
  // A new boat near the harbour's mouth first looks past it at the harbour.
  online.onOpening = (east, north, mouthEast, mouthNorth) =>
    world.camera.open(east, north, mouthEast, mouthNorth);
  // The land: its chunks fetched and built off the page's thread, and
  // whether it is built about the boat drawn.
  const land = new Land(
    new Worker(new URL('../workers/mesh/worker.ts', import.meta.url), { type: 'module' }),
    catalog.world,
    catalog.weather.sea.breaking,
  );
  world.useLand(land);
  const landNear = () => land.ready(world.pose.east, world.pose.north, NEAR_LAND);
  game.bedFriction = (east, north) => land.frictionAt(east, north);
  world.freeCam.ground = (east, north) => land.heightAt(east, north);
  // The free camera is the owner's alone: the server hears it from no other;
  // and nothing on a boat watched is the player's to move.
  game.canFly = () => online.tools.value && !online.spectating.value;
  game.canSteer = () => !online.spectating.value;
  game.onRoam = (on, east, north, height) => online.roam(on, east, north, height);
  let worldId = '';
  const models = new Models();
  online.onWorld = (id, sailed) => {
    if (id !== worldId) {
      // Another world: its places, lights and islands' models are its own,
      // and its weather.
      world.lighthouses.clear();
      world.wrecks.clear();
      world.race.clear();
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
    world.race.setPlaces(p);
  };
  // A race under way: its course laid in the sea, its committee boat's
  // flags, and its gun.
  const racing = new Map<number, { boat: string | undefined; flags: number[] }>();
  online.onRaceTold = (t) => {
    if (t.gone) {
      racing.delete(t.race);
      world.race.drop(t.race);
      return;
    }
    const boat = catalog.boats[t.boat]?.id;
    const known = racing.get(t.race) ?? { boat, flags: raceFlags('warning', boat) };
    racing.set(t.race, known);
    world.race.lay(t.race, {
      committee: t.committee,
      pin: t.pin,
      marks: t.marks,
      flags: known.flags,
    });
  };
  online.onRaceSignal = (s) => {
    const r = racing.get(s.race);
    if (r !== undefined && s.signal !== 'finish' && s.signal !== 'other') {
      r.flags = raceFlags(s.signal, r.boat);
      world.race.signals(s.race, r.flags);
    }
    if (s.gun) {
      game.fireGun(
        s.race,
        s.signal === 'start' || (s.signal === 'finish' && s.place === 1) ? 1.6 : 1,
        true,
      );
    }
  };
  online.onLights = (l, drop) => world.lighthouses.setLights(l, drop);
  online.onLife = (l, drop) => world.life.set(l, drop);
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
  const gales = steerByChart(game, world, parts, forecasting);
  online.onForecast = (f, past) => {
    forecasting.forecasts.receive(f, past);
    gales.issued(f);
    // The storm cone hangs while a warning is in force.
    world.galeUp = f.gale === null ? null : pointUp(f.gale.from);
  };
  parts.chart.store.me = me.name;
  parts.notices.off.value = new Set(me.noticesOff ?? []);
  parts.notices.save = (off) => saveNoticesOff(off);
  // The sailors the player follows setting sail, told while the game is
  // open; asked after apart from the first download.
  void import('../ui/following').then(({ followSailing }) =>
    followSailing((who) => parts.notices.raise('followed-sailed', { who }, performance.now())),
  );
  online.onChart = (entries, whole, courses) => parts.chart.store.receive(entries, whole, courses);
  // Races ashore at sea: the board read once a minute, by the world clock;
  // Enter with my crew for a skipper with others aboard.
  const races: RacesView = racesOf({
    now: () => {
      const t = online.utcMs();
      return Number.isFinite(t) ? t : Date.now();
    },
    crew: () => online.aboard.value === null && online.crew.value !== null,
  });
  races.board.value = startRaces.board.value;
  pollRaces(races, parts.notices, catalog.notices.kinds);
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
  // A change of boat at sea: the cover down over the screen, the boat
  // asked for under it, and the cover up again once the new boat's world
  // is ready; at once if none comes (a watch refused, a queue). One at a
  // time: the cover takes the taps meanwhile.
  let atSea = false;
  let changing = false;
  const changeBoat = async (act: () => void): Promise<void> => {
    if (!atSea) {
      act();
      return;
    }
    if (changing) {
      return;
    }
    changing = true;
    const n = online.arrived.value;
    const ended = online.ended.value;
    clear.show();
    const start = performance.now();
    await cover.drop(world.underTest || reducedMotion() ? 0 : DROP);
    if (world.drawsWhenReady) {
      world.stage.loopDraws = false;
    }
    act();
    let placed = false;
    const arrived = () => online.arrived.value > n;
    const gate = new Gate(
      {
        epoch: () => true,
        boat: arrived,
        view: () => placed,
        land: () => landNear() && world.sailorReady,
        abandoned: () =>
          !arrived() &&
          (online.ended.value !== ended ||
            online.watchPlace.value !== null ||
            online.place.value !== null),
      },
      { start, draws: world.drawsWhenReady },
    );
    const ready = untilReady(gate, world, cover, start);
    // A boat that comes after the wait was given up is not this change's.
    let waiting = true;
    void whenArrived(online, n).then(async () => {
      if (!waiting) {
        return;
      }
      await frames(2);
      world.placeFirstView();
      placed = true;
    });
    await ready;
    waiting = false;
    reveal(world, cover, arrived() ? DESCENT_CHANGE : 0);
    changing = false;
  };
  // Watching, as the screens see it.
  const watchView: WatchView = {
    watching: online.watching,
    spectating: online.spectating,
    status: online.status,
    ended: online.ended,
    place: online.watchPlace,
    boatPlace: online.place,
    watchers: online.watchers,
    list: signal(false),
    watch: (sailor) => {
      // Another sailor watched: a reload no longer opens the link.
      forgetParams(SAILOR_PARAM, FLEET_PARAM);
      void changeBoat(() => online.watch(sailor));
    },
    sail: () => {
      // A reload from now on sails, not watches the sailor linked.
      forgetParams(SAILOR_PARAM, FLEET_PARAM);
      void changeBoat(() => online.sail());
    },
    unwatch: () => online.unwatch(),
    comeAboard: () => online.comeAboard(),
    sharing: signal(false),
    // A picture of the view shared with a link, on a page that draws.
    ...(world.stage.wanted !== 'none' ? { capture: () => world.stage.capture() } : {}),
    ...(linked?.kind === 'fleet' ? { fleet: linked.code } : {}),
  };
  // A boat watched: the camera stays where the player puts it. The boat in
  // view's sailor is drawn in its look, as the server tells it: a machine
  // sailor's sail carries its mark.
  effect(() => {
    world.camera.watching = online.spectating.value;
  });
  effect(() => {
    const look = online.look.value;
    if (look !== null) {
      void world.showLook(look);
    }
  });
  // Who is aboard the boat in view: whoever holds the controls at the helm,
  // the others at their stations.
  effect(() => {
    void world.showCrew(online.crew.value);
  });
  // And the boat in view in its own look, and its name.
  effect(() => {
    const b = online.boatLook.value;
    if (b !== null) {
      world.setBoatLook(b.look, b.name);
    }
  });
  // The screen comes back by itself when the player is needed.
  const neededNow = (): Needed => ({
    overboard: !online.spectating.value && overboard(game.hud.sailor.value),
    takeover: online.notice.value?.takeover === true,
    returned: online.returned.value,
    ended: online.ended.value,
    queued: online.watchPlace.value !== null || online.place.value !== null,
    knocks: online.knocks.value.length,
    handed: online.handed.value !== null,
  });
  let was = neededNow();
  effect(() => {
    const now = neededNow();
    if (needed(was, now)) {
      clear.show();
    }
    was = now;
  });
  connect(online);
  // "Back soon" while the first connection cannot be made, and the queue
  // while the sea is full; a watch refused, or the spectators' queue, with
  // the way to watch another or sail.
  const waiting = online.status.subscribe((status) => notice(status === 'waiting'));
  // Set sail asked for the voyage to be watched and the server could not
  // take it: the boat sails unwatched, and the player is told so at sea.
  if (watchRefused) {
    const told = online.status.subscribe((status) => {
      if (status === 'sailing') {
        told();
        online.say(NOT_WATCHED);
      }
    });
  }
  const queue = showQueue(document.body, online.place);
  const watchWaiting: { atSea: boolean; hide: (() => void) | null } = { atSea: false, hide: null };
  const waitingWatch = effect(() => {
    if (online.status.value === 'idle' || online.watchPlace.value !== null) {
      void loadWatch().then((m) => {
        if (!watchWaiting.atSea && watchWaiting.hide === null) {
          watchWaiting.hide = m.showWatchWaiting(document.body, watchView, () => openNews(null));
        }
      });
    }
  });
  // The world under the cover until it is ready: the sky at the world's
  // hour, the boat in its place and its first view, the land about it, and
  // the first frames drawn.
  let boatIn = false;
  let placed = false;
  const gate = new Gate(
    {
      epoch: () => world.skyTime !== null,
      boat: () => boatIn,
      view: () => placed,
      land: () => landNear() && world.sailorReady,
    },
    { start: tapped, draws: world.drawsWhenReady },
  );
  const ready = untilReady(gate, world, cover, tapped);
  await online.ready;
  waiting();
  queue();
  notice(false);
  watchWaiting.atSea = true;
  waitingWatch();
  watchWaiting.hide?.();

  game.setDriver(online.driver);
  online.onDriver = (d) => game.setDriver(d);
  game.pacer = online;
  boatIn = true;
  // The boat set down, then its first view.
  await frames(2);
  world.placeFirstView();
  placed = true;
  const baro = startBarometer(world, predictor.physics, forecasting);
  const clock = startClock(world);
  const statements = statementsOf();
  mountScreen(document.body, {
    model: game.hud,
    settings: game.settings,
    helm: game.helm,
    sheet: game.sheet,
    pilot: game,
    reef: game,
    labels: (el) => world.attachLabels(el),
    fullScreen: full,
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
    clock: clock.clock,
    harbour: {
      port: watchHarbour(world, parts.chart.store),
      src: forecasting,
      store: parts.chart.store,
      look: harbourLook(world, online),
      boats: harbourBoats(catalog, online),
      races,
    },
    watch: watchView,
    deck: deckOf(
      online,
      (act) => void changeBoat(act),
      shipmatesOf(online, {
        change: (act) => void changeBoat(act),
        hide: (name) => online.chat.tie(name, 'block', true),
      }),
    ),
    statements,
    lamp: online.lamp,
    camera,
    clear,
    races,
  });
  // A name tapped anywhere opens its log on the chart screen's Log tab, and
  // a sailor's last story the News tab, now the chart screen can be shown;
  // before, they open on their own over the screen.
  setLogHost((who) => parts.chart.showLog(who));
  setNewsHost((day) => parts.chart.showNews(day));
  game.listen(document, container);
  if (view !== undefined) {
    world.placeCamera(view);
  }
  let revealed: Revealed | null = null;
  if (dev) {
    const { openNetPanel } = await import('../dev/panel');
    openNetPanel(world, online, predictor, document.body);
  }
  if (query.has('test')) {
    const { exposeHooks } = await import('../dev/hooks');
    exposeHooks(world, game, {
      online,
      predictor,
      chart: parts,
      barometer: baro.barometer,
      clock: clock.clock,
      readClock: clock.read,
      fullScreen: full,
      revealed: () => revealed,
    });
  }
  const waited = await ready;
  revealed = {
    ...waited,
    epoch: world.skyTime !== null,
    arrived: online.arrived.value,
    view: placed,
  };
  atSea = true;
  reveal(world, cover, view === undefined ? DESCENT : 0);
  // A word from the game's owner about chat, if one waits unread.
  void checkStatements(statements);
}

/** Whether the sailor is out of the boat, or the boat over: the sailor's line says so, but for aground. */
function overboard(line: string): boolean {
  return line !== '' && line !== AGROUND;
}

/** Resolves once a boat has arrived after the n-th. */
function whenArrived(online: Online, n: number): Promise<void> {
  let stop = (): void => {};
  return new Promise<void>((resolve) => {
    stop = effect(() => {
      if (online.arrived.value > n) {
        resolve();
      }
    });
  }).finally(() => stop());
}

/**
 * The chart's weather joined to the boat: a system's box reads the boat's
 * speed over the ground and its Steer sets the autopilot to hold the
 * course, as the autopilot's panel does; and the gale warnings' notices,
 * raised for a gale forecast near the boat or across the course steered
 * for a system while the autopilot holds it, looked for again every few
 * seconds as the boat moves.
 */
function steerByChart(
  game: Game,
  world: SeaScene,
  parts: ChartParts,
  forecasting: Forecasting,
): GaleNotices {
  parts.sea.speed = () => game.driver?.out[RECORDS.out.speedOverGround] ?? 0;
  parts.sea.steer = (heading) => {
    const d = game.driver;
    if (d === null) {
      return;
    }
    game.controlsTouched();
    game.pilot.engage(PILOT_HEADING, heading, d.wind.meanFrom);
    game.hud.flush();
  };
  const gales = new GaleNotices(parts.chart.store, parts.notices, {
    fields: () => forecasting.fields(),
    made: () => forecasting.made(),
    tick: () => world.ticks,
    // The boat as last stepped, not as last drawn.
    boat: () => {
      const s = game.driver?.states.current;
      return s === undefined
        ? { east: world.pose.east, north: world.pose.north }
        : { east: s[RECORDS.state.x] ?? 0, north: s[RECORDS.state.y] ?? 0 };
    },
    course: () => {
      const c = parts.chart.steered.value;
      const p = game.pilot;
      return c !== null && p.mode === PILOT_HEADING && p.target === stepsOf(c.heading) ? c : null;
    },
  });
  setInterval(() => gales.check(), 5000);
  return gales;
}

/** The barometer and the words about its dial. */
interface BarometerParts {
  barometer: Barometer;
  words: readonly DialWord[];
  /** Reads it now, as its timer does each second. */
  read: () => void;
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
  const read = (): void => {
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
  };
  setInterval(read, 1000);
  return { barometer, words: b.words, read };
}

/**
 * The ship's clock, read twice a second from the hour the sky is drawn at,
 * at the centre of the disk: the developer's sky moves it too, so the
 * clock and the sun never disagree.
 */
function startClock(world: SeaScene): { clock: ShipsClock; read: () => void } {
  const clock = new ShipsClock(catalog.sky.day);
  const periods = skyPeriods(catalog.sky);
  const read = (): void => {
    const sky = world.skyTime;
    if (sky !== null) {
      clock.update(hourAt(sky.at(world.ticks), periods));
    }
  };
  read();
  setInterval(read, 500);
  return { clock, read };
}

/** The cover waits for the chunks handed within this of the boat, m; gate.ts says how long. */
const NEAR_LAND = 300;

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
    } else if (status === 'removed') {
      // The sailor was deleted, here or on another device: its notice
      // shows a moment, then the start screen.
      setTimeout(() => location.reload(), 4000);
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

/** The flags a race's committee boat flies after a signal: the class's pennant from the warning, P too from the preparatory, none from the start, X for a recall. */
function raceFlags(
  signal: 'warning' | 'preparatory' | 'start' | 'recall',
  boat: string | undefined,
): number[] {
  const flags = catalog.world.committee.flags;
  const shown =
    signal === 'warning'
      ? [signalFlag(flags, 'class', boat)]
      : signal === 'preparatory'
        ? [signalFlag(flags, 'class', boat), signalFlag(flags, 'preparatory')]
        : signal === 'recall'
          ? [signalFlag(flags, 'recall')]
          : [];
  return shown.filter((f) => f >= 0);
}
