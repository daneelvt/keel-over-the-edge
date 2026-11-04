# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""One look, built: each of its versions from body to export."""

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
import mpfbx
import profiles
import rig

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
    for v in VERSIONS:
        if v in look["versions"]:
            start = time.time()
            r = build_version(job, v, run)
            r["seconds"] = round(time.time() - start, 1)
            r["summary"]["seconds"] = r["seconds"]
            report["versions"][v] = r
    with open(os.path.join(run, "report.json"), "w", encoding="utf8") as f:
        json.dump(report, f, indent=1)
    report["path"] = run
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
    order.step("garments")
    worn = garment.dress(job, v, human, arm, marks, work)
    hidden = garment.hide(human, skin, worn)
    trimmed = garment.trim(worn, tables["ease"])
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
    # Nothing hidden may darken the bake: the base mesh is not drawn.
    human.hide_render = True
    meshes = [skin] + [g.obj for g in worn]
    dressed = garment.measure(marks, meshes)

    # The atlas.
    size = tables["atlas"]["close"]
    margin = tables["atlas"]["margin"]
    region = lod.regions(body.coords(skin), marks.joint)
    head_faces = {skin: _faces_in(skin, np.isin(region, ("face", "head")))}
    for o in meshes:
        atlas.prepare(o)
    skin.data.materials.clear()
    skin.data.materials.append(atlas.part(bpy.data.materials.new("skin"), region="skin"))
    share = atlas.layout(meshes, head_faces, tables["atlas"]["head"], margin / size)
    base_px, mask_px = atlas.bake(meshes, size, margin)

    order.step("export")
    for o in meshes:
        rig.limit_weights(o, rig.bone_names(arm))
    levels = {}
    out = job["out"]
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
            for o in meshes:
                rig.limit_weights(o, rig.bone_names(arm))
        if level == "far":
            meshes = [lod.far(meshes, arm, budgets["far"]["figure"], cloth=[g.obj.name for g in worn])]
        path = os.path.join(out, f"{v}{'' if level == 'close' else '.' + level}.glb")
        tris = export.write(path, meshes, arm if level != "far" else None, export.material(base_png), mask_png,
                            job["gltfpack"], work)
        levels[level] = {"triangles": tris, "figure": sum(tris.values()), "bytes": os.path.getsize(path)}
        _budget(name, level, tris, budgets[level], {g.obj.name: g.kind for g in worn})

    return {
        "bare": _round(bare),
        "dressed": _round(dressed),
        "bones": len(arm.data.bones),
        "hidden": hidden,
        "trimmed": trimmed,
        "head-share": round(share, 3),
        "levels": levels,
        "summary": {
            "height": f"{bare['height']:.3f} m",
            "heads": f"{bare['heads']:.2f}",
            "waist-to-hip": f"{bare['waist-to-hip']:.3f} bare, {dressed['waist-to-hip']:.3f} dressed",
            "shoulder-to-hip": f"{bare['shoulder-to-hip']:.3f} bare, {dressed['shoulder-to-hip']:.3f} dressed",
            "bones": len(arm.data.bones),
            "head in the atlas": f"{share:.0%}",
            "triangles": "/".join(str(levels[k]["figure"]) for k in ("close", "deck", "far")),
            "KB": "/".join(f"{levels[k]['bytes'] / 1024:.0f}" for k in ("close", "deck", "far")),
        },
    }


def _faces_in(obj, vertex_mask):
    """A mask of the faces most of whose vertices are in vertex_mask."""
    out = np.zeros(len(obj.data.polygons), bool)
    for p in obj.data.polygons:
        out[p.index] = vertex_mask[list(p.vertices)].mean() > 0.5
    return out


def _budget(name, level, tris, budget, kinds):
    over = []
    for mesh, n in tris.items():
        kind = "body" if mesh == "body" else kinds.get(mesh, "figure")
        if kind in budget and n > budget[kind]:
            over.append(f"{mesh} {n} > {budget[kind]}")
    if sum(tris.values()) > budget["figure"]:
        over.append(f"the figure {sum(tris.values())} > {budget['figure']}")
    if over:
        raise AssertionError(f"{name} {level}: over budget: " + "; ".join(over) + f" (of {tris})")


def _round(d):
    if isinstance(d, dict):
        return {k: _round(x) for k, x in d.items()}
    return round(d, 4) if isinstance(d, float) else d
