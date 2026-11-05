# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""Where things are on a body, and its measurements.

Everything is found from the mesh: MPFB's joint markers (the helper cubes
its rigs are fitted to) and fixed vertices of its base mesh, whose
numbering is the same for every body. Widths are read in the front view
from horizontal sections: the outline round the spine, so that an arm
hanging apart from the torso is left out. Metres, z up, the face toward
-y.
"""

import numpy as np

import body

# The chin's point (the menton): the vertex MPFB's default rig ends its jaw
# at.
CHIN = 991

# The step between slices.
SLICE = 0.006


class Section:
    """A mesh cut by horizontal planes: its outlines at a height."""

    def __init__(self, co, edges, face_edges):
        self.co = co
        # The edges cut, each a vertex pair.
        self.edges = edges
        # (face, edge) pairs: two edges a plane crosses in one face are on
        # one outline.
        self.face_edges = face_edges

    @staticmethod
    def of(obj, mask=None):
        me = obj.data
        co = body.coords(obj)
        e = np.empty(len(me.edges) * 2, np.int32)
        me.edges.foreach_get("vertices", e)
        e = e.reshape(-1, 2)
        loop_edge = np.empty(len(me.loops), np.int32)
        me.loops.foreach_get("edge_index", loop_edge)
        start = np.empty(len(me.polygons), np.int32)
        total = np.empty(len(me.polygons), np.int32)
        me.polygons.foreach_get("loop_start", start)
        me.polygons.foreach_get("loop_total", total)
        face = np.repeat(np.arange(len(me.polygons)), total)
        pairs = np.stack([face, loop_edge], 1)
        if mask is not None:
            keep = mask[e[:, 0]] & mask[e[:, 1]]
            pairs = pairs[keep[pairs[:, 1]]]
            # Renumber the edges kept.
            new = np.full(len(e), -1, np.int64)
            new[keep] = np.arange(keep.sum())
            e = e[keep]
            pairs[:, 1] = new[pairs[:, 1]]
        return Section(co, e, pairs)

    @staticmethod
    def of_many(objs):
        """One section of several meshes, as they stand at rest."""
        parts = [Section.of(o) for o in objs]
        co, edges, pairs = [], [], []
        nv = ne = nf = 0
        for o, p in zip(objs, parts):
            co.append(p.co)
            edges.append(p.edges + nv)
            pairs.append(p.face_edges + np.array([nf, ne]))
            nv += len(p.co)
            ne += len(p.edges)
            nf += len(o.data.polygons)
        return Section(np.concatenate(co), np.concatenate(edges), np.concatenate(pairs))

    def outlines(self, z):
        """The outlines at z: lists of points (x, y)."""
        a, b = self.co[self.edges[:, 0]], self.co[self.edges[:, 1]]
        cross = (a[:, 2] - z) * (b[:, 2] - z) < 0
        pairs = self.face_edges[cross[self.face_edges[:, 1]]]
        if len(pairs) == 0:
            return []
        idx = np.flatnonzero(cross)
        where = {int(ei): i for i, ei in enumerate(idx)}
        t = (z - a[idx, 2]) / (b[idx, 2] - a[idx, 2])
        pts = a[idx, :2] + (b[idx, :2] - a[idx, :2]) * t[:, None]
        parent = list(range(len(idx)))

        def find(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        order = np.argsort(pairs[:, 0], kind="stable")
        pairs = pairs[order]
        for k in range(1, len(pairs)):
            if pairs[k, 0] == pairs[k - 1, 0]:
                parent[find(where[int(pairs[k, 1])])] = find(where[int(pairs[k - 1, 1])])
        roots = np.array([find(i) for i in range(len(idx))])
        return [pts[roots == r] for r in sorted(set(roots.tolist()))]

    def outline(self, z, near=(0.0, 0.0)):
        """The outline at z that holds the point near, the torso's, so an
        arm hanging apart is left out (the outermost, if several do); or
        else the nearest."""
        best, dist = np.empty((0, 2)), np.inf
        for o in self.outlines(z):
            inside = o[:, 0].min() <= near[0] <= o[:, 0].max() and o[:, 1].min() <= near[1] <= o[:, 1].max()
            # Of the outlines round it (skin within cloth), the outermost.
            d = -float(np.ptp(o[:, 0])) if inside else float(np.hypot(*(o.mean(0) - np.array(near))))
            if d < dist:
                best, dist = o, d
        return best

    def width(self, z, near=(0.0, 0.0)):
        o = self.outline(z, near)
        return 0.0 if len(o) == 0 else float(o[:, 0].max() - o[:, 0].min())

    def depth(self, z, near=(0.0, 0.0)):
        """How far the outline at z comes forward: its least y."""
        o = self.outline(z, near)
        return None if len(o) == 0 else float(o[:, 1].min())


class Landmarks:
    def __init__(self, obj):
        co = body.coords(obj)
        skin = body.in_group(obj, "body")
        self.skin = co[skin]
        self.section = Section.of(obj, skin)
        self.joints = {}
        for g in obj.vertex_groups:
            if g.name.startswith("joint-"):
                self.joints[g.name[len("joint-"):]] = co[body.in_group(obj, g.name)].mean(0)
        self.chin = co[CHIN]

    def joint(self, name):
        return self.joints[name]

    def crown(self):
        return float(self.skin[:, 2].max())

    def crotch(self):
        """The lowest point of the body's midline between the legs."""
        mid = self.skin[(np.abs(self.skin[:, 0]) < 0.003) & (self.skin[:, 2] < self.joint("spine-3")[2])]
        return float(mid[:, 2].min())

    def bust(self):
        """The bust's apex: where the chest comes furthest forward between
        the waist and the shoulders. Its height, its distance from the
        middle, and how far forward it is (its y)."""
        skin = self.skin
        lo, hi = self.measure()["heights"]["waist"], self.joint("l-shoulder")[2]
        band = skin[(skin[:, 2] > lo) & (skin[:, 2] < hi) & (np.abs(skin[:, 0]) < 0.15)]
        i = int(np.argmin(band[:, 1]))
        return float(band[i, 2]), float(abs(band[i, 0])), float(band[i, 1])

    def near(self, z):
        """The torso's middle at height z: the spine's joints, interpolated."""
        spine = sorted((self.joint(n) for n in ("pelvis", "spine-3", "spine-2", "spine-1", "neck")), key=lambda p: p[2])
        zs = [p[2] for p in spine]
        return (0.0, float(np.interp(z, zs, [p[1] for p in spine])))

    def _scan(self, lo, hi, pick):
        zs = np.arange(lo, hi, SLICE)
        w = [self.section.width(z, self.near(z)) for z in zs]
        i = int(pick(w))
        return w[i], float(zs[i])

    def measure(self, dressed=None):
        """The body's measurements; with dressed (a Section of the dressed
        figure), the dressed widths at the bare body's heights."""
        crown = self.crown()
        shoulder = self.joint("l-shoulder")[2]
        waist, waist_z = self._scan(self.joint("spine-3")[2], self.joint("spine-1")[2] - 0.04, np.argmin)
        hip, hip_z = self._scan(self.crotch() + 0.01, self.joint("spine-3")[2], np.argmax)
        # Above the armpit, so the arms hanging in the rest pose are apart.
        shoulders, shoulder_z = self._scan(shoulder + 0.02, shoulder + 0.05, np.argmax)
        m = {
            "height": crown,
            "head": crown - float(self.chin[2]),
            "heads": crown / (crown - float(self.chin[2])),
            "shoulder": shoulders,
            "waist": waist,
            "hip": hip,
            "heights": {"shoulder": shoulder_z, "waist": waist_z, "hip": hip_z},
        }
        if dressed is not None:
            for k in ("shoulder", "waist", "hip"):
                z = m["heights"][k]
                m[k] = dressed.width(z, self.near(z))
        m["waist-to-hip"] = m["waist"] / m["hip"]
        m["shoulder-to-hip"] = m["shoulder"] / m["hip"]
        return m


def assert_measures(name, m, want):
    """Fails the build on a measurement outside its range."""
    bad = []
    for key, (lo, hi) in want.items():
        if not lo <= m[key] <= hi:
            bad.append(f"{key} {m[key]:.3f} outside {lo}–{hi}")
    if bad:
        raise AssertionError(f"{name}: " + "; ".join(bad))
