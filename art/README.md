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

## Sound

`sound/*.json` are the recipes the client's sound engine plays: filter
bands, levels and curves for the wind, the rigging, the flogging sail and the
water on the hull. They are art like the models. Each names the art licence
in its first field, `licence`.
