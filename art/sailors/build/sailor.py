# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""One look, built: each of its versions from body to export, judged at
each level by the gates (review/metrics.py), drawn on the review sheet
(review/review.py), and its clips made in the motion lab and judged
(build/motion.py, review/motion.py). The run is kept whole, and the build
fails on any gate after everything is written."""

import json
import math
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
    # Only adding clips, the look is as it was: no silhouettes to compare.
    row = [] if job.get("add") else silhouettes(os.path.dirname(runs))
    for v, sheet in sheets.items():
        if row:
            sheet.row(row)
        if not sheet.rows:
            continue
        path = os.path.join(run, v, "sheet.png")
        img = sheet.image()
        review.save(img, path)
        before = os.path.join(runs, str(n - 1), v, "sheet.png")
        if os.path.exists(before):
            review.save(_beside(review.load(before), img), os.path.join(run, v, "compare.png"))
    report["sheet seconds"] = round(time.time() - start + sum(s.seconds for s in sheets.values()), 1)
    report["path"] = run
    report["failures"] = [f for g in judged.values() for f in g.failures()]
    if job.get("add"):
        # Only the clips added are made and written: theirs are the gates
        # that count, and the clips' file's; with nothing of them through
        # the boat (the only clips the close level's seat gates judge).
        report["failures"] = [f for g in judged.values()
                              for f in g.failures(("clips", "clips wheel", "clips trapeze", "clips rail", "clips ship",
                                                   "clips aloft", "clips cat", "clips cruiser", "harness"))] + \
            [f for g in judged.values() for f in g.failures(("close",)) if f" close seat " in f]
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
        # A headscarf may be worn under a hat: tied over the hair, the hat
        # set on it.
        tied = look.get("scarf")
        tied = dict(tied, params=garment.version_params(tied, v)) if tied else None
        scarved = hat is not None and hat["family"] == "scarf"
        hair_obj = None
        if hair_spec:
            # Under a hat the hair is pressed flat, so the hat fits the head;
            # under a scarf, all of what it covers.
            under_hat = None
            if tied is not None:
                under_hat = scarf.band(human, marks, tied["params"])
            elif hat is not None:
                under_hat = (scarf.band(human, marks, hat["params"]) if scarved
                             else profiles.seat(human, marks, hat["params"].get("seat", 0.0)))
            hair_obj = hair.make(hair_spec, human, marks, arm, budgets["close"]["hair"], under_hat, skin)
            worn.append(garment.Worn(hair_obj, "hair", hair_spec, None))
        if beard:
            b = hair.make_beard(beard, human, marks, arm, budgets["close"]["beard"], skin)
            worn.append(garment.Worn(b, "beard", {"id": "beard", "region": "hair", "params": beard}, None))
        on_head = [hair_obj] if hair_obj is not None else []
        if tied is not None:
            s = scarf.make(tied, human, marks, arm, skin, over=on_head)
            worn.append(garment.Worn(s, "hat", tied, None))
            # The hat is set on the scarf, which covers the hair.
            on_head = [s]
        if hat is not None:
            if scarved:
                h = scarf.make(hat, human, marks, arm, skin, over=on_head)
            else:
                # Set on the scarf under it; on the head and the hair
                # pressed flat under it otherwise.
                h = profiles.make(hat, human, marks, arm, over=on_head if tied is not None else ())
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
    for g in [] if machine else (look.get("gear") or []) + (version.get("gear") or []):
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
    # Merged curls may leave a sliver sharing a texel with its neighbour:
    # the smaller goes, as at the deck level.
    for w in worn:
        if w.kind == "hair":
            unfolded[w.obj.name + " overlapping"] = atlas.drop_overlaps(w.obj, size)

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
    # Only adding clips, the levels are made only as far as the clips need
    # (the close level), and written with the run, not beside the art.
    adding = bool(job.get("add"))
    out = work if adding else job["out"]
    sizes = {}
    for level, s in (("close", size), ("deck", tables["atlas"]["deck"]), ("far", tables["atlas"]["far"]))[
            :1 if adding else 3]:
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

            swatch = machines.finger_swatch(skin) if machine else None
            keep = np.vectorize(lod.DECK_KEEP.get)(lod.regions(body.coords(skin), marks.joint))
            lod.decimate(skin, deck_share(skin, "body"), keep)
            if machine:
                # What the collapse left of a machine's fingers, made whole.
                machines.deck_fingers(skin, arm, machines.params(look, v)["fingers"], swatch)
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
            for g in worn:
                if g.kind == "hair" and (g.spec.get("params") or {}).get("deck-specks"):
                    # Collapsed this far and its overlaps dropped, a braid's
                    # root may leave a speck apart from it: it goes.
                    garment.drop_fragments(g.obj, g.spec["params"]["deck-specks"])
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
            metrics.bust(gates, marks, meshes, worn)
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
        if level == "close" and not adding:
            sheet.row(review.views(renderer, fig, lookmat))
            sheet.row(review.faces(renderer, fig, lookmat))
            sheet.row(review.technical(renderer, fig, lookmat))
            sheet.row(review.poke_map(renderer, fig, lookmat, lib, maps) +
                      review.poke_map(renderer, fig, lookmat, lib, seats, what="seat") +
                      review.posed(renderer, fig, lookmat, lib, POSES[:2]))
            sheet.row(review.posed(renderer, fig, lookmat, lib, POSES[2:]))
            sheet.row(review.boat_views(renderer, fig, lookmat, lib))
        if level == "close":
            sheet.seconds += time.time() - start
            lap("sheet")
            clips = make_clips(job, v, fig, lib, kinds, gates, renderer, lookmat, work, worn, marks)
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
    if not adding:
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
            "triangles": "/".join(str(levels[k]["figure"]) for k in ("close", "deck", "far") if k in levels),
            "KB": "/".join(f"{levels[k]['bytes'] / 1024:.0f}" for k in ("close", "deck", "far") if k in levels),
            "gates failed": len(gates.failures()),
            "sheet": f"{sheet.seconds:.1f} s",
        },
    }, gates, sheet


def make_clips(job, v, fig, lib, kinds, gates, renderer, lookmat, work, worn=(), marks=None):
    """The look's clips, made or retargeted on this version, each skirt's
    chains turned clear of the legs (motion.clear_skirts), judged, drawn
    and exported together. Returns each clip's measures."""
    # A clip made on both sides is two; each is written under the name the
    # game asks for it by.
    names = [n for c in job.get("add") or job["look"].get("clips") or [] for n in (c, c + motion.PORT)
             if n in lib.clips or n == c]
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
        # A deep crouch on a deck lifts the knees into the cloth: turned
        # clear no further than cloth falls, not flung out (what is left is
        # measured, as in a tack's cross).
        deep = getattr(clip, "deck", False)
        clip.notes["skirt frames turned"] = motion.clear_skirts(fig, clip, under, skirts,
                                                                most=DEEP_SKIRT if deep else None)
        act, slot = motion.write_action(fig.arm, as_(name), clip.frames, clip.fps)
        actions.append((act, slot))
        fig.made[name] = (act, slot, clip)
        # A clip at the wheel is placed from the helmsman's place, as the
        # game places it from the boat's `sailor` node; one on the trapeze
        # from the rack's edge on its side, as the game places it from the
        # model's `trapeze` node; one on the rail from the deck's edge on
        # its side, as the game places it from a station on the rail.
        if getattr(clip, "standing", False):
            places[f"place-{as_(name)}"] = Matrix.Translation(-fig.stage.wheel.at) @ clip.place
        elif getattr(clip, "trapeze", False):
            side = -1 if name.endswith(motion.PORT) else 1
            places[f"place-{as_(name)}"] = Matrix.Translation(-fig.stage.point("rack", side)) @ clip.place
        elif getattr(clip, "rail", False):
            side = -1 if name.endswith(motion.PORT) else 1
            places[f"place-{as_(name)}"] = Matrix.Translation(-fig.stage.point("rail", side)) @ clip.place
        elif getattr(clip, "yacht", None):
            # On the yacht, from her place it is set at on its side (the
            # starboard's, for a clip with no -port), as the game places it
            # from her model's nodes.
            side = -1 if name.endswith(motion.PORT) else 1
            places[f"place-{as_(name)}"] = \
                Matrix.Translation(-fig.stage.point(motion.YACHT_ANCHORS[clip.yacht], side)) @ clip.place
        elif getattr(clip, "cat", None):
            # On the beach cat, from her place it is set at on its side, as
            # the game places it from her model's `aboard` node.
            side = -1 if name.endswith(motion.PORT) else 1
            places[f"place-{as_(name)}"] = Matrix.Translation(-fig.stage.point(motion.CAT_ANCHORS[clip.cat], side)) \
                @ clip.place
        elif getattr(clip, "ship", None):
            # On the ship, from her place it is set at on its side (the
            # starboard's, for a clip with no -port), as the game places it
            # from that place of her model's `company` node.
            side = -1 if name.endswith(motion.PORT) else 1
            places[f"place-{as_(name)}"] = Matrix.Translation(-fig.stage.point(SHIP_ANCHORS[clip.ship], side)) \
                @ clip.place
        else:
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
    clip_seat(gates, "close", fig, out)
    clip_wheel(gates, fig, out)
    clip_ship(gates, fig, out)
    clip_cat(gates, fig, out)
    clip_yacht(gates, fig, out)
    clip_skirts(gates, fig, worn, out)
    # The files: the clips at a wheel, those on the trapeze and those of
    # the crew on the rail (sat on it, and the crouch they move about the
    # deck in) apart from the rest, as only a boat steered by one, sailed
    # from the other, or with someone at a station on her rail loads them;
    # and the ship's company's, on her decks (standing about, leaning on her
    # rail, sat on her hatch, walking) and at her work and aloft (hauling,
    # in the top, on the yard), loaded only when someone is drawn who needs
    # them.
    def group_of(n):
        c = fig.made[n][2]
        if getattr(c, "group", None):
            return c.group
        return "wheel" if getattr(c, "standing", False) else "trapeze" if getattr(c, "trapeze", False) else \
            "rail" if getattr(c, "rail", False) else "clips"

    groups = tuple((g, [n for n in names if group_of(n) == g])
                   for g in ("clips", "wheel", "trapeze", "rail", "ship", "aloft", "cat", "cruiser"))
    exported = False
    for group, members in groups:
        if not members:
            continue
        path = os.path.join(job["out"], f"{v}.{group}.glb")
        # Exporting a file lets every other clip's action go: after the
        # first, made again from their frames.
        actions = []
        for n in members:
            act, slot, clip = fig.made[n]
            if exported:
                act, slot = motion.write_action(fig.arm, as_(n), clip.frames, clip.fps)
                fig.made[n] = (act, slot, clip)
            actions.append((act, slot))
        exported = True
        here = {f"place-{as_(n)}": places[f"place-{as_(n)}"] for n in members}
        made = [as_(n) for n in members]
        before = sorted(a["name"] for a in export.read(path)[0].get("animations", [])) \
            if job.get("add") and os.path.exists(path) else []
        if set(before) - set(made):
            # Packed apart, then added to the look's file: the clips it has
            # already kept as they are.
            added = os.path.join(work, f"{v}.{group}.added.glb")
            motion.export(added, fig.arm, actions, job["gltfpack"], work, here, m["fps"])
            export.merge_clips(path, added)
            made = sorted(set(before) | set(made))
        else:
            motion.export(path, fig.arm, actions, job["gltfpack"], work, here, m["fps"])
        level = "clips" if group == "clips" else f"clips {group}"
        gltf, _ = export.read(path)
        metrics.file(gates, level, path, gltf, [], job["tables"]["skeleton"], None, clips=made)
        metrics.skeleton(gates, level, gltf, job["tables"]["skeleton"])
        # Each clip made here as long in the file as it was made, at its rate.
        off = 0.0
        for a in gltf.get("animations", []):
            n = next((k for k in members if as_(k) == a["name"]), None)
            if n is not None:
                length = max(gltf["accessors"][sm["input"]]["max"][0] for sm in a["samplers"])
                off = max(off, abs(length - (len(fig.made[n][2].frames) - 1) / m["fps"]))
        gates.add(level, "lengths", off, 0.02, off <= 0.02)
        if group != "clips":
            # On the look's skeleton, joint for joint, as its other clips are.
            apart, turned = export.skeletons_apart(os.path.join(job["out"], f"{v}.clips.glb"), path)
            gates.add(level, "skeleton at rest", apart, 1e-4, apart <= 1e-4 and turned <= 1e-4, turned=turned)
        last = set(members)
    # Every clip's action again, for the deck level's judges.
    for n in names:
        if n not in last:
            act, slot, clip = fig.made[n]
            fig.made[n] = motion.write_action(fig.arm, as_(n), clip.frames, clip.fps) + (clip,)
    if marks is not None and any(group_of(n) == "trapeze" for n in names):
        harness(job, v, fig, marks, worn, gates, work)
    return out


def harness(job, v, fig, marks, worn, gates, work):
    """The trapeze's harness on the figure at rest (build/gear.py), in a
    file of its own beside the clips on the trapeze: only a boat sailed
    from the trapeze loads it. Its node `place-hook` is the hook's eye, in
    the figure's space at rest, where the wire's ring hangs."""
    import bpy

    fig.reset()
    tables = job["tables"]
    obj, eye = gears.harness(tables["stage"]["trapeze"]["harness"], marks, fig.arm, worn, fig.meshes[0],
                             tables["ease"])
    rig.limit_weights(obj, rig.bone_names(fig.arm))
    path = os.path.join(job["out"], f"{v}.harness.glb")
    tris = export.write_plain(path, [obj], fig.arm, job["gltfpack"], work, {"place-hook": Matrix.Translation(eye)})
    n = sum(tris.values())
    budget = tables["budgets"]["close"]["gear"]
    gates.add("harness", "triangles", n, budget, n <= budget)
    gltf, _ = export.read(path)
    metrics.skeleton(gates, "harness", gltf, tables["skeleton"])
    bpy.data.objects.remove(obj, do_unlink=True)


def clip_seat(gates, level, fig, measures=None):
    """Nothing through the boat in any frame of a clip placed in it: the
    seated, hiking, crossing and climbing ones, at this level. The skirts
    laid on the seat as the game lays them."""
    import bpy

    for name, (act, slot, clip) in fig.made.items():
        # On the ship, the beach cat or the yacht, judged against her
        # (clip_ship, clip_cat, clip_yacht).
        if clip.place == Matrix() or getattr(clip, "ship", None) or getattr(clip, "cat", None) or \
                getattr(clip, "yacht", None):
            continue
        start = time.time()
        fig.reset()
        motion.play(fig.arm, act, slot)
        fig.arm.matrix_world = clip.place
        # Standing at the wheel or on the trapeze, nothing lies on a seat.
        standing = getattr(clip, "standing", False) or getattr(clip, "trapeze", False)
        fig.on_seat(not standing)
        through = []
        total = 0
        for f in range(len(clip.frames)):
            bpy.context.scene.frame_set(f)
            # The cloth is laid on the seat while the hips are over it, not
            # while the sailor hangs outside the boat, climbing in; nor
            # standing at the wheel.
            fig.on_seat(not standing and fig.world("pelvis").z > fig.stage.seat.z - 0.2)
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


# What may touch the wheel: the hands on its spokes, and the cuffs at the
# wrists, by the bone that carries most of a vertex.
ON_WHEEL = ("hand", "thumb", "index", "middle", "ring", "pinky", "lowerarm_twist")


def clip_wheel(gates, fig, measures):
    """Nothing of the figure in the wheel's wood (its rim, its spokes) in
    any frame of a clip at the wheel, but the hands that hold its spokes
    and the cuffs at their wrists."""
    import bpy

    wheel = fig.stage.wheel
    if wheel is None:
        return
    held = {}
    for o in fig.meshes:
        names = {g.index: g.name for g in o.vertex_groups}
        held[o.name] = np.array([bool(v.groups) and motion.kind(max((g.weight, names.get(g.group, ""))
                                                                    for g in v.groups)[1]) in ON_WHEEL
                                 for v in o.data.vertices])
    for name, (act, slot, clip) in fig.made.items():
        if not getattr(clip, "standing", False):
            continue
        start = time.time()
        fig.reset()
        motion.play(fig.arm, act, slot)
        fig.arm.matrix_world = clip.place
        fig.on_seat(False)
        frames = []
        for f in range(len(clip.frames)):
            bpy.context.scene.frame_set(f)
            fig.update()
            hits = {}
            for o in fig.meshes:
                co, _ = motion.coords_posed(o)
                idx = wheel.near(co, held[o.name])
                if len(idx):
                    hits[o.name] = [len(idx)] + [round(float(x), 3) for x in co[idx].mean(0)]
            if hits:
                frames.append([f, hits])
        motion.stop(fig.arm)
        fig.reset()
        total = sum(h[0] for _, hs in frames for h in hs.values())
        gates.add("clips", f"{name} clear of the wheel", total, 0, total == 0, frames=frames[:3],
                  seconds=round(time.time() - start, 1))
        if name in measures:
            measures[name]["wheel"] = {"value": total, "limit": 0, "ok": total == 0}


# The ship's place a clip set there is placed from, by where it is set.
SHIP_ANCHORS = {"ship-rail": "ship-rail", "ship-hatch": "ship-hatch", "brace": "brace", "top": "top",
                "yard": "yard"}
# The arms' bones, from the collarbone to the hand.
ARM_KINDS = ("clavicle", "upperarm", "lowerarm", "hand")
# What of a figure holds a rope or stands on one: the hands (and the cuffs
# at the wrists) and the feet; only they may meet the ship's ropes.
ON_ROPES = ON_WHEEL + ("foot", "ball")


def clip_ship(gates, fig, measures):
    """Nothing of the figure through the ship in any frame of a clip set on
    her (stage.Ship): the line from each vertex's nearest bone to it, and
    each bone's line, crossing none of her hull, spars, top or yards; nor
    her ropes, but for what holds them or stands on them (the hands and the
    feet); nor, on the yard, the yard but for the hands that hold it. Sat on her hatch, the cloth laid on it is through her if it is
    under a top of hers, as on any seat."""
    import bpy

    ship = fig.stage.ship
    if ship is None:
        return
    held = {}
    for o in fig.meshes:
        names = {g.index: g.name for g in o.vertex_groups}
        held[o.name] = np.array([bool(v.groups) and motion.kind(max((g.weight, names.get(g.group, ""))
                                                                    for g in v.groups)[1]) in ON_ROPES
                                 for v in o.data.vertices])
    # In the top, the forearm of the hand on a shroud lies along it too.
    held_top = {}
    for o in fig.meshes:
        names = {g.index: g.name for g in o.vertex_groups}
        held_top[o.name] = np.array([bool(v.groups) and motion.kind(max((g.weight, names.get(g.group, ""))
                                                                        for g in v.groups)[1]) in
                                     ON_ROPES + ("lowerarm",) for v in o.data.vertices])
    bones = [b.name for b in fig.arm.data.bones if motion.kind(b.name) in metrics.BODY_BONES]
    free = [b for b in bones if motion.kind(b) not in ON_ROPES]
    # A vertex the arms do not carry is anchored on the body, never on an
    # arm reaching over it (a coat's skirt under a forearm on the rail).
    trunk = np.array([motion.kind(b) not in ARM_KINDS for b in bones])
    armed = {o.name: fig.armed([o]) for o in fig.meshes}
    for name, (act, slot, clip) in fig.made.items():
        if not getattr(clip, "ship", None):
            continue
        start = time.time()
        fig.reset()
        motion.play(fig.arm, act, slot)
        fig.arm.matrix_world = clip.place
        fig.on_seat(clip.seated)
        frames = []
        examples = []
        total = 0
        for f in range(len(clip.frames)):
            bpy.context.scene.frame_set(f)
            fig.update()
            hits = {}
            segs = [(fig.world(b), fig.world(b, "tail")) for b in bones]
            a = np.array([np.array(x[0]) for x in segs])
            b = np.array([np.array(x[1]) for x in segs])
            if clip.ship == motion.YARD:
                # What holds the yard may meet it.
                crossed = [bones[i] for i, b in enumerate(bones)
                           if _crossed(ship.unheld if motion.kind(b) in ON_ROPES else ship.tree, [segs[i]])]
            else:
                crossed = [bones[i] for i in _crossed(ship.tree, segs)]
            loose = [n for n in free if clip.ship != motion.TOP or motion.kind(n) != "lowerarm"]
            crossed += [loose[i] for i in _crossed(ship.ropes, [(fig.world(n), fig.world(n, "tail")) for n in loose])]
            for o in fig.meshes:
                co, _ = motion.coords_posed(o)
                anchors = None
                if clip.seated and motion.SEAT_GROUP in o.vertex_groups:
                    idx = [i for i, p in enumerate(co) if _under(ship.tree, p)]
                else:
                    anchors = metrics._nearest_on_segments(co, a, b)
                    body = ~armed[o.name]
                    if body.any():
                        anchors[body] = metrics._nearest_on_segments(co[body], a[trunk], b[trunk])
                    keep = ~(held_top[o.name] if clip.ship == motion.TOP else held[o.name])
                    if clip.ship == motion.YARD:
                        # On the yard the hands hold it: they may meet it,
                        # and nothing else of hers.
                        idx = _crossed(ship.tree, [(anchors[i], co[i]) for i in np.flatnonzero(keep)],
                                       np.flatnonzero(keep))
                        idx += _crossed(ship.unheld, [(anchors[i], co[i]) for i in np.flatnonzero(~keep)],
                                        np.flatnonzero(~keep))
                    else:
                        idx = _crossed(ship.tree, list(zip(anchors, co)))
                    idx += [i for i in _crossed(ship.ropes, [(anchors[i], co[i]) for i in np.flatnonzero(keep)],
                                                np.flatnonzero(keep))]
                if idx:
                    hits[o.name] = len(set(idx))
                    if len(examples) < 4:
                        examples.append([f, o.name, [round(float(x), 3) for x in co[idx[0]]]] +
                                        ([[round(float(x), 3) for x in anchors[idx[0]]]] if anchors is not None else []))
            n = sum(hits.values()) + len(crossed)
            if n:
                total += n
                frames.append([f, hits] + crossed[:2])
        motion.stop(fig.arm)
        fig.reset()
        worst = sorted(frames, key=lambda fr: -sum(fr[1].values()))[:3]
        gates.add("clips", f"{name} clear of the ship", total, 0, total == 0, frames=frames[:3] + worst,
                  all=[[fr[0], sum(fr[1].values())] for fr in frames], examples=examples,
                  seconds=round(time.time() - start, 1))
        if name in measures:
            measures[name]["ship"] = {"value": total, "limit": 0, "ok": total == 0}


def clip_cat(gates, fig, measures):
    """Nothing of the figure through the beach cat in any frame of a clip
    set on her (stage.Cat): the line from each vertex's nearest bone to it,
    and each bone's line, crossing none of her hulls, decks, beams, side
    bars or fittings, nor her net where it is laced; nor her straps and
    ropes, but for what holds them or stands on them (the hands and the
    feet). Sat on her, the cloth laid on her is through her if it is under
    a top of hers, as on any seat. Lying on her side, her hull and net."""
    import bpy

    cat = fig.stage.cat
    if cat is None:
        return
    held = {}
    for o in fig.meshes:
        names = {g.index: g.name for g in o.vertex_groups}
        held[o.name] = np.array([bool(v.groups) and motion.kind(max((g.weight, names.get(g.group, ""))
                                                                    for g in v.groups)[1]) in ON_ROPES
                                 for v in o.data.vertices])
    bones = [b.name for b in fig.arm.data.bones if motion.kind(b.name) in metrics.BODY_BONES]
    free = [b for b in bones if motion.kind(b) not in ON_ROPES]
    trunk = np.array([motion.kind(b) not in ARM_KINDS for b in bones])
    armed = {o.name: fig.armed([o]) for o in fig.meshes}
    for name, (act, slot, clip) in fig.made.items():
        if not getattr(clip, "cat", None):
            continue
        start = time.time()
        tree = cat.capsized_tree if clip.cat == motion.CAT_STAND else cat.tree
        fig.reset()
        motion.play(fig.arm, act, slot)
        fig.arm.matrix_world = clip.place
        fig.on_seat(clip.seated or clip.cat == motion.CAT_NET)
        frames = []
        examples = []
        total = 0
        for f in range(len(clip.frames)):
            bpy.context.scene.frame_set(f)
            fig.update()
            hits = {}
            segs = [(fig.world(b), fig.world(b, "tail")) for b in bones]
            a = np.array([np.array(x[0]) for x in segs])
            b = np.array([np.array(x[1]) for x in segs])
            crossed = [bones[i] for i in _crossed(tree, segs)]
            if clip.cat != motion.CAT_STAND:
                crossed += [free[i] for i in _crossed(cat.ropes, [(fig.world(n), fig.world(n, "tail")) for n in free])]
            for o in fig.meshes:
                co, _ = motion.coords_posed(o)
                anchors = None
                if (clip.seated or clip.cat == motion.CAT_NET) and motion.SEAT_GROUP in o.vertex_groups:
                    idx = [i for i, p in enumerate(co) if _under(tree, p)]
                else:
                    anchors = metrics._nearest_on_segments(co, a, b)
                    body = ~armed[o.name]
                    if body.any():
                        anchors[body] = metrics._nearest_on_segments(co[body], a[trunk], b[trunk])
                    idx = _crossed(tree, list(zip(anchors, co)))
                    if clip.cat != motion.CAT_STAND:
                        keep = ~held[o.name]
                        idx += _crossed(cat.ropes, [(anchors[i], co[i]) for i in np.flatnonzero(keep)],
                                        np.flatnonzero(keep))
                if idx:
                    hits[o.name] = len(set(idx))
                    if len(examples) < 4:
                        examples.append([f, o.name, [round(float(x), 3) for x in co[idx[0]]]] +
                                        ([[round(float(x), 3) for x in anchors[idx[0]]]] if anchors is not None else []))
            n = sum(hits.values()) + len(crossed)
            if n:
                total += n
                frames.append([f, hits] + crossed[:2])
        motion.stop(fig.arm)
        fig.reset()
        worst = sorted(frames, key=lambda fr: -sum(fr[1].values()))[:3]
        gates.add("clips", f"{name} clear of the cat", total, 0, total == 0, frames=frames[:3] + worst,
                  all=[[fr[0], sum(fr[1].values())] for fr in frames], examples=examples,
                  seconds=round(time.time() - start, 1))
        if name in measures:
            measures[name]["cat"] = {"value": total, "limit": 0, "ok": total == 0}


# On the yacht's rail the forearms lie over her upper lifeline too; and the
# cloth of the arms at the elbow, the sleeves draped over it.
ON_LIFELINE = ON_ROPES + ("lowerarm",)
DRAPED = ON_LIFELINE + ("upperarm",)


def clip_yacht(gates, fig, measures):
    """Nothing of the figure through the yacht in any frame of a clip set
    on her (stage.Yacht): the line from each vertex's nearest bone to it,
    and each bone's line, crossing none of her hull, decks, cockpit,
    benches, coachroof, sprayhood, table, binnacles, capstans, stanchions,
    pulpit, pushpit, mast or boom; nor her ropes (her lifelines above all,
    her rigging, her sheets), but for what holds them (the hands, and on
    her rail the forearms laid over the upper lifeline, the sleeves draped
    over it with them) or stands on them;
    nor, at her wheel, its wood (its rim, its spokes) but for the hands
    that hold it. Sat on her, the cloth laid on her is through her if it is
    under a top of hers, as on any seat."""
    import bpy

    yacht = fig.stage.yacht
    if yacht is None:
        return

    def holds(kinds):
        out = {}
        for o in fig.meshes:
            names = {g.index: g.name for g in o.vertex_groups}
            out[o.name] = np.array([bool(v.groups) and motion.kind(max((g.weight, names.get(g.group, ""))
                                                                       for g in v.groups)[1]) in kinds
                                    for v in o.data.vertices])
        return out

    held = holds(ON_ROPES)
    held_rail = holds(DRAPED)
    on_wheel = holds(ON_WHEEL)
    bones = [b.name for b in fig.arm.data.bones if motion.kind(b.name) in metrics.BODY_BONES]
    trunk = np.array([motion.kind(b) not in ARM_KINDS for b in bones])
    armed = {o.name: fig.armed([o]) for o in fig.meshes}
    for name, (act, slot, clip) in fig.made.items():
        if not getattr(clip, "yacht", None):
            continue
        start = time.time()
        side = -1 if name.endswith(motion.PORT) else 1
        rail = clip.yacht == motion.YACHT_RAIL
        hold = held_rail if rail else held
        free = [b for b in bones if motion.kind(b) not in (ON_LIFELINE if rail else ON_ROPES)]
        at_wheel = clip.yacht in (motion.YACHT_WHEEL, motion.YACHT_HELM)
        laid = clip.seated or clip.yacht in motion.YACHT_DECKS
        fig.reset()
        motion.play(fig.arm, act, slot)
        fig.arm.matrix_world = clip.place
        fig.on_seat(laid)
        frames = []
        examples = []
        total = 0
        wood = 0
        for f in range(len(clip.frames)):
            bpy.context.scene.frame_set(f)
            fig.update()
            hits = {}
            segs = [(fig.world(b), fig.world(b, "tail")) for b in bones]
            a = np.array([np.array(x[0]) for x in segs])
            b = np.array([np.array(x[1]) for x in segs])
            crossed = [bones[i] for i in _crossed(yacht.tree, segs)]
            crossed += [free[i] for i in _crossed(yacht.ropes, [(fig.world(n), fig.world(n, "tail")) for n in free])]
            for o in fig.meshes:
                co, _ = motion.coords_posed(o)
                anchors = None
                if laid and motion.SEAT_GROUP in o.vertex_groups:
                    # (Under her decks, cockpit, benches, coachroof or table:
                    # her boom and rig over them are no top cloth lies on.)
                    idx = [i for i, p in enumerate(co) if _under(yacht.decks, p)]
                else:
                    anchors = metrics._nearest_on_segments(co, a, b)
                    body = ~armed[o.name]
                    if body.any():
                        anchors[body] = metrics._nearest_on_segments(co[body], a[trunk], b[trunk])
                    idx = _crossed(yacht.tree, list(zip(anchors, co)))
                    keep = ~hold[o.name]
                    idx += _crossed(yacht.ropes, [(anchors[i], co[i]) for i in np.flatnonzero(keep)],
                                    np.flatnonzero(keep))
                if at_wheel:
                    near = yacht.near(co, side, on_wheel[o.name])
                    wood += len(near)
                    idx = list(idx) + [int(i) for i in near]
                if idx:
                    hits[o.name] = len(set(idx))
                    if len(examples) < 4:
                        examples.append([f, o.name, [round(float(x), 3) for x in co[idx[0]]]] +
                                        ([[round(float(x), 3) for x in anchors[idx[0]]]] if anchors is not None else []))
            n = sum(hits.values()) + len(crossed)
            if n:
                total += n
                frames.append([f, hits] + crossed[:2])
        motion.stop(fig.arm)
        fig.reset()
        worst = sorted(frames, key=lambda fr: -sum(fr[1].values()))[:3]
        gates.add("clips", f"{name} clear of the yacht", total, 0, total == 0, frames=frames[:3] + worst,
                  all=[[fr[0], sum(fr[1].values())] for fr in frames], examples=examples, wood=wood,
                  seconds=round(time.time() - start, 1))
        if name in measures:
            measures[name]["yacht"] = {"value": total, "limit": 0, "ok": total == 0}


def _crossed(tree, segs, index=None):
    """Which of the segments (each a pair of points) cross what the tree
    holds: their indices, or index's entries for them."""
    out = []
    for i, (p, q) in enumerate(segs):
        d = Vector(q) - Vector(p)
        length = d.length
        if length < 1e-6:
            continue
        if tree.ray_cast(Vector(p), d / length, length)[0] is not None:
            out.append(int(index[i]) if index is not None else i)
    return out


def _under(tree, p):
    """Whether a point is under a top of what the tree holds: straight up,
    the first surface it meets faces up."""
    hit = tree.ray_cast(Vector(p), Vector((0, 0, 1)), 2.0)
    return hit[0] is not None and hit[1].z > 0


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
        # Standing at the wheel the cloth hangs as it does standing anywhere;
        # on the trapeze, from the body lying out.
        seated = clip.place != Matrix() and not getattr(clip, "standing", False) and \
            not getattr(clip, "trapeze", False) and (not getattr(clip, "ship", None) or clip.seated) and \
            (not getattr(clip, "cat", None) or clip.seated) and \
            (not getattr(clip, "yacht", None) or clip.seated or clip.yacht in motion.YACHT_DECKS)
        frames = []
        for f in range(len(clip.frames)):
            bpy.context.scene.frame_set(f)
            fig.on_seat(seated and (bool(getattr(clip, "cat", None)) or bool(getattr(clip, "yacht", None)) or
                                    fig.world("pelvis").z > fig.stage.seat.z - 0.2))
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
            fig.on_seat(seated and (bool(getattr(clip, "cat", None)) or bool(getattr(clip, "yacht", None)) or
                                    fig.world("pelvis").z > fig.stage.seat.z - 0.2))
            fig.update()
            lines = motion.skirt_lines(fig, body, pairs[0][2], [s for _, s, _ in pairs])[:8]
        motion.stop(fig.arm)
        fig.reset()
        # Placed in the boat (seated, crossing, climbing in), crouched low
        # on a deck, or bent over a yard, the hips' own cloth meets the
        # thighs turned hard into it, which the chains cannot carry away:
        # measured, not yet held to nothing.
        held = not seated and not getattr(clip, "deck", False) and getattr(clip, "ship", None) != motion.YARD
        ok = total == 0 or not held
        gates.add("clips", f"{name} under the skirt", total, 0 if held else None, ok, frames=len(frames),
                  worst=worst, lines=lines, measured=not held, seconds=round(time.time() - start, 1))
        if name in measures:
            measures[name]["under the skirt"] = {"value": total, "limit": 0 if held else None, "ok": ok}


# The most a skirt's chain is turned off a crouch's pose to clear the
# knees, in radians: further, and an apron stands out like a board.
DEEP_SKIRT = math.radians(40)


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

