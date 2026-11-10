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
- `lib/fittings.ts`: what every boat carries alike: the tricolour lantern,
  the pennant, the mainsail's telltales, the foils' blades.
- `boats/jolly-boat/build.ts`: the Jolly boat.
- `boats/keelboat/build.ts`: the keelboat, carvel planked with a copper
  bottom, a fin keel and bulb, a cuddy, a sloop rig with its standing
  rigging; its helm laid out as the sailors' stage boat's (below).
- `boats/tall-ship/build.ts`: the tall ship, a ship-rigged collier with a
  quarterdeck, a forecastle and a stern gallery, three masts in sections
  with tops and crosstrees, square sails on yards, headsails, the mizzen
  on its gaff and boom, shrouds with ratlines and deadeyes, her wheel and
  her lanterns.
- `boats/skiff/build.ts`: the skiff, clinker planked on a trapeze skiff's
  lines with an open transom, racks of ash with a hemp net out to her beam,
  a fractional rig with swept spreaders, deadeyes and trapeze wires, a
  square-headed, fully battened main, a self-tacking jib on its horse, a
  gennaker on a bowsprit, a centreboard and a kick-up rudder.
- `town/lib/kit.ts` and `town/<biome>/build.ts`: each biome's kit of town
  buildings and props, `town/<biome>.glb`.
- `icon/icon.ts` and `icon/build.ts`: the game's icon, the boat on sky and
  sea, one drawing for the favicon, the cover and home screens, drawn as
  shapes and rasterised to the PNGs a phone asks for, written to
  `client/public/` beside the web app manifest. `client/build/icons.test.ts` fails if a PNG
  is not the drawing.

A model's nodes are named, and the client finds its parts by those names:
`hull`, `mast`, `boom` (its origin at the gooseneck), `sail` and `telltales`
(also at the gooseneck), `pennant` (at the masthead), `rudder` (at its stock)
with `tiller`, `daggerboard` (a fixed keel too, its bulb a child), and
`sailor`, an empty node where the sailor sits. A boat with headsails has
`jib`, at its tack, its luff up the forestay to its head, `rake` (its
`extras`) aft of the tack. A boat with a downwind sail has `kite`, built as
the jib is, at its tack on the bowsprit's end, which the game hides in its
bag and hoists from the tack. A boat with a trapeze has `trapeze`: its
wires and rings, and in its `extras` the `hounds`, the `rings` (starboard
first) and the starboard rack's outer edge at the helm (`rackEdge`), in the
model's frame. A fully battened main's `sail` names its battens' heights,
fractions of its luff, in its `extras`. A hull whose beam is over its
racks says so: its `extras.plan.over` names the materials it is measured
across. The boat's origin is at its centre of gravity's
station, on the centreline at the waterline; the bow points to -z and
starboard is +x. The sails, telltales and pennant carry their fractions (of
the chord and luff, along each ribbon) in their texture coordinates, and
the client shapes them on the GPU. Each level's triangles are within the
catalog's `art.budget`.

A square-rigged ship has more. Each mast's yards and their sails are a joint
at the mast's axis, `fore-yards`, `main-yards` and `mizzen-yards`, at the
courses' foot, square athwartships at rest, which the client turns about the
vertical to brace them. Each square sail is a flat grid in its yard's
upright plane, u from the port arm to the starboard and v from the head to
the foot, whose `extras` name its `square` group and strip (a topsail's
`split` is where its foot, of the lower strip, begins, and its `reefs` its
reef bands); the main topsail carries the number (`{"number": true}`). Her
`jib` node holds her headsails, each at its own tack with its `rake`, and
the `spritsail` under the bowsprit. The mizzen's `boom` has its `gaff` at
the throat. The `wheel` turns about its own z axis, fore and aft, its
`extras` its radius and spokes; the `sailor` stands behind it. The
`gallery` is the stern windows' panes, and her name goes on the transom
(`{"name": {"on": "transom"}}` on the hull). Her lanterns are the nodes
named as her lights.

## Sailors in Blender

The sailors are people, so they are made from a human body that deforms,
not from tubes: MPFB's human (CC0, in Blender), shaped, rigged, dressed and
packed by Python under `blender -b`, by script and nothing by hand:

```sh
go run ./tools/sailors              # or: cd client && npm run art:sailors
go run ./tools/sailors -look test   # one look
go run ./tools/sailors -setup       # check Blender, install MPFB and gltfpack
go run ./tools/sailors -add helm-wheel,habit-wheel   # only these clips, on every look
go run ./tools/sailors -add trapeze,trapeze-low      # and the harness with them
```

It needs Blender 5.2 LTS installed; the first run installs the pinned MPFB
into `.dev/blender` (a Blender profile of the build's own) and the pinned
gltfpack into `.dev`. CI does not run it: what it builds is committed.

- `looks/<look>.yaml`: a look in both versions, a woman and a man: each
  version's base and its own macros and targets, the garments, hair and
  hat with their parameters, the colours it is shown in, the clips made
  and judged on it. A look is built into `art/sailors/<look>/`;
  `committed: false` marks a check of the build's own (`test-kit`), built
  into `.dev/sailors`; `gates: report`, a check of the machinery whose
  failed gates are reported, not failing the build. The plain test sailor
  (`test`) is committed, for the dressing room (`client/sailors.html`,
  reached as `dev.html#sailors`), which draws every committed look in the
  game's renderer; the game itself loads none of them yet.
- `bases.yaml`: the two bodies every look varies, with the measurements
  every build asserts (height, heads, the widths' ratios).
- `tables.yaml`: the ease of each layer of clothing, the triangle budgets
  of each mesh and level, the atlas, the files' sizes, the boat the
  sailors are judged in, the motion lab's timing and its gate's
  thresholds, the joints' ranges, and the skeleton's joints in the files'
  order.
- `poses/`: the pose library. `test.yaml`, the poses every sailor is
  judged in (standing, seated at the helm, hiking, an arm raised, the
  capsize's three modes) and the far level's; `lab.yaml`, the motion lab's
  key poses and clips, and the clips retargeted from Quaternius'.
- `build/`: the build. `main.py` is what Blender runs; `sailor.py` makes a
  look; `mpfbx.py` calls MPFB and keeps the order (shape, rig, bones,
  proxy, garments, export, never refit); `body.py`, `landmarks.py`,
  `rig.py`, `lod.py`, `garment.py`, `hair.py`, `profiles.py` (hats),
  `atlas.py`, `export.py`; `inputs.py` refuses an input not in
  `SOURCES.md`; `stage.py` the game's dinghy as the sailors sit in it;
  `motion.py` the motion lab (key poses, the transition maker, two-bone
  IK, the bake, the clips' file); `retarget.py` Quaternius' clips onto the
  skeleton.
- `review/`: the judges. `metrics.py`, the gates every level of every
  version passes or the build fails; `motion.py`, the clips' gate;
  `review.py`, the review sheet and the clips' strips; `rubric.md`, the
  questions a sheet is judged by.
- `proxies/`, `garments/<look>/`: what the build makes once and keeps (the
  close body and each garment as MPFB's `.proxy` and `.mhclo`, with their
  `.obj`): matching them to the body takes tens of seconds, fitting them
  a fraction of one. Each names in its header what it was made from, and
  is made again when that changes.
- `SOURCES.md`: every input not the game's own, with its licence and
  SHA-256; `vendor/` the files among them. Only CC0.
- `snippets.md`: Blender 5.2's API as it was found to work.

A look's files are `<version>.glb` (close: the picker, the portraits and
the own boat near the camera), `<version>.deck.glb` (the boats near) and
`<version>.far.glb` (the fleet far off). Close and deck are skinned to one
skeleton of 85 bones, the same in every file and order (`rig.py`: MPFB's
game_engine bones in Unreal's names, a jaw, eyes and lids, a corrector at
each hip that turns half as far as the thigh, a twist bone in each
forearm, `pendant` at the breastbone, six two-bone `skirt_*` chains and
eight `spring_*` joints), four weights a vertex, no morph targets; the
far level is one rigid mesh, posed seated at the helm. Each mesh is named (`body` and
each garment's, hair's and hat's id). One material, `sailor`: its base
colour the atlas, the parts a sailor chooses the colour of stored as
neutral grey (0.5, linear) to be multiplied by twice the colour chosen;
its occlusion texture the mask, red the main colour's region, green the
skin's, blue the hair's, alpha metal (read as the mask, never as
occlusion). The figure faces +z, y up, its origin on the ground between
its feet, in metres. A look's clips are `<version>.clips.glb`: the
skeleton alone and one animation a clip, rotations only but the pelvis's
translation, at 30 frames a second. Where a pose seats the figure in the
dinghy is in the files as an empty named node, its matrix from the
figure's own space to the boat model's (`art/boats/jolly-boat.glb`): the
far level's `place`, for the pose it is made in, and in the clips' file
`place-<clip>` for each clip, the identity for one not placed in the boat.
The game puts the figure under the boat's model with it, so it sits where
the gates judged it. Another boat lays out its helm as that dinghy does
about the seat (the side deck as wide, the cockpit's floor as deep below
the gunwale, the tiller's hinge as far from the seat), and its `sailor`
node's `extras.restage` is how far its seat is from the dinghy's; the game
moves the clips by it (a tack's cross widened to its beam), and a boat
without a hiking strap is hiked only to the rail.

A boat steered by a wheel has a node `wheel` with `extras.wheel` (its
radius and spokes; the node's origin the hub, its axle fore and aft, a
spoke straight up at rest) and its `sailor` node where the helmsman stands,
on the deck between the feet, facing forward. Its clips (`helm-wheel`,
and `-port` for the wind over the port side; `habit-wheel`, each look's
habit at the wheel) are made at the stage's wheel (`tables.yaml`'s
`stage.wheel`: the hub 0.55 m ahead of that place and 1.05 m above the
deck, 0.75 m to the rim, 8 spokes), placed from the helmsman's place
(`place-helm-wheel` is from the figure's space to the `sailor` node's),
and written to a file of their own, `<version>.wheel.glb`, which only a
boat steered by a wheel loads. The game keeps the hands on the spokes as
the wheel turns with the rudder. `-add` makes only the clips named (as the
game asks for them) on each committed look and writes their file, adding
them to it if it has others, those kept byte for byte; nothing else is
written, and garments it must make again go into `.dev`.

A boat sailed from the trapeze has a node `trapeze` whose extras give the
hounds, each side's ring (starboard first) and `rackEdge`, the starboard
rack's edge at the helm's station, in the model's frame; each side's wire
is a node of its own under it (`trapeze-starboard`, `trapeze-port`). Its
clips (`trapeze`, fully out on the wire, lying back nearly flat with the
legs straight; `trapeze-low`, crouched on the rack's edge half way out;
each with its `-port`) are made against that boat's own model, imported
into the stage's scene (`tables.yaml`'s `stage.trapeze`): a pose's `lie`
leans the placed figure back about its feet, and the skirts' chains hang
from the body as it lies (a clip's `hang`). They are placed from the
rack's edge on their side and written to `<version>.trapeze.glb`; the
harness the wire hooks to (`build/gear.py`'s harness: a leather belt under
a coat or an apron, a bronze hook out before it) to
`<version>.harness.glb`, skinned to the skeleton in its own two materials,
its node `place-hook` the hook's eye at rest. Only a boat with a trapeze
loads either.

Every build is judged before anyone looks at it: the gates
(`review/metrics.py`: budgets, clean meshes and weights, nothing through
the clothes in any judged pose, nothing through the boat seated, the
figure kept under its clothes, symmetry, the atlas, the files) and the
clips' gate (`review/motion.py`: jerk, speed, reach, contacts, ranges,
loops, onsets) write `metrics.json` in the run (`.dev/sailors/runs/<look>/<n>`),
with what moved since the last run, and fail the build on any; the sheet
(`sheet.png` a version, `compare.png` beside the last run's) and each
clip's strips (`clip-<clip>.png`) are drawn there whatever the gates say.

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

## Life in the water

`life/build.ts` (with `life/lib/`) builds the bodies of the sea's swimmers
from their real proportions into `life/swimmers.glb`, the catalog's
`life.art.model`: eleven meshes, each a node of its name, `dolphin` (built
2.2 m long), `turtle` (1.0 m), `flyingfish` (0.3 m, its wings spread),
`tarpon` (1.5 m), `humpback` (14 m), `sperm` (12 m), `pilot` (4.5 m),
`ray` (1.1 m, its disc 2 m across), `shark` (2.7 m), `booby` (0.75 m,
standing) and `booby-asleep` (0.56 m, roosting, at the standing bird's
scale), whose `extras` give its `length` and how its spine bends; the page
scales each to a kind's own length and paints it in the kind's colours.
They are laid out as the boats are, their origin halfway along their length
on the spine (the boobies' on the deck under them, their feet at y = 0),
and faceted, each face its own vertices; none is over 320 triangles, as
every body is drawn padded to the largest. Their vertices' colour is the back's
share (r: 1 the back's colour, 0 the belly's), a dark mark (g: an eye, a
mouth, a fin's edge, a seam) and whether the part is a paddle that strokes
on its own (b: flippers, the flying fish's wings, the ray's wings, the
shark's pectorals); their first texture
coordinate is the share along the body, snout tip to tail tip, by z (u),
and a paddle's share out from its root to its tip (v). The script fails if
a body is not as long as it was built or is over its triangles' budget;
`client/build/swimmers.test.ts` checks the committed file.

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
