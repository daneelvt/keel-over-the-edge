# Art

Everything in this folder is art: the game's models, and the scripts that
build them. **All rights reserved.** None of it is covered by the AGPL that
covers the rest of this repository (see the repository's README, "Name, art
and other content"). A fork may use the code, but must make its own art.

Each source file here starts with
`SPDX-License-Identifier: LicenseRef-All-Rights-Reserved`; `tools/licences`
checks that it does.

## Boats as code

A boat's model is a script that builds its geometry from the catalog's
numbers, so what is drawn is what the physics simulates, and a change of
dimension is a rebuild:

```sh
cd client && npm run art
```

runs every `art/boats/*/build.ts` with Node, which writes the glTF and
compresses it with `gltfpack` (meshopt) into `art/boats/<name>.glb`. The
built files are committed; the catalog's `art.model` names them, and
`go run ./tools/catalog -check` fails if one is missing.

- `lib/gltf.ts`: writes a glTF binary from nodes, meshes and materials.
- `lib/mesh.ts`: a mesh builder: vertices, faces, normals, tubes and boxes.
- `boats/jolly-boat/build.ts`: the Jolly boat.
- `sailors/stand-in/build.ts`: the stand-in sailor, a plain figure.
- `town/lib/kit.ts` and `town/<biome>/build.ts`: each biome's kit of town
  buildings and props, `town/<biome>.glb`.

A model's nodes are named, and the client finds its parts by those names:
`hull`, `mast`, `boom` (its origin at the gooseneck), `sail` and `telltales`
(also at the gooseneck), `pennant` (at the masthead), `rudder` (at its stock)
with `tiller`, `daggerboard`, and `sailor`, an empty node where the sailor
sits. The boat's origin is at its centre of gravity's station, on the
centreline at the waterline; the bow points to -z and starboard is +x. The
sail, telltales and pennant carry their fractions (of the chord and luff,
along each ribbon) in their texture coordinates, and the client shapes them
on the GPU.

A sailor's nodes are `body`, `head`, `arm-left` and `arm-right`; its origin
is at the hips, where it sits, facing +x.

## Towns

A biome's kit holds a node for each kind of building the catalog lists,
named by the kind's id, its extras the frontage, depth and storeys it was
built at; its front faces −z and its origin is the middle of its footprint
on its plot. A model is built at its kind's most storeys. Each vertex's
second texture coordinate is its part (walls, timber, roof, shutters and
doors, glass, stone, wood, cloth, iron) and its role (fixed; a storey's
own, its windows and bands; or above the walls); its first's x a window's
number. Its colour is the part's own, or for the parts the palette colours,
a shade. Everything is real size: a storey is 3 m.

## Sound

`sound/*.json` are the recipes the client's sound engine plays: filter
bands, levels and curves for the wind, the rigging, the flogging sail, the
water on the hull and the sea about the boat. They are art like the models. Each names the art licence
in its first field, `licence`.

The lighthouses' fog signals are played from the recipe named for their
device (`twotone`, `diaphone`, `siren`, `reedhorn`), and thunder from
`thunder.json`; `go run ./tools/catalog -check` fails on a fog signal's
device without its recipe.

## Clouds

`clouds/*.json` are the recipes of the heaped clouds' puffs, one a form
(`cumulus`, `cumulonimbus`, `storm`): layers of puffs, each a count, a
shape (a box, a disc, an arc or a spiral), ranges of place, height, radius
and tone as shares of the cloud's size and height, how flat and stretched
its puffs are, and the cloud strength over which the layer grows. The
client's sky lays every cloud out by them from its system's seed, so every
phone draws the same cloud; `go run ./tools/catalog -check` fails on a
heaped form without its recipe. They are art like the sound's recipes:
tuning one changes nothing the server keeps. Each names the art licence in
its first field, `licence`.
