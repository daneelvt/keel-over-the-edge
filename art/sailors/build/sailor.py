# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""One look, built: each of its versions from body to export, judged at
each level by the gates (review/metrics.py), drawn on the review sheet
(review/review.py), and its clips made in the motion lab and judged
(build/motion.py, review/motion.py). The run is kept whole, and the build
fails on any gate after everything is written."""

import json
import os
import time

import bpy
import numpy as np
from mathutils import Matrix, Vector

import atlas
import body
import export
import face
import garment
import gear as gears
import hair
import inputs
import landmarks
import lod
import machine as machines
import metrics
import motion
import mpfbx
import profiles
import retarget
import review
import rig
import scarf
import stage as stages
import trims

# The poses every sailor is judged in, and those seated in the boat.
POSES = ("standing", "seated", "hiking", "arm-raised", "in-water", "on-board", "climbing")
SEATED = ("seated", "hiking")

VERSIONS = ("female", "male")


def build_look(job):
    look = job["look"]
    inputs.load(job)
    runs = job["work"]
    os.makedirs(runs, exist_ok=True)
    n = 1 + max([int(d) for d in os.listdir(runs) if d.isdigit()] or [0])
    run = os.path.join(runs, str(n))
    os.makedirs(run)
    os.makedirs(job["out"], exist_ok=True)
    report = {"look": look["id"], "run": n, "mpfb": mpfbx.version(), "versions": {}}
    report["made"] = lod.ensure_proxies()
    judged = {}
    sheets = {}
    for v in VERSIONS:
        if v in look["versions"]:
            start = time.time()
            r, gates, sheet = build_version(job, v, run)
            r["seconds"] = round(time.time() - start, 1)
            r["summary"]["seconds"] = r["seconds"]
            report["versions"][v] = r
            judged[v] = gates
            sheets[v] = sheet
    with open(os.path.join(run, "report.json"), "w", encoding="utf8") as f:
        json.dump(report, f, indent=1)
    previous = os.path.join(runs, str(n - 1), "metrics.json")
    report["changes"] = metrics.write(os.path.join(run, "metrics.json"), judged, previous)

    # The sheets, each with every look's silhouettes and the last run's
    # sheet beside it.
    start = time.time()
    row = silhouettes(os.path.dirname(runs))
    for v, sheet in sheets.items():
        sheet.row(row)
        path = os.path.join(run, v, "sheet.png")
        img = sheet.image()
        review.save(img, path)
        before = os.path.join(runs, str(n - 1), v, "sheet.png")
        if os.path.exists(before):
            review.save(_beside(review.load(before), img), os.path.join(run, v, "compare.png"))
    report["sheet seconds"] = round(time.time() - start + sum(s.seconds for s in sheets.values()), 1)
    report["path"] = run
    report["failures"] = [f for g in judged.values() for f in g.failures()]
    return report


def build_version(job, v, run):
    look = job["look"]
    tables = job["tables"]
    budgets = tables["budgets"]
    version = look["versions"][v]
    base = job["bases"][version["base"]]
    name = f"{look['id']}-{v}"
    work = os.path.join(run, v)
    os.makedirs(work)
    order = mpfbx.Order(name)
    body.clear_scene()
    times = {}
    clock = [time.time()]

    def lap(stage):
        now = time.time()
        times[stage] = round(times.get(stage, 0.0) + now - clock[0], 1)
        clock[0] = now

    # The body, shaped and measured.
    macros, targets = body.recipe(base, version)
    human = body.make(name, macros, targets, order)
    marks = landmarks.Landmarks(human)
    bare = marks.measure()
    landmarks.assert_measures(name, bare, base["measure"])

    # The skeleton.
    arm = rig.make(human, work, order)
    rig.add_bones(human, arm, order)

    machine = bool(look.get("machine"))
    if machine:
        # A machine: its plates, frame and head on the skeleton, its coat
        # over them and what lies on the coat.
        order.step("proxy")
        skin, worn = machines.make(job, v, human, arm, marks)
        order.step("garments")
        worn += garment.dress(job, v, human, arm, marks, work)
        worn.append(machines.over_coat(job, v, arm, marks, worn))
        hidden = 0
        looks_face = {}
        lap("body, rig, garments")
    else:
        # The close body, and the clothes over it.
        order.step("proxy")
        skin = lod.fit(human, "close", rigged=True)
        skin.name = skin.data.name = "body"
        garment.mirror(skin)
        order.step("garments")
        worn = garment.dress(job, v, human, arm, marks, work)
        hidden = garment.hide(human, skin, worn)
        # The hair and the hat, over the rest. A hat's parameters may differ
        # by version, as a garment's.
        hair_spec = version.get("hair") or look.get("hair")
        beard = None
        if hair_spec:
            # The look's hair may differ by version in its parameters alone;
            # a beard is a mesh of its own, and a shaved head has no hair.
            hair_spec = dict(hair_spec, params=garment.version_params(hair_spec, v))
            beard = hair_spec["params"].pop("beard", None)
            if hair_spec["params"].get("shell") == "none":
                hair_spec = None
        hat = dict(look["hat"], params=garment.version_params(look["hat"], v)) if look.get("hat") else None
        scarved = hat is not None and hat["family"] == "scarf"
        hair_obj = None
        if hair_spec:
            # Under a hat the hair is pressed flat, so the hat fits the head;
            # under a scarf, all of what it covers.
            under_hat = None
            if hat is not None:
                under_hat = (scarf.band(human, marks, hat["params"]) if scarved
                             else profiles.seat(human, marks, hat["params"].get("seat", 0.0)))
            hair_obj = hair.make(hair_spec, human, marks, arm, budgets["close"]["hair"], under_hat, skin)
            worn.append(garment.Worn(hair_obj, "hair", hair_spec, None))
        if beard:
            b = hair.make_beard(beard, human, marks, arm, budgets["close"]["beard"], skin)
            worn.append(garment.Worn(b, "beard", {"id": "beard", "region": "hair", "params": beard}, None))
        if hat is not None:
            if scarved:
                h = scarf.make(hat, human, marks, arm, skin, over=[hair_obj] if hair_obj is not None else [])
            else:
                h = profiles.make(hat, human, marks, arm)
            worn.append(garment.Worn(h, "hat", hat, None))
        # The trims on the fitted garments.
        if look.get("trims"):
            t, mirrored = trims.make(look["trims"], worn, arm, marks)
            worn.append(garment.Worn(t, "prop", {"id": "trims", "region": "fixed",
                                                 "params": {"asymmetric": not mirrored}}, None))
        # The eyes and lashes; the skin's paint is given with its material.
        looks_face = _merged(base.get("face") or {}, version.get("face") or {})
        parts, eyes_at = face.make(looks_face, human, arm, budgets["close"].get("face", 0))
        for o in parts:
            worn.append(garment.Worn(o, "face", {"id": o.name, "region": "fixed"}, None))
        face.paint_skin_uv(skin)
        lap("body, rig, garments")
    # What cannot be seen, buried; and the dressed figure measured.
    bury = machines.bury if machine else garment.bury_all
    buried = {"close": bury(skin, worn, tables["ease"])}
    # What the sailor carries, laid on the clothes as they are left: the
    # deck level keeps only what is seen from it.
    for g in [] if machine else look.get("gear") or []:
        g = dict(g, params=garment.version_params(g, v))
        o = gears.make(g, human, marks, arm, worn, skin)
        worn.append(garment.Worn(o, "gear" if gears.deck(g) else "prop", g, None))
    # Nothing hidden may darken the bake: the base mesh is not drawn.
    human.hide_render = True
    meshes = [skin] + [g.obj for g in worn]
    # The figure as dressed is measured on the clothes, not on what is
    # carried over them (a case across the back) nor on the hair (long
    # hair at the shoulders' height would be taken for them).
    carried = {g.obj.name for g in worn if g.kind in ("gear", "prop", "hair", "beard")}
    dressed = garment.measure(marks, [o for o in meshes if o.name not in carried])

    # The atlas.
    size = tables["atlas"]["close"]
    margin = tables["atlas"]["margin"]
    head_faces = {}
    if not machine:
        # The mouth's inside, hidden by the closed lips, goes.
        face.lips_at(skin, marks)
        face.close_mouth(skin)
        region = lod.regions(body.coords(skin), marks.joint)
        head_faces[skin] = _faces_in(skin, np.isin(region, ("mouth", "lids", "face", "head")))
    for w in worn:
        if w.kind in ("face", "head"):
            head_faces[w.obj] = np.ones(len(w.obj.data.polygons), bool)
    unfolded = {}
    for o in meshes:
        atlas.prepare(o)
        unfolded[o.name] = atlas.untangle(o)

    if not machine:
        skin.data.materials.clear()
        skin.data.materials.append(atlas.part(bpy.data.materials.new("skin"), region="skin"))
        face.paint_skin(skin.data.materials[0], eyes_at, looks_face)
    share = atlas.layout(meshes, head_faces, look.get("atlas-head", tables["atlas"]["head"]), margin / size)
    base_px, mask_px = atlas.bake(meshes, size, margin)
    hair.drop_details()

    lap("atlas")
    order.step("export")
    for o in meshes:
        rig.limit_weights(o, rig.bone_names(arm))

    # The judges, and the stage they judge on.
    stage = stages.Stage(job["root"], tables["stage"])
    lib = motion.Library(job)
    fig = motion.Figure(arm, meshes, stage, tables["motion"])
    fig.sitting = [skin] + [w.obj for w in worn if w.kind == "garment" and not (w.spec.get("params") or {}).get("skirt")]
    # Laid on the seat, each layer above the one under it.
    above = {w.obj.name: tables["ease"][(w.spec.get("params") or {}).get("layer", w.spec["family"])]
             for w in worn if w.kind == "garment"
             or (w.kind == "gear" and (w.spec.get("params") or {}).get("layer"))}
    fig.lay_on_seat(meshes, above)
    kinds = {"body": "body", **{w.obj.name: w.kind for w in worn}}
    settled = {"close": garment.settle(fig, lib, POSES, worn, tables["ease"])}
    lap("settle")
    declared = {w.obj.name for w in worn if (w.spec.get("params") or {}).get("asymmetric")}
    # A face given an asymmetry (a smile higher on one side, one brow) is
    # not its own mirror.
    if any(t.startswith("asym") for t in targets):
        declared.add("body")
    for o in meshes:
        if o.name not in declared:
            garment.mirror(o, 0.015, greedy=True)
        if kinds.get(o.name) == "beard":
            # Made its own mirror, a beard's fine faces about the lips may
            # meet three on an edge.
            lod.manifold(o)
    closed = {w.obj.name for w in worn if (w.spec.get("params") or {}).get("closed")}
    gates = metrics.Gates(name)
    skeleton = tables["skeleton"]
    sheet = review.Sheet(f"{look['name']}, {v}: run {os.path.basename(run)}")
    sheet.seconds = 0.0
    renderer = review.Renderer(work)
    lookmat = review.Look(meshes, base_px, mask_px, look["palette"])
    clips = {}

    levels = {}
    out = job["out"]
    sizes = {}
    for level, s in (("close", size), ("deck", tables["atlas"]["deck"]), ("far", tables["atlas"]["far"])):
        b, m = (base_px, mask_px) if s == size else (atlas.scaled(base_px, s), atlas.scaled(mask_px, s))
        base_png, mask_png = os.path.join(work, f"{level}.base.png"), os.path.join(work, f"{level}.mask.png")
        atlas.save(b, base_png)
        atlas.save(m, mask_png)
        if level == "deck":
            # The figure's triangles shared by what each mesh had, each
            # within its own kind's.
            deck = budgets["deck"]

            # Shared by what each mesh had, the hat and hair counting for
            # more (they make the silhouette at a distance), each within its
            # own kind's and never so few it loses its shape.
            weight = {"hat": 1.8, "hair": 1.5, "beard": 1.0, "face": 0.5, "plate": 1.8, "head": 1.2, "gear": 1.0}
            def deck_weight(kind, spec=None):
                return weight.get(kind, 1.0) * ((spec or {}).get("params") or {}).get("deck-weight", 1.0)

            # Less the least each mesh is given, shared by the rest.
            parts = [(skin, "body", None)] + [(g.obj, g.kind, g.spec) for g in worn
                                              if g.kind != "prop" and g.obj.name != "lashes"]
            total = sum(lod.triangles(o) * deck_weight(k, sp) for o, k, sp in parts)
            spare = deck["figure"] - 80 * len(parts)

            def deck_share(o, kind, spec=None):
                share = 80 + int(spare * lod.triangles(o) * deck_weight(kind, spec) / total)
                return min(deck[kind], share)

            keep = np.vectorize(lod.DECK_KEEP.get)(lod.regions(body.coords(skin), marks.joint))
            lod.decimate(skin, deck_share(skin, "body"), keep)
            # The lashes and the trims are too fine to see from the deck.
            for g in [g for g in worn if g.obj.name == "lashes" or g.kind == "prop"]:
                meshes.remove(g.obj)
                worn.remove(g)
                bpy.data.objects.remove(g.obj, do_unlink=True)
            fig.meshes = meshes
            for g in worn:
                # A machine's head keeps its face as a body keeps its own.
                at = (np.vectorize(lod.DECK_KEEP.get)(lod.regions(body.coords(g.obj), marks.joint))
                      if g.kind == "head" else machines.deck_keep(g.obj) if g.kind == "plate" else None)
                lod.decimate(g.obj, deck_share(g.obj, g.kind, g.spec), at)
                if g.kind == "beard":
                    # Collapsed, a beard's edges lift off the face: turned
                    # down to the skin again.
                    hair.edge_to_skin(g.obj, skin)
            if machine:
                # A machine's small fittings, collapsed this far, are specks
                # apart from what they were on: they go.
                for o in meshes:
                    if o is not skin:
                        garment.drop_fragments(o, 16)
            buried["deck"] = bury(skin, worn, tables["ease"])
            for o in meshes:
                rig.limit_weights(o, rig.bone_names(arm))
                unfolded[o.name + " deck"] = atlas.untangle(o)
                unfolded[o.name + " deck overlapping"] = atlas.drop_overlaps(o, size)
            fig.lay_on_seat(meshes, above)
            settled["deck"] = garment.settle(fig, lib, POSES, worn, tables["ease"])
            # A collapse this coarse is its own mirror only roughly.
            for o in meshes:
                if o.name not in declared:
                    garment.mirror(o, 0.03, greedy=True)
                if machine or kinds.get(o.name) in ("gear", "beard", "hair"):
                    # A collapse of parts touching (a machine's, a case
                    # and its strap, long hair) may join three faces on an edge.
                    lod.manifold(o)
        if level == "far":
            # The eyes are nothing at that distance.
            far = lod.far([o for o in meshes if kinds.get(o.name) != "face"], arm, budgets["far"]["figure"],
                          lambda: fig.pose(lib.poses["far"]), cloth=[g.obj.name for g in worn if g.kind == "garment"])
            meshes = [far]
            unfolded["far"] = atlas.untangle(far)
            # A collapse this coarse folds a few faces' UVs onto another
            # island's; at that distance a face is a pixel: they go.
            unfolded["far overlapping"] = atlas.drop_overlaps(far, tables["atlas"]["close"])
            lod.manifold(far)
            far.parent = arm
            fig.meshes = fig.sitting = meshes
            kinds = {"figure": "figure"}
            # A collapse this coarse drags a vertex a few centimetres: what
            # it drags through the boat, posed on its seat, is brought back.
            settled["far"] = metrics.keep_off_boat(fig, lib.poses["far"], far)
            # Where its gates judge it seated: the file carries it.
            far_place = fig.pose(lib.poses["far"])["place"].copy()
            fig.reset()
        lap(f"{level} level")
        path = os.path.join(out, f"{v}{'' if level == 'close' else '.' + level}.glb")
        places = {"place": far_place} if level == "far" else None
        if machine and level != "far":
            # Where the machine's lantern is, at rest: the game hangs its
            # glow there.
            lamp = next(o for o in meshes if "lantern" in o)
            places = {"place-lantern": Matrix.Translation(Vector(lamp["lantern"]))}
        tris = export.write(path, meshes, arm if level != "far" else None, export.material(base_png), mask_png,
                            job["gltfpack"], work, places)
        levels[level] = {"triangles": tris, "figure": sum(tris.values()), "bytes": os.path.getsize(path)}
        gltf, _ = export.read(path)
        lap("export")

        # The gates of the level.
        metrics.budget(gates, level, tris, budgets[level], {g.obj.name: g.kind for g in worn})
        for o in meshes:
            metrics.mesh(gates, level, o, closed=o.name in closed)
            if level != "far":
                # The far level is one mesh, posed at the helm: not its own
                # mirror.
                metrics.symmetry(gates, level, o, o.name in declared)
            if level != "far":
                metrics.weights(gates, level, o, rig.bone_names(arm))
        if level != "far":
            metrics.skeleton(gates, level, gltf, skeleton)
        metrics.atlas(gates, level, meshes)
        if level != "far":
            # The far level is one mesh: its parts cannot be told apart.
            metrics.floating(gates, level, meshes, kinds)
        sizes[level] = metrics.file(gates, level, path, gltf, [o.name for o in meshes], skeleton,
                                    tables["sizes"]["close"] if level == "close" else None)
        if level == "close" and not machine:
            metrics.figure(gates, marks, human, [o for o in meshes if o.name not in carried], worn,
                           tables["ease"], v)
        elif level == "close" and v == "female":
            metrics.bust(gates, marks, meshes)
        if level != "far":
            maps = metrics.poses(gates, level, fig, lib, worn, tables["ease"], POSES)
            seats = metrics.seat(gates, level, fig, lib, SEATED)
        else:
            seats = metrics.seat(gates, level, fig, lib, ("far",))
        if level == "deck":
            clip_seat(gates, level, fig)

        lap("gates")
        # The sheet, and the clips on the close level.
        start = time.time()
        if level == "close":
            sheet.row(review.views(renderer, fig, lookmat))
            sheet.row(review.faces(renderer, fig, lookmat))
            sheet.row(review.technical(renderer, fig, lookmat))
            sheet.row(review.poke_map(renderer, fig, lookmat, lib, maps) +
                      review.poke_map(renderer, fig, lookmat, lib, seats, what="seat") +
                      review.posed(renderer, fig, lookmat, lib, POSES[:2]))
            sheet.row(review.posed(renderer, fig, lookmat, lib, POSES[2:]))
            sheet.row(review.boat_views(renderer, fig, lookmat, lib))
            sheet.seconds += time.time() - start
            lap("sheet")
            clips = make_clips(job, v, fig, lib, kinds, gates, renderer, lookmat, work, worn)
            lap("clips")
            start = time.time()
        if level == "deck":
            pic, sil = review.game(renderer, fig, lookmat, lib)
            review.save(review.flatten(sil, (1, 1, 1)), os.path.join(work, "silhouette.png"))
            sheet.row([("game camera", review.upscale(review.flatten(pic), 4)),
                       ("silhouette", review.upscale(review.flatten(sil, (1, 1, 1)), 4))])
        sheet.seconds += time.time() - start
        lap("sheet")
    lookmat.restore()
    renderer.close()
    gates.add("far", "file size", sizes["deck"] + sizes["far"], tables["sizes"]["deck-far"],
              sizes["deck"] + sizes["far"] <= tables["sizes"]["deck-far"], with_deck=True)

    return {
        "bare": _round(bare),
        "dressed": _round(dressed),
        "bones": len(arm.data.bones),
        "hidden": hidden,
        "buried": buried,
        "settled": settled,
        "unfolded": unfolded,
        "head-share": round(share, 3),
        "levels": levels,
        "clips": clips,
        "sheet seconds": round(sheet.seconds, 1),
        "times": times,
        "summary": {
            "height": f"{bare['height']:.3f} m",
            "heads": f"{bare['heads']:.2f}",
            "waist-to-hip": f"{bare['waist-to-hip']:.3f} bare, {dressed['waist-to-hip']:.3f} dressed",
            "shoulder-to-hip": f"{bare['shoulder-to-hip']:.3f} bare, {dressed['shoulder-to-hip']:.3f} dressed",
            "bones": len(arm.data.bones),
            "head in the atlas": f"{share:.0%}",
            "triangles": "/".join(str(levels[k]["figure"]) for k in ("close", "deck", "far")),
            "KB": "/".join(f"{levels[k]['bytes'] / 1024:.0f}" for k in ("close", "deck", "far")),
            "gates failed": len(gates.failures()),
            "sheet": f"{sheet.seconds:.1f} s",
        },
    }, gates, sheet


def make_clips(job, v, fig, lib, kinds, gates, renderer, lookmat, work, worn=()):
    """The look's clips, made or retargeted on this version, each skirt's
    chains turned clear of the legs (motion.clear_skirts), judged, drawn
    and exported together. Returns each clip's measures."""
    # A clip made on both sides is two; each is written under the name the
    # game asks for it by.
    names = [n for c in job["look"].get("clips") or [] for n in (c, c + motion.PORT) if n in lib.clips or n == c]
    called = job["look"].get("names") or {}

    def as_(n):
        base = n[:-len(motion.PORT)] if n.endswith(motion.PORT) else n
        return called.get(base, base) + n[len(base):]

    if not names:
        return {}
    judge = _motion_gate()
    m = lib.motion
    fig.reset()
    proxies = judge.proxies(fig, kinds, ("pelvis",) if job["look"].get("machine") else ())
    pairs = metrics.skirt_pairs(fig.meshes, worn)
    under = (pairs[0][0], pairs[0][2]) if pairs else None
    skirts = [s for _, s, _ in pairs]
    out = {}
    actions = []
    places = {}
    for name in names:
        start = time.time()
        if name in lib.clips:
            clip = motion.make(fig, lib, name)
        else:
            clip = retarget.retarget(fig, name, lib.retargets[name], m["fps"])
        made = time.time() - start
        # The skirts turned clear of the legs, frame by frame.
        fig.quiet(False)
        clip.notes["skirt frames turned"] = motion.clear_skirts(fig, clip, under, skirts)
        act, slot = motion.write_action(fig.arm, as_(name), clip.frames, clip.fps)
        actions.append((act, slot))
        fig.made[name] = (act, slot, clip)
        places[f"place-{as_(name)}"] = clip.place.copy()
        fig.quiet()
        measures, track = judge.check(fig, clip, act, slot, m["gate"], m["ranges"], proxies)
        fig.quiet(False)
        measures["seconds"] = round(made, 1)
        out[name] = measures
        for g, r in measures.items():
            if isinstance(r, dict) and "ok" in r:
                gates.add("clips", f"{name} {g}", r["value"], r["limit"], r["ok"])
        review.clip_sheet(renderer, fig, lookmat, clip, act, slot, track, os.path.join(work, f"clip-{name}.png"),
                          judge.CURVES)
        fig.reset()
    path = os.path.join(job["out"], f"{v}.clips.glb")
    motion.export(path, fig.arm, actions, job["gltfpack"], work, places)
    clip_seat(gates, "close", fig, out)
    clip_skirts(gates, fig, worn, out)
    gltf, _ = export.read(path)
    metrics.file(gates, "clips", path, gltf, [], job["tables"]["skeleton"], None, clips=[as_(n) for n in names])
    metrics.skeleton(gates, "clips", gltf, job["tables"]["skeleton"])
    return out


def clip_seat(gates, level, fig, measures=None):
    """Nothing through the boat in any frame of a clip placed in it: the
    seated, hiking, crossing and climbing ones, at this level. The skirts
    laid on the seat as the game lays them."""
    import bpy

    for name, (act, slot, clip) in fig.made.items():
        if clip.place == Matrix():
            continue
        start = time.time()
        fig.reset()
        motion.play(fig.arm, act, slot)
        fig.arm.matrix_world = clip.place
        fig.on_seat(True)
        through = []
        total = 0
        for f in range(len(clip.frames)):
            bpy.context.scene.frame_set(f)
            # The cloth is laid on the seat while the hips are over it, not
            # while the sailor hangs outside the boat, climbing in.
            fig.on_seat(fig.world("pelvis").z > fig.stage.seat.z - 0.2)
            fig.update()
            t, hits = metrics.through_boat(fig, fig.meshes)
            k = t["vertices"] + t["bones"]
            if k:
                total += k
                through.append([f, {m: len(h) for m, h in hits.items() if h}] + t["crossed"][:2] + t["lines"][:1])
        motion.stop(fig.arm)
        fig.reset()
        worst = sorted(through, key=lambda f: -sum(f[1].values()))[:3]
        gates.add(level, f"seat {name} every frame", total, 0, total == 0, frames=through[:3] + worst,
                  all=[[f[0], sum(f[1].values())] for f in through],
                  seconds=round(time.time() - start, 1))
        if measures is not None and name in measures:
            measures[name]["seat"] = {"value": total, "limit": 0, "ok": total == 0}


def clip_skirts(gates, fig, worn, measures):
    """Nothing of the thighs or knees through a skirt in any frame of a
    clip that stands, treads water or rights the boat: a thigh swung back
    in a stride stays under the cloth that hangs over it. Clips placed in
    the boat are measured the same way: the skirts laid on the seat as the
    game lays them, and what sits on the seat under that cloth is not
    through it."""
    import bpy

    fig.reset()
    pairs = metrics.skirt_pairs(fig.meshes, worn)
    if not pairs:
        return
    body = pairs[0][0]
    for name, (act, slot, clip) in fig.made.items():
        start = time.time()
        fig.reset()
        motion.play(fig.arm, act, slot)
        fig.arm.matrix_world = clip.place
        seated = clip.place != Matrix()
        frames = []
        for f in range(len(clip.frames)):
            bpy.context.scene.frame_set(f)
            fig.on_seat(seated and fig.world("pelvis").z > fig.stage.seat.z - 0.2)
            fig.update()
            metrics.poke.through = {}
            n, hits = metrics.poke(fig, pairs, sided=True, above=motion.laid(fig))
            if n:
                idx = hits[body.name]
                co = motion.coords_posed(body)[0][idx].mean(0)
                bones = sorted({_bone_of(body, i) for i in idx})
                frames.append([f, n] + [round(float(x), 3) for x in co] + bones)
        total = sum(fr[1] for fr in frames)
        worst = sorted(frames, key=lambda fr: -fr[1])[:3]
        lines = []
        if worst:
            # The worst frame's vertices, each with the cloth it is through
            # and the chain that cloth hangs from.
            bpy.context.scene.frame_set(worst[0][0])
            fig.on_seat(seated and fig.world("pelvis").z > fig.stage.seat.z - 0.2)
            fig.update()
            lines = motion.skirt_lines(fig, body, pairs[0][2], [s for _, s, _ in pairs])[:8]
        motion.stop(fig.arm)
        fig.reset()
        # Placed in the boat (seated, crossing, climbing in), the hips'
        # own cloth meets the thighs turned hard into it, which the chains
        # cannot carry away: measured, not yet held to nothing.
        held = not seated
        ok = total == 0 or not held
        gates.add("clips", f"{name} under the skirt", total, 0 if held else None, ok, frames=len(frames),
                  worst=worst, lines=lines, measured=not held, seconds=round(time.time() - start, 1))
        if name in measures:
            measures[name]["under the skirt"] = {"value": total, "limit": 0 if held else None, "ok": ok}


def _bone_of(obj, i):
    """The bone that weighs most on a vertex."""
    names = {g.index: g.name for g in obj.vertex_groups}
    return max((g.weight, names[g.group]) for g in obj.data.vertices[i].groups)[1]


def _motion_gate():
    """review/motion.py, by its path: build/motion.py has its name."""
    import importlib.util

    here = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "review", "motion.py")
    spec = importlib.util.spec_from_file_location("motion_gate", here)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def silhouettes(runs):
    """The latest silhouette of every look and version built, in a row."""
    row = []
    for look in sorted(os.listdir(runs)) if os.path.isdir(runs) else []:
        d = os.path.join(runs, look)
        done = sorted((int(n) for n in os.listdir(d) if n.isdigit()), reverse=True)
        for v in VERSIONS:
            for n in done:
                p = os.path.join(d, str(n), v, "silhouette.png")
                if os.path.exists(p):
                    row.append((f"{look} {v}", review.upscale(review.load(p), 2)))
                    break
    return row


def _beside(a, b):
    h = max(a.shape[0], b.shape[0])
    pad = np.ones((h, 16, 3), np.float32)
    grow = [np.concatenate([x, np.ones((h - x.shape[0], x.shape[1], 3), np.float32)]) for x in (a, b)]
    return np.concatenate([grow[0], pad, grow[1]], axis=1)


def _merged(a, b):
    """b over a, dictionaries merged all the way down."""
    out = dict(a)
    for k, v in b.items():
        out[k] = _merged(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def _faces_in(obj, vertex_mask):
    """A mask of the faces most of whose vertices are in vertex_mask."""
    out = np.zeros(len(obj.data.polygons), bool)
    for p in obj.data.polygons:
        out[p.index] = vertex_mask[list(p.vertices)].mean() > 0.5
    return out


def _round(d):
    if isinstance(d, dict):
        return {k: _round(x) for k, x in d.items()}
    return round(d, 4) if isinstance(d, float) else d

