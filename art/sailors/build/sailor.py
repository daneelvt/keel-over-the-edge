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

import atlas
import body
import export
import garment
import hair
import inputs
import landmarks
import lod
import metrics
import motion
import mpfbx
import profiles
import retarget
import review
import rig
import stage as stages

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

    # The close body, and the clothes over it.
    order.step("proxy")
    skin = lod.fit(human, "close", rigged=True)
    skin.name = skin.data.name = "body"
    garment.mirror(skin)
    order.step("garments")
    worn = garment.dress(job, v, human, arm, marks, work)
    hidden = garment.hide(human, skin, worn)
    # The hair and the hat, over the rest.
    if look.get("hair"):
        h = hair.make(look["hair"], human, marks, arm, budgets["close"]["hair"])
        worn.append(garment.Worn(h, "hair", look["hair"], None))
    if look.get("hat"):
        h = profiles.make(look["hat"], human, marks, arm)
        worn.append(garment.Worn(h, "hat", look["hat"], None))
    for w in worn:
        if w.kind != "garment":
            w.obj.data.materials.clear()
            colour = atlas.linear(w.spec["colour"]) if w.spec["region"] == "fixed" else None
            w.obj.data.materials.append(atlas.part(bpy.data.materials.new(w.spec["id"]), colour, w.spec["region"]))
    lap("body, rig, garments")
    # What cannot be seen, buried; and the dressed figure measured.
    buried = {"close": garment.bury_all(skin, worn, tables["ease"])}
    # Nothing hidden may darken the bake: the base mesh is not drawn.
    human.hide_render = True
    meshes = [skin] + [g.obj for g in worn]
    dressed = garment.measure(marks, meshes)

    # The atlas.
    size = tables["atlas"]["close"]
    margin = tables["atlas"]["margin"]
    region = lod.regions(body.coords(skin), marks.joint)
    head_faces = {skin: _faces_in(skin, np.isin(region, ("face", "head")))}
    unfolded = {}
    for o in meshes:
        atlas.prepare(o)
        unfolded[o.name] = atlas.untangle(o)
    skin.data.materials.clear()
    skin.data.materials.append(atlas.part(bpy.data.materials.new("skin"), region="skin"))
    share = atlas.layout(meshes, head_faces, tables["atlas"]["head"], margin / size)
    base_px, mask_px = atlas.bake(meshes, size, margin)

    lap("atlas")
    order.step("export")
    for o in meshes:
        rig.limit_weights(o, rig.bone_names(arm))

    # The judges, and the stage they judge on.
    stage = stages.Stage(job["root"], tables["stage"])
    lib = motion.Library(job)
    fig = motion.Figure(arm, meshes, stage, tables["motion"])
    fig.sitting = [skin] + [w.obj for w in worn if w.kind == "garment" and not (w.spec.get("params") or {}).get("skirt")]
    fig.lay_on_seat(meshes)
    kinds = {"body": "body", **{w.obj.name: w.kind for w in worn}}
    settled = {"close": garment.settle(fig, lib, POSES, worn, tables["ease"])}
    lap("settle")
    for o in meshes:
        garment.mirror(o)
    declared = {w.obj.name for w in worn if (w.spec.get("params") or {}).get("asymmetric")}
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
            close_total = sum(lod.triangles(o) for o in meshes)
            deck = budgets["deck"]

            def deck_share(o, kind):
                return min(deck[kind], int(deck["figure"] * lod.triangles(o) / close_total))

            keep = np.vectorize(lod.DECK_KEEP.get)(lod.regions(body.coords(skin), marks.joint))
            lod.decimate(skin, deck_share(skin, "body"), keep)
            for g in worn:
                lod.decimate(g.obj, deck_share(g.obj, g.kind))
            buried["deck"] = garment.bury_all(skin, worn, tables["ease"])
            for o in meshes:
                rig.limit_weights(o, rig.bone_names(arm))
                unfolded[o.name + " deck"] = atlas.untangle(o)
            fig.lay_on_seat(meshes)
            settled["deck"] = garment.settle(fig, lib, POSES, worn, tables["ease"])
            for o in meshes:
                garment.mirror(o)
        if level == "far":
            meshes = [lod.far(meshes, arm, budgets["far"]["figure"], lambda: fig.pose(lib.poses["far"]),
                              cloth=[g.obj.name for g in worn])]
            far = meshes[0]
            unfolded["far"] = atlas.untangle(far)
            far.parent = arm
            fig.meshes = fig.sitting = meshes
            kinds = {"figure": "figure"}
            # A collapse this coarse drags a vertex a few centimetres: what
            # it drags through the boat, posed on its seat, is brought back.
            settled["far"] = metrics.keep_off_boat(fig, lib.poses["far"], far)
        lap(f"{level} level")
        path = os.path.join(out, f"{v}{'' if level == 'close' else '.' + level}.glb")
        tris = export.write(path, meshes, arm if level != "far" else None, export.material(base_png), mask_png,
                            job["gltfpack"], work)
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
        if level == "close":
            metrics.figure(gates, marks, human, meshes, worn, tables["ease"], v)
        if level != "far":
            maps = metrics.poses(gates, level, fig, lib, worn, tables["ease"], POSES)
            seats = metrics.seat(gates, level, fig, lib, SEATED)
        else:
            seats = metrics.seat(gates, level, fig, lib, ("far",))

        lap("gates")
        # The sheet, and the clips on the close level.
        start = time.time()
        if level == "close":
            sheet.row(review.views(renderer, fig, lookmat))
            sheet.row(review.technical(renderer, fig, lookmat))
            sheet.row(review.poke_map(renderer, fig, lookmat, lib, maps) +
                      review.poke_map(renderer, fig, lookmat, lib, seats, what="seat") +
                      review.posed(renderer, fig, lookmat, lib, POSES[:2]))
            sheet.row(review.posed(renderer, fig, lookmat, lib, POSES[2:]))
            sheet.row(review.boat_views(renderer, fig, lookmat, lib))
            sheet.seconds += time.time() - start
            lap("sheet")
            clips = make_clips(job, v, fig, lib, kinds, gates, renderer, lookmat, work)
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


def make_clips(job, v, fig, lib, kinds, gates, renderer, lookmat, work):
    """The look's clips, made or retargeted on this version, judged, drawn
    and exported together. Returns each clip's measures."""
    names = job["look"].get("clips") or []
    if not names:
        return {}
    judge = _motion_gate()
    m = lib.motion
    fig.reset()
    proxies = judge.proxies(fig, kinds)
    out = {}
    actions = []
    for name in names:
        start = time.time()
        if name in lib.clips:
            clip = motion.make(fig, lib, name)
        else:
            clip = retarget.retarget(fig, name, lib.retargets[name], m["fps"])
        made = time.time() - start
        act, slot = motion.write_action(fig.arm, name, clip.frames, clip.fps)
        actions.append((act, slot))
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
    motion.export(path, fig.arm, actions, job["gltfpack"], work)
    gltf, _ = export.read(path)
    metrics.file(gates, "clips", path, gltf, [], job["tables"]["skeleton"], None, clips=names)
    metrics.skeleton(gates, "clips", gltf, job["tables"]["skeleton"])
    return out


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

