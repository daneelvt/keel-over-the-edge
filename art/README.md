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
- `boats/beach-cat/build.ts`: the beach cat, two narrow rockered hulls in
  carvel planking with laid decks, ash beams lashed to oak pylons and a net
  of tarred hemp between them, a spruce mast of teardrop section on a
  bronze ball, shrouds on deadeyes and a bridled forestay, two trapeze
  wires a side, a fully battened square-headed main and a jib, the hulls'
  keels, and two kick-up rudders whose arms the crossbar joins. Its hull's
  volume is one hull's, measured about its own centreline, and its offset.
- `boats/yacht/build.ts`: the yacht, carvel planked on a cruising sloop's
  lines with a plumb bow and a broad stern, a copper bottom and round bronze
  portlights; a laid deck and a varnished coachroof with windows of small
  panes in lead cames, wooden dead-lights and glazed scuttles; an
  oiled-canvas tilt on ash laths; a cockpit open to a hinged stern door,
  with teak benches, a table and two spoked wheels before wooden binnacles;
  small timber capstans; iron stanchions, pulpit and pushpit and two hemp
  lifelines; a fractional rig with two pairs of spreaders on oak
  cross-trees, shrouds on deadeyes, a main in its lazy bag and a genoa on a
  roller of pine; a fin keel with a lead bulb, two rudders either side of
  her centreline, an ash bumkin with an iron anchor; brass sidelights on
  her pulpit and a sternlight at her transom. Its hull's `lever` data are
  her sections and appendages, which `tools/lever` heels for her righting
  lever. Its `wheel` node says how far out its two wheels are (`spread`),
  each a child of its own, `wheel-port` and `wheel-starboard`; and it
  names the places its people's ways read: `coachroof`, `table`, `bridle`,
  `bench` and `lifelines`.
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
model's frame. A boat whose crew sit on her rail with their legs over the
side has `rail`, an empty node at the starboard deck's edge where they
sit (on the sheer at the outline's half-beam; the port side's is its
mirror). A fully battened main's `sail` names its battens' heights,
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
go run ./tools/sailors -add rail,rail-out,crouch-enter,crouch-walk,crouch-exit
go run ./tools/sailors -add cat-helm,cat-hike,hull,hull-wire,cat-trapeze,cat-trapeze-low,cat-righting,net-crouch-enter,net-crouch-left,net-crouch-right,net-crouch-exit,net-crawl-left,net-crawl-right
go run ./tools/sailors -add yacht-wheel,yacht-wheel-seated,yacht-habit-wheel,bench,bench-shift,bench-nod,bench-talk,bench-braced,yacht-rail,yacht-rail-out,cockpit-crouch-walk,roof-crouch-walk
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
the wheel turns with the rudder. A boat of two wheels says how far out
each is (`extras.wheel.spread`), its hubs `ahead` of and `up` from the
`sailor` node, which stands between them; each wheel is a child of the
`wheel` node, `wheel-port` and `wheel-starboard`, turned alike, and the
helmsman stands aft of the windward one, the clips' hands brought in to
its smaller rim. `-add` makes only the clips named (as the
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

A keelboat's crew sit on her rail, and move about her deck at a crouch.
Their clips on the rail (`rail`, sat on the deck's edge facing outboard,
the legs over the side and the hands on the thighs, upright; `rail-out`,
the same leaning out over the water from the hips; each with its `-port`)
are made against her own model, imported into the stage's scene
(`tables.yaml`'s `stage.rail`): her `rail` node is the deck's edge they sit
on, the knees' joints `knee` out from it, the cloth under them laid on her
deck inboard of the edge and hanging free outboard of it: a coat's back
hangs down behind and its front, beyond the knees, down the topsides (a
clip's `hang`, which may name one bone of a chain, `front_02`). They are placed
from the deck's edge on their side. The crouch's (`crouch-enter`,
`crouch-walk`, `crouch-exit`) are Quaternius' (`Crouch_Enter`,
`Crouch_Fwd_Loop`, `Crouch_Exit`), retargeted and set on a flat deck (a
retarget's `deck`): the soles on it, each foot held there by IK while it
bears, the walk's moving back at its `speed` (0.7 m/s at the clip's own
rate) so a figure moved forward at that speed keeps its feet still; the
back bent as far as keeps the head's joint under `head` (0.7 m) over the
deck while crouched, and the elbows as far as keeps the fingers off it;
the coat's chains hanging from the body as it bends. They are not placed.
All seven are written to `<version>.rail.glb`, which only a boat with
someone at a station on her rail loads.

The tall ship's company stand, sit, walk, haul and lie out aboard her.
Her model's `company` node gives, on her starboard side, in her frame (the
yard's in its node's), the places their clips are made against: her
quarterdeck's rail (the cap's inner edge, on its top), the fore hatch's
forward edge on its grating, the quarterdeck's ladder, the main shrouds,
their ratlines, futtock and topmast shrouds, the main top, the main topsail
yard's node with its footrope, and the main brace's lead and a point along
its fall. The sailors' stage imports her far forward of the rest
(`tables.yaml`'s `stage.ship`, `build/stage.py`'s `Ship`); her hull, her
mainmast's spars and top and her main yards are solid to the gates, her
ropes too but to what holds them (the hands, the feet; on the yard, the
hands hold it). Their clips are in two files. `<version>.ship.glb`, about her
decks: Quaternius' `Idle_LookAround_Loop` (`look-about`, the hand the source
raises to the brow kept down: a hat's brim is in its way),
`Idle_FoldArms_Loop` (`fold-arms`), `Idle_Talking_Loop` (`talking`) and
`Walk_Loop` (`walk`, a foot bearing on the deck moving back at 0.9 m/s), set
on a flat deck and not placed; `Idle_Rail_Loop` (`leaning`), leaning on her
rail facing outboard with the forearms laid on the cap rail's top at her
rail's height over her deck (the back bent as far as brings the shoulders
within reach of it, and the body kept off the bulwark under it), placed
from the rail's point; and `Sitting_Idle_Loop`,
`Sitting_Idle02_Loop`, `Sitting_Nodding_Loop` and `Sitting_Talking_Loop`
(`hatch-sit`, `hatch-shift`, `hatch-nod`, `hatch-talk`), sat on the hatch's
forward edge facing forward, the buttocks on its grating and the cloth laid
on it, placed from the edge. `<version>.aloft.glb`, her work and aloft, each
with its `-port`: `haul`, hauling the main brace's fall hand over hand facing
its lead, the hands brought along the fall toward it to 76% and 73% of the arm
from the shoulder, the forward hand the further (placed from the
fall's point 1.6 m from its lead, 0.1 m over it); `aloft`, standing in the
main top as far out as leaves a hand 77% of the arm from a topmast shroud
(placed from the top's floor at her centreline); and `yard`, lying over the
main topsail yard, the hips over it as high as the legs reach down to the
footrope a fifth of the way out along its run, the belly on it and the
hands on its fore side (placed from the yard's axis over that point, in its
node's frame). A clip with no `-port` is put on her port side by its place
seen in the mirror. The machines have neither `fold-arms`, `hatch-talk`,
`leaning` nor `haul`: their hands would meet their plates, their long coats
the deck and the rail. The Bosun leans with her forearms a little further
over the rail, for her loose sleeves (`bosun-leaning`, named `leaning`).

A beach cat's people sit on her windward hull, sit out from it, lie out
on the wire from it, cross her net and right her. Her model's `aboard`
node gives, on her starboard side, in her frame: at the helm's and the
crew's stations the hull's deck at its inner and outer edges, the side
bar's top and the hiking strap's underside; the net (its height where it
is laced, its fore and aft edges, its sag); the boom's underside at its
lowest; and the righting line lying on the net. The sailors' stage imports
her forward of the rest (`tables.yaml`'s `stage.cat`, `build/stage.py`'s
`Cat`), and a copy of her lying on her side beside her; her hulls, decks,
beams, side bars and fittings are solid to the gates, her net as the plane
it is laced at, and her straps and ropes too but to the hands and feet
(a new gate, "clear of the cat"); sat on her, the cloth is laid on her
decks and net. Her clips are `<version>.cat.glb`, which only a kind whose
catalog art names `cat` in `sailorClips` loads: `cat-helm` (sat on the
hull's deck by its inner edge, the legs across the net and the feet under
the strap, the aft hand on the extension and the other on the mainsheet)
and `hull` (the crew so at the crew's station, a hand on the jib sheet,
the other on the knee), placed from the deck's inner edge at their
station; `cat-hike` (sitting out on the outer edge), `cat-trapeze` and
`cat-trapeze-low` (the skiff's two on the wire, the crouch standing 15 mm
higher, the man's heel being through her rounder edge) and `hull-wire`
(the crew on the wire, a hand on the jib sheet, the other on the trapeze's
handle), placed from the deck's outer edge; each with its `-port`.
`cat-righting` is the tall ship's `haul` set on her lower hull as she lies
on her side, leaning further back, each hand brought from its shoulder
toward where the righting line leaves her upper hull, placed from where
the feet stand. The crossings of her net facing forward are Quaternius'
(`Crouch_Enter`, `Crouch_Left_Loop`, `Crouch_Right_Loop`, `Crouch_Exit`:
`net-crouch-enter`, `-left`, `-right`, `-exit`; `Crawl_Left_Loop`,
`Crawl_Right_Loop`: `net-crawl-left`, `-right`), set on the net (a
retarget's `stage: cat-net`) and placed from its middle on her centreline,
the loops stepping to their side (a retarget's `way`, at its `speed`).
Crawling (`crawl`), the hands and knees are held on the net while they
bear as the feet are, the back's arch shared along it, the forearms' turn
kept within their range and the palms flat where the wrists allow; the
crawl plays slower than the library's (its `seconds`) and smoothed more
(its `smooth`), easing its hitches. On the net a knee is as thick as the
figure's dressed one, a deep stride's knee lifts the body rather than
meet the net, a bearing foot bent past its range raises its heel, and the
whole stands as high as keeps its lowest vertex (but the cloth laid on the
net) on it. The Chartmaker crawls to the left with
the hands nearer the body (a retarget's `pull`, `chartmaker-net-crawl-left`
named `net-crawl-left`), clear of the man's hat's brim. There is no clip
going down onto the hands and knees or up off them: the library's
`Crawl_Enter` and `Crawl_Exit` did not pass the gates.

A cruising yacht's people stand and sit at her windward wheel, sit on her
cockpit's windward bench and on her windward rail under her lifelines, and
cross her cockpit and her coachroof at a crouch. The sailors' stage imports
her to starboard of the rest (`tables.yaml`'s `stage.cruiser`,
`build/stage.py`'s `Yacht`) and reads her places from her model's nodes, on
her starboard side: the stance aft of her starboard wheel (the `sailor` node
moved out by the `wheel` node's `spread`), its hub and rim; the side deck's
inner edge outboard of the wheel, and the deck forward of it by her capstan;
the `bench` node's front edge, top and sole; the deck's edge at the `rail`
node, and her two lifelines there between their stanchions (the
`lifelines` node); the sole on her centreline aft of her table (the `table`
node) and her coachroof's top on her centreline aft of its fore end (the
`coachroof` node). Her hull, decks, benches, coachroof, sprayhood, table,
binnacles, capstans, stanchions, pulpit, pushpit, mast and boom are solid
to the gates, her ropes (the lifelines above all, her rigging, her sheets)
too but to what holds them (the hands; on her rail, the forearms laid over
the upper lifeline), and her wheels' wood but to the hands that hold it (a
gate, "clear of the yacht"); sat on her, the cloth is laid on her decks and
bench, and is through her if it is under her decks, benches, coachroof or
table. Her clips are `<version>.cruiser.glb`, which only a kind whose
catalog art names `cruiser` in `sailorClips` loads (the catalog's check
refuses code quoting a kind's id, so the file is not named after the
kind):

- `yacht-wheel`, the wheel's `helm-wheel` made at her wheel (a clip's
  `restage`), its hands on her rim 45° either side of its top, and
  `yacht-habit-wheel`, each look's habit at the wheel made so (a clip made
  `of` another); `yacht-wheel-seated`, sat on the side deck outboard of the
  wheel facing forward, the legs along the deck and the outboard foot
  braced against the capstan forward, leaning forward, the inboard hand on
  the rim's outboard side, the other on its thigh: placed from the stance;
- `bench`, `bench-shift`, `bench-nod` and `bench-talk`, Quaternius'
  `Sitting_*` sat on the bench facing inboard (a retarget's `stage:
  yacht-bench`, the bench's edge `bench.knee` from the knees), and
  `bench-braced`, leaning back against the bench's back, the forward foot
  braced further out on the sole: placed from the bench's front edge;
- `yacht-rail` and `yacht-rail-out`, sat on the deck's edge facing
  outboard, the legs over the side under the lower lifeline, the forearms
  laid over the upper, sitting up and leaning on it: placed from the deck's
  edge;
- `cockpit-crouch-walk` and `roof-crouch-walk`, Quaternius'
  `Crouch_Fwd_Loop` facing across her (to port) at a crouch, set on her sole
  aft of the table (forward of it, by the coachroof's after face, there is
  no room fore and aft for a crouch) and on her coachroof's top forward of
  the mast (aft of it her boom is lower over the roof than a crouching
  figure's hat), placed from where each is crossed on her centreline.

Those at the wheel, braced on the bench and on the rail have their
`-port`; the bench's idles and the crossings are turned onto the port side,
as a seat facing inboard is. The machines have no `bench-talk`.

Every build is judged before anyone looks at it: the gates
(`review/metrics.py`: budgets, clean meshes and weights, nothing through
the clothes in any judged pose, nothing through the boat seated, the
figure kept under its clothes, symmetry, the atlas, the files) and the
clips' gate (`review/motion.py`: jerk, speed, reach, contacts, feet on a deck, ranges,
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
