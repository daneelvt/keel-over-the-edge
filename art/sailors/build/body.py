# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""The body: MPFB's human, shaped by a base and a look's changes.

The shape is made complete here and baked into the mesh before anything is
fitted to it: no shape keys leave this module, and none reach the export.
"""

import glob
import os

import bpy
import numpy as np

import mpfbx

MACROS = ("gender", "age", "muscle", "weight", "height", "proportions", "cupsize", "firmness")
RACES = ("african", "asian", "caucasian")

# Ages below 0.5 (25 years) blend in a child's proportions; the sailors are
# 30 to 57.
AGES = (0.6, 0.75)


def recipe(base, version):
    """The macros and targets of a version: its base's, with its own."""
    macros = dict(base["macros"])
    macros.update(version.get("macros") or {})
    targets = dict(base["targets"])
    targets.update(version.get("targets") or {})
    return macros, targets


def check(macros, targets):
    """Refuses a body the sailors may not have."""
    missing = [m for m in MACROS + RACES if m not in macros]
    if missing:
        raise ValueError(f"the macros lack {', '.join(missing)}")
    unknown = sorted(set(macros) - set(MACROS) - set(RACES))
    if unknown:
        raise ValueError(f"no macros {', '.join(unknown)}")
    if not AGES[0] <= macros["age"] <= AGES[1]:
        raise ValueError(f"age {macros['age']}: a sailor is {AGES[0]} to {AGES[1]}")
    if macros["proportions"] != 1.0:
        raise ValueError("proportions must be 1.0, MPFB's ideal")
    if abs(sum(macros[r] for r in RACES) - 1.0) > 0.01:
        raise ValueError("the races must sum to 1")
    # A large head on the body is what read round and young: never enlarged.
    grown = [t for t in targets if t.startswith("head-scale-") and t.endswith("-incr") and targets[t] > 0]
    if grown:
        raise ValueError(f"the head is never enlarged: {', '.join(grown)}")


_targets = None


def target_files(name):
    """The target files a name stands for: both sides for "lr-", and only
    files of exactly that name (MPFB's own search also takes a prefix)."""
    global _targets
    if _targets is None:
        _targets = {}
        for path in glob.glob(os.path.join(mpfbx.data("targets"), "**", "*.target.gz"), recursive=True):
            _targets[os.path.basename(path)[: -len(".target.gz")]] = path
    names = ["l-" + name[3:], "r-" + name[3:]] if name.startswith("lr-") else [name]
    missing = [n for n in names if n not in _targets]
    if missing:
        raise ValueError(f"no MPFB target {', '.join(missing)}")
    return [_targets[n] for n in names]


def make(name, macros, targets, order):
    """The shaped human, its helpers kept (the garments are cut from them)
    and hidden, standing with its feet on the ground at the origin."""
    order.step("shape")
    check(macros, targets)
    human = mpfbx.service("HumanService")
    target = mpfbx.service("TargetService")
    info = {m: macros[m] for m in MACROS}
    info["race"] = {r: macros[r] for r in RACES}
    body = human.create_human(macro_detail_dict=info, feet_on_ground=False)
    for t, weight in sorted(targets.items()):
        if weight:
            for path in target_files(t):
                target.load_target(body, path, weight=weight)
    target.bake_targets(body)
    body.name = body.data.name = name
    # The feet on the ground, by the body's own vertices, not its helpers'.
    co = coords(body)
    lowest = co[in_group(body, "body"), 2].min()
    body.data.transform(_translation(0, 0, -lowest))
    body.data.update()
    return body


def coords(obj):
    """The mesh's vertices as an array, in its own space."""
    co = np.empty(len(obj.data.vertices) * 3)
    obj.data.vertices.foreach_get("co", co)
    return co.reshape(-1, 3)


def in_group(obj, group):
    """A mask of the vertices in a vertex group."""
    index = obj.vertex_groups[group].index
    mask = np.zeros(len(obj.data.vertices), bool)
    for v in obj.data.vertices:
        for g in v.groups:
            if g.group == index and g.weight > 0:
                mask[v.index] = True
    return mask


def _translation(x, y, z):
    from mathutils import Matrix

    return Matrix.Translation((x, y, z))


def clear_scene():
    """Removes everything, so each sailor starts alone: without reading the
    factory settings, which would leave MPFB out."""
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials, bpy.data.images,
                 bpy.data.curves, bpy.data.actions, bpy.data.node_groups, bpy.data.cameras, bpy.data.lights):
        for block in list(coll):
            if block.users == 0:
                coll.remove(block)
