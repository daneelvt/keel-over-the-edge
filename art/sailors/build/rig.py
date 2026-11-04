# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""The skeleton every sailor shares, and the body's weights on it.

MPFB's game_engine rig (53 bones in Unreal's names) with its jaw, eyes and
lids from MPFB's default rig, all placed by MPFB's own resolver on the
shaped body and weighted from MPFB's CC0 weights; then the bones of our
own, placed from those: a corrector at each hip that turns half as far as
the thigh (the seated groin folds without it), a twist bone in each
forearm, the pendant's socket at the breastbone, six two-bone chains for
skirts and coat tails, and eight spring joints for hair, tails and an
apron. Every file has the same bones, in the same order, so one skeleton,
one set of clips and one shader serve every sailor.
"""

import json
import os

import bpy
import numpy as np
from mathutils import Vector

import body
import mpfbx

# The bones taken from MPFB's default rig, by the names they take here.
FROM_DEFAULT = {
    "jaw": "jaw",
    "eye.L": "eye_l",
    "eye.R": "eye_r",
    "orbicularis03.L": "lid_upper_l",
    "orbicularis04.L": "lid_lower_l",
    "orbicularis03.R": "lid_upper_r",
    "orbicularis04.R": "lid_lower_r",
}

# The skirt chains go round the hips at these angles from the front, a
# side's (left positive x); each is two bones, waist to mid-thigh to knee.
SKIRT = {"front": 25.0, "side": 90.0, "back": 150.0}

SPRINGS = 8
PENDANT = "pendant"

# Every bone's name, in the order of the files.
GAME_ENGINE = 53
BONES = GAME_ENGINE + len(FROM_DEFAULT) + 2 + 2 + 1 + 2 * 2 * len(SKIRT) + SPRINGS


def definition():
    """The rig MPFB fits: game_engine's bones and the default rig's few,
    parented to the head."""
    with open(mpfbx.data("rigs", "standard", "rig.game_engine.json"), encoding="utf8") as f:
        bones = json.load(f)
    with open(mpfbx.data("rigs", "standard", "rig.default.json"), encoding="utf8") as f:
        default = json.load(f)
    for src, name in FROM_DEFAULT.items():
        bone = dict(default[src])
        bone["parent"] = "head"
        bones[name] = bone
    return bones


def weights():
    """MPFB's weights for the bones it places: game_engine's, with the
    default rig's for the face carved into them, so that each vertex's sum
    is what it was."""
    with open(mpfbx.data("rigs", "standard", "weights.game_engine.json"), encoding="utf8") as f:
        ge = json.load(f)
    with open(mpfbx.data("rigs", "standard", "weights.default.json"), encoding="utf8") as f:
        default = json.load(f)
    extra = {name: default["weights"][src] for src, name in FROM_DEFAULT.items()}
    taken = {}
    for pairs in extra.values():
        for v, w in pairs:
            taken[v] = taken.get(v, 0.0) + w
    out = {}
    for bone, pairs in ge["weights"].items():
        out[bone] = [[v, w * (1.0 - min(taken.get(v, 0.0), 1.0))] for v, w in pairs]
    out.update(extra)
    return {"weights": out}


def make(human, work, order):
    """The armature, fitted to the shaped body, with the body skinned to it."""
    order.step("rig")
    rig_cls = mpfbx.entity("rig", "Rig")
    rigs = mpfbx.service("RigService")
    path = os.path.join(work, "rig.json")
    with open(path, "w", encoding="utf8") as f:
        json.dump(definition(), f)
    rig = rig_cls.from_json_file_and_basemesh(path, human)
    arm = rig.create_armature_and_fit_to_basemesh(add_modifier=False)
    arm.name = arm.data.name = "skeleton"
    human.parent = arm
    rigs.apply_weights(arm, human, weights())
    rigs.ensure_armature_modifier(human, arm)
    return arm


def add_bones(human, arm, order):
    """The bones of our own, placed from the fitted ones, and their weights."""
    order.step("bones")
    lm_skin = body.coords(human)[body.in_group(human, "body")]
    select(arm)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm.data.edit_bones

    def bone(name, parent, head, tail, roll=0.0, deform=True):
        b = eb.new(name)
        b.head, b.tail, b.roll = Vector(head), Vector(tail), roll
        b.parent = eb[parent]
        b.use_deform = deform
        return b

    for s in ("l", "r"):
        thigh = eb["thigh_" + s]
        bone("thigh_corrector_" + s, "pelvis", thigh.head, thigh.head.lerp(thigh.tail, 0.3), thigh.roll)
        fore = eb["lowerarm_" + s]
        bone("lowerarm_twist_" + s, "lowerarm_" + s, fore.head.lerp(fore.tail, 0.6), fore.tail, fore.roll)

    # The pendant hangs at the breastbone, a third of the way from the
    # collarbones' joint down to the chest's middle, at its front.
    top = (eb["clavicle_l"].head + eb["clavicle_r"].head) / 2
    z = top.z - 0.11
    front = lm_skin[(np.abs(lm_skin[:, 0]) < 0.01) & (np.abs(lm_skin[:, 2] - z) < 0.01)]
    y = float(front[:, 1].min()) - 0.005
    bone(PENDANT, "spine_03", (0, y, z), (0, y, z - 0.03), deform=False)

    # The skirt chains hang from the waist round the hips' section.
    pelvis = eb["pelvis"]
    waist = pelvis.tail.z if pelvis.tail.z > pelvis.head.z else pelvis.head.z
    knee = (eb["calf_l"].head.z + eb["calf_r"].head.z) / 2
    mid = (waist + knee) / 2
    for side, sign in (("l", 1.0), ("r", -1.0)):
        for place, deg in SKIRT.items():
            a = np.radians(deg)
            d = np.array([sign * np.sin(a), -np.cos(a)])
            points = [Vector(_on_section(lm_skin, z, d)) for z in (waist, mid, knee)]
            first = bone(f"skirt_{place}_{side}_01", "pelvis", points[0], points[1])
            second = bone(f"skirt_{place}_{side}_02", first.name, points[1], points[2])
            second.use_connect = True

    # The spring joints: two chains of four, from the back of the head and
    # from the back of the chest; a look moves them where its hair, tails or
    # apron hang.
    head = eb["head"]
    nape = Vector((0, head.head.y + 0.08, head.head.z))
    for i in range(4):
        p = "head" if i == 0 else f"spring_{i:02d}"
        bone(f"spring_{i + 1:02d}", p, nape + Vector((0, 0, -0.04 * i)), nape + Vector((0, 0, -0.04 * (i + 1))))
    chest = eb["spine_03"]
    back = Vector((0, chest.head.y + 0.12, chest.head.z))
    for i in range(4):
        p = "spine_03" if i == 0 else f"spring_{i + 4:02d}"
        bone(f"spring_{i + 5:02d}", p, back + Vector((0, 0, -0.08 * i)), back + Vector((0, 0, -0.08 * (i + 1))))

    bpy.ops.object.mode_set(mode="OBJECT")
    for pb in arm.pose.bones:
        pb.rotation_mode = "QUATERNION"
    if len(arm.data.bones) != BONES:
        raise AssertionError(f"the skeleton has {len(arm.data.bones)} bones, not {BONES}")
    _weigh_correctors(human, arm)


def _on_section(skin, z, d):
    """The point of the body's section at height z furthest along the
    horizontal direction d, a little out from the skin."""
    band = skin[np.abs(skin[:, 2] - z) < 0.01]
    i = int(np.argmax(band[:, :2] @ d))
    p = band[i, :2] + d * 0.01
    return (float(p[0]), float(p[1]), float(z))


def _weigh_correctors(human, arm):
    """The hip correctors take the crease where pelvis and thigh both pull;
    the twist bones take the forearm's weight toward the wrist."""
    groups = {g.name: g for g in human.vertex_groups}
    for s in ("l", "r"):
        pelvis, thigh = groups["pelvis"], groups["thigh_" + s]
        corr = human.vertex_groups.new(name="thigh_corrector_" + s)
        fore = groups["lowerarm_" + s]
        twist = human.vertex_groups.new(name="lowerarm_twist_" + s)
        b = arm.data.bones["lowerarm_" + s]
        h, t = b.head_local, b.tail_local
        axis = t - h
        for v in human.data.vertices:
            w = {g.group: g.weight for g in v.groups}
            wp, wt = w.get(pelvis.index, 0.0), w.get(thigh.index, 0.0)
            if wp > 0 and wt > 0:
                c = min(wp, wt)
                pelvis.add([v.index], wp - c / 2, "REPLACE")
                thigh.add([v.index], wt - c / 2, "REPLACE")
                corr.add([v.index], c, "REPLACE")
            wf = w.get(fore.index, 0.0)
            if wf > 0:
                u = (v.co - h).dot(axis) / axis.length_squared
                share = _smoothstep(0.25, 0.85, u)
                if share > 0:
                    fore.add([v.index], wf * (1 - share), "REPLACE")
                    twist.add([v.index], wf * share, "REPLACE")


def _smoothstep(a, b, x):
    t = min(max((x - a) / (b - a), 0.0), 1.0)
    return t * t * (3 - 2 * t)


def bone_names(arm):
    """The deforming and socket bones, in the armature's order."""
    return [b.name for b in arm.data.bones]


def limit_weights(obj, bones, most=4):
    """Each vertex's weights on the skeleton's bones: at most the strongest
    four, summing to one. Vertices with none fail the build."""
    index = {g.index: g.name for g in obj.vertex_groups if g.name in bones}
    groups = {g.name: g for g in obj.vertex_groups}
    bare = 0
    plan = []
    for v in obj.data.vertices:
        ws = sorted(((g.weight, g.group) for g in v.groups if g.group in index), reverse=True)
        strong = [(w, gi) for w, gi in ws if w > 1e-4][:most]
        if not strong:
            bare += 1
            continue
        total = sum(w for w, _ in strong)
        kept = {gi for _, gi in strong}
        plan.append((v.index, [(gi, w / total) for w, gi in strong], [gi for _, gi in ws if gi not in kept]))
    # Changed after reading: a vertex's groups are not to be edited while
    # they are walked.
    for i, keep, drop in plan:
        for gi in drop:
            groups[index[gi]].remove([i])
        for gi, w in keep:
            groups[index[gi]].add([i], w, "REPLACE")
    if bare:
        raise AssertionError(f"{obj.name}: {bare} vertices are weighted to no bone")
    # Groups that are not bones are left out of the export by having none.
    for g in list(obj.vertex_groups):
        if g.name not in bones:
            obj.vertex_groups.remove(g)


def select(obj):
    bpy.ops.object.mode_set(mode="OBJECT") if bpy.context.object and bpy.context.object.mode != "OBJECT" else None
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
