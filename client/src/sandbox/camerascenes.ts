// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox's camera scenes, ?sandbox&camera=…, on seed 1's world (the
// file go run ./tools/dev -world 1 writes): the boat set still in a calm
// beside the land, and the camera held at a view that puts it inside the
// land, so that what the camera's arm makes of it can be looked at, and
// swung round.
//
//   stack    west of the 24.5 m stack south-west of Port Royal, the camera
//            to the east, through it
//   cliff    under Port Royal's northern cliffs, 18 m high, heading west,
//            the camera to the south, into them
//   harbour  in the cove on Port Royal's western shore, the camera to the
//            south-west, among the houses on the slope above it
//   arch     under the middle of an arch's span, 6.4 m above the water,
//            3.5 km south-east of Port Royal, the camera up along the span,
//            into its rock
//
// The browser tests swing the camera round the same scenes.

export const CAMERA_SCENES = ['stack', 'cliff', 'harbour', 'arch'] as const;
export type CameraSceneName = (typeof CAMERA_SCENES)[number];

/** A scene: the boat's place and heading, m and radians clockwise from north; the view's bearing from the boat, radians, elevation and distance. */
export interface CameraScene {
  east: number;
  north: number;
  heading: number;
  bearing: number;
  elevation: number;
  distance: number;
}

export const CAMERA_SCENE: Record<CameraSceneName, CameraScene> = {
  stack: {
    east: -192,
    north: -132,
    heading: 0,
    bearing: Math.PI / 2,
    elevation: 0.15,
    distance: 20,
  },
  cliff: {
    east: -80,
    north: 332,
    heading: -Math.PI / 2,
    bearing: Math.PI,
    elevation: 0.2,
    distance: 24,
  },
  harbour: {
    east: -90,
    north: -44,
    heading: 0,
    bearing: (5 * Math.PI) / 4,
    elevation: 0.12,
    distance: 35,
  },
  arch: {
    east: 1001.1,
    north: -3350,
    heading: Math.PI / 2,
    bearing: 0,
    elevation: 0.5,
    distance: 12,
  },
};

/** Reads ?camera=stack|cliff|harbour|arch, or null. */
export function cameraSceneFromQuery(query: URLSearchParams): CameraSceneName | null {
  const c = query.get('camera');
  return (CAMERA_SCENES as readonly string[]).includes(c ?? '') ? (c as CameraSceneName) : null;
}

/** A scene's view: its azimuth from astern (toward the port quarter positive) for its bearing, its elevation and distance. */
export function cameraSceneView(s: CameraScene): {
  azimuth: number;
  elevation: number;
  distance: number;
} {
  // Astern is the heading turned half round.
  let a = (s.bearing - s.heading - Math.PI) % (2 * Math.PI);
  if (a > Math.PI) {
    a -= 2 * Math.PI;
  } else if (a <= -Math.PI) {
    a += 2 * Math.PI;
  }
  return { azimuth: a, elevation: s.elevation, distance: s.distance };
}

/** What a scene drives: the boat put down, the land had near it, the camera placed. */
export interface CameraSceneHost {
  place(east: number, north: number, heading: number): void;
  landNear(): boolean;
  placeCamera(v: { azimuth: number; elevation: number; distance: number }): void;
}

/**
 * Starts a scene: the boat put at its place, and once the land about it is
 * had, the camera at the scene's view, which becomes its resting one.
 */
export function startCameraScene(host: CameraSceneHost, name: CameraSceneName): void {
  const s = CAMERA_SCENE[name];
  host.place(s.east, s.north, s.heading);
  const wait = setInterval(() => {
    if (host.landNear()) {
      clearInterval(wait);
      host.placeCamera(cameraSceneView(s));
    }
  }, 250);
}
