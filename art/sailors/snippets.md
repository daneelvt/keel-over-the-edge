# Blender 5.2 by script: what works

Read before writing new build code. Blender's Python API changes between
versions, and most scripts that fail, fail on that: each idiom here was
run headless (`blender -b`) on 5.2.0 LTS with MPFB 2.0.18.

## Running

- The build runs in its own profile, `BLENDER_USER_RESOURCES=.dev/blender`,
  without `--factory-startup`: factory settings leave MPFB out.
- MPFB is installed into it with
  `blender -b --command extension install-file -r user_default -e <zip>`.
- `--python-exit-code 1` makes a raised exception fail the process.
- An extension's modules are imported as `bl_ext.user_default.mpfb...`;
  find them by the end of their names (`mpfbx.module`). MPFB's services
  work headless; its `bpy.ops.mpfb.*` operators need a window.
- Empty the scene by removing objects and orphaned data; reading the
  factory settings would drop MPFB.

## MPFB

- `HumanService.create_human(macro_detail_dict=..., feet_on_ground=False)`
  takes the races as `{"race": {...}}`; macros below `age` 0.5 blend in a
  child's proportions.
- Targets: resolve names to files yourself, exactly
  (`TargetService.target_full_path` falls back to a prefix match:
  "l-eye-bag-in" would find "l-eye-bag-incr"); "lr-" is both sides.
  `load_target`, then `bake_targets`: no shape key may reach the export.
- Rigs: `Rig.from_json_file_and_basemesh(path, body)` then
  `create_armature_and_fit_to_basemesh(add_modifier=False)`; a rig file
  may be a plain dict of bones, so a rig of our own (game_engine plus
  bones of the default rig) is one JSON file. `RigService.apply_weights`
  takes `{"weights": {bone: [[vertex, weight], ...]}}`; MPFB's weights
  are not normalised, and some vertices have more than four.
- MPFB sets pose bones to Euler XYZ: set them to quaternions, or keys in
  quaternions are ignored.
- Matching a mesh to the body (`ClothesService.create_mhclo_from_clothes_matching`)
  needs every vertex in a vertex group the body has of the same name
  ("body" for a proxy, "helper-tights" or "helper-skirt" for clothes); it
  is slow (tens of seconds), so its result is made once and kept.
- `HumanService.add_mhclo_asset` fits and weights a .mhclo or .proxy. With
  a proxy among the body's relatives it copies a garment's delete group
  onto the proxy by looking the proxy's file up among MPFB's own assets,
  and fails when it is not there: set the proxy's `object_type` aside
  while fitting.
- `Mhclo.write_mhclo` writes the license and author it is given; its
  default license is CC0. Its numbers keep four decimals: a fit is within
  a millimetre or two of where it was made.

## Meshes

- `obj.modifiers` hands out a new Python object each time: compare
  modifiers by name, never by `is`.
- Apply a modifier without an operator: the others' `show_viewport` off,
  `bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph),
  preserve_all_data_layers=True, depsgraph=depsgraph)`, then swap the
  mesh in. Vertex group weights and UVs survive a collapse.
- The Decimate modifier's vertex group with `invert_vertex_group=True`
  keeps vertices of weight 1 and spends its collapse on weight 0.
- Never edit a vertex's groups while walking `v.groups`: collect, then
  change.
- `foreach_get`/`foreach_set` into numpy for anything over all vertices
  or loops; loops are in polygon order (`loop_start`, `loop_total`).
- Horizontal sections of a mesh: the edges a plane crosses, joined into
  outlines by the faces they share (two crossings in one face are on one
  outline). Joining by distance breaks where edges are long.

## Posing

- Pose by the armature's axes: rotate `pose_bone.matrix` about the bone's
  posed head, root first, `view_layer.update()` between bones. A local
  Euler pose gives a pose not meant.
- MPFB's rest pose is an A-pose with the forearms already bent about 40°.
- Setting `pose_bone.matrix` (armature space) solves its `matrix_basis`;
  read `rotation_quaternion` after a `view_layer.update()`.
- Every `view_layer.update()` evaluates every mesh an armature deforms,
  hidden from render or not, MPFB's 13,000-vertex base mesh among them:
  set `hide_viewport` on them while baking or reading clips (ten times
  faster).
- mathutils keeps quaternions and matrices in single precision, and
  `Quaternion.angle`, `rotation_difference(...).angle` and
  `to_axis_angle()` go through acos: turns under about 0.04° read as 0.
  Take angles and logs in double precision by atan2 (`motion.angle`,
  `motion.log`); jerk measured on acos'd turns spikes at 90 m/s³.
- The game's dinghy (`art/boats/*.glb`, meshopt-packed) imports with
  `import_scene.gltf`: x to starboard, y forward, z up.

## Actions and clips

- An action keys through a slot and a channelbag:
  `slot = action.slots.new(id_type="OBJECT", name=...)`,
  `anim_utils.action_ensure_channelbag_for_slot(action, slot)`, then
  `bag.fcurves.new('pose.bones["head"].rotation_quaternion', index=i,
  group_name="head")` and `keyframe_points.add(n)` with `foreach_set("co",
  ...)` (and `"interpolation"`, 1 for linear). Play it by setting the
  object's `animation_data.action` and `action_slot`.
- `export_scene.gltf(use_selection=True, export_animation_mode="ACTIONS")`
  of an armature alone writes the skeleton (a skin with no mesh) and every
  action in the file with a slot for it: remove the others first.
- Set `scene.render.fps` before importing a clip; the importer keys at it.
  `bone_heuristic="TEMPERANCE"` points imported bones at their children,
  but take directions joint to joint, not from imported bone axes.

## Meshes as cut

- `bmesh.ops.bisect_plane` and `smooth_vert` keep a mirrored mesh mirrored;
  pushing vertices to their nearest point on the body does not (between
  the legs either leg may be nearest): pair the vertices with their
  mirrors once, after the cut, and copy one side to the other after each
  step that moves them (`garment.Mirror`).
- MPFB's fit of a `.mhclo` is within a millimetre of the cut, unevenly, and
  can carry a middle vertex 3 mm off the middle: mirror the fitted mesh
  again.

## UVs and baking

- `bpy.ops.uv.average_islands_scale` and `bpy.ops.uv.pack_islands`
  (`shape_method="CONCAVE"`) run headless in edit mode with
  `tool_settings.use_uv_select_sync = True` and everything selected.
- A bake writes through each material's active image node and the UV map
  its UV node names. Bake several objects into one image by selecting
  them all, each with that image active; `use_clear=True` clears it once.
- Hide from rendering whatever is not baked (MPFB's base mesh under the
  proxy, helpers): hidden geometry still darkens ambient occlusion.
- Set `scene.cycles.seed`: the same build bakes the same pixels.
- Materials have node trees from creation; `use_nodes` is deprecated.
- A collapse folds UVs at small sharp parts (fingertips, toes, the nose):
  a face whose UVs wind against its island's is folded (`atlas.untangle`).

## Rendering the sheets

- `BLENDER_WORKBENCH` renders headless in about 15 ms a 512² frame (the
  first, 0.1 s); `render.render(write_still=True)`, then load the PNG to
  read its pixels. `film_transparent` for a background of one's own.
- `shading.color_type`: `TEXTURE` draws the material's active image node
  through its UV map node; `VERTEX` the mesh's active colour attribute
  (`color_attributes.active_color`); `MATERIAL` each slot's
  `diffuse_color`; `SINGLE` with `light = "FLAT"` and black, a silhouette.
- A wireframe for a render: a `WIREFRAME` modifier with `use_replace =
  False` and `material_offset = 1`, a dark second material slot.

## Hard surfaces (the machines)

- `bmesh.ops.convex_hull(bm, input=verts)` returns `geom_interior` and
  `geom_unused`: delete both, then the vertices left without faces, then
  `recalc_face_normals`. A hull of a symmetric point set comes out only
  roughly symmetric after a collapse or a bisect: cut it at x = 0
  (`bisect_plane(..., clear_outer=True)`), mirror the half with
  `duplicate` and `reverse_faces`, `remove_doubles` on the cut, then
  `dissolve_degenerate` (the cut leaves slivers of no area).
- `uv.pack_islands` with a margin of 24 px in 1024 cannot fit hundreds of
  islands: it packs them into tiles past the square (UVs up to 3 or 4)
  without saying so. Smart projection gave a machine 1,100 islands; give
  big plates one island each (unrolled round their bone) and small parts
  a swatch (atlas.part(swatch=True)).
- `pack_islands` packs the selected faces only (with UV sync selection):
  deselect what is placed by hand.
- `bmesh.ops.duplicate` returns `vert_map` and `face_map` (source to
  copy); per-face data of one's own follows the copy through them.

## Export

- `export_scene.gltf(use_selection=True, ...)` of an explicit selection,
  then read the file back and check its meshes, skin and materials.
- The exporter keeps a texture only if a socket uses it; extra images go
  in afterwards by editing the glTF (export.py adds the mask).
- gltfpack keeps node names (`-kn`), not mesh names: name meshes by their
  nodes. `-tc -tu A` makes colour textures ETC1S and data textures (the
  occlusion slot) UASTC.
