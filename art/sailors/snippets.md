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

## Export

- `export_scene.gltf(use_selection=True, ...)` of an explicit selection,
  then read the file back and check its meshes, skin and materials.
- The exporter keeps a texture only if a socket uses it; extra images go
  in afterwards by editing the glTF (export.py adds the mask).
- gltfpack keeps node names (`-kn`), not mesh names: name meshes by their
  nodes. `-tc -tu A` makes colour textures ETC1S and data textures (the
  occlusion slot) UASTC.
