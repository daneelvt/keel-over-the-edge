# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""Woven patterns: a garment's cloth checked or striped in the atlas.

A pattern is painted by the bake (atlas.PAINTERS), from where each point of
the garment is on the figure at rest, not from its UVs: the bands keep their
width across the islands' seams and their stretch. Round the body a band's
place is its azimuth about the torso's middle, or about a leg's (stripes
down a pair of slops), times a radius, so a band is as wide all round and
the bands meet at the seam at the back.

- check: two sets of bands, across and down; where one crosses the other
  the colour is full, where one goes alone half: a gingham. Its colour is
  the main colour (the mask's red, a share where the bands are half) on
  the ground's own colour.
- stripes: bands down the cloth, in their own colour on the ground's (a
  fixed part), or in the main colour.

A pattern's params: kind, period (metres from one band to the next),
band (the share of the period a band takes), soft (the share its edges
take), ground (the colour between the bands), colour (the stripes', when
fixed), radius (of the circle the azimuth is measured on), legs (true:
about each leg, x the leg's middle from the figure's).
"""

import numpy as np

import atlas
import face

_PATTERNS = {}


def paint(material, p):
    """Marks a garment's material to be painted with its pattern."""
    if p.get("kind") not in ("check", "stripes"):
        raise ValueError(f"{material.name}: no pattern {p.get('kind')!r}")
    _PATTERNS[material.name] = p
    material["part_painter"] = "pattern"


def _bands(ex, t, period, band, soft):
    """1 within a band and 0 between, its edges soft: bands of the share
    band of each period, about t = 0 mod period."""
    f = ex.math("FRACT", t * (1.0 / period))
    # 0 at a band's middle, 0.5 midway between two.
    d = (f - 0.5).abs()
    d = 0.5 - d
    return 1 - ex.smooth(band / 2 - soft / 2, band / 2 + soft / 2, d)


def _round(period, radius):
    """The radius nearest the one asked on which a whole number of periods
    go round."""
    n = max(1, round(2 * np.pi * radius / period))
    return n * period / (2 * np.pi)


def painter(nt, material, what):
    p = _PATTERNS[material.name]
    ex = face.Expr(nt)
    x, y, z = ex.position()
    period = p.get("period", 0.05)
    band = p.get("band", 0.4)
    soft = p.get("soft", 0.1)
    if p.get("legs"):
        # About each leg's middle: its distance out from the figure's.
        lx = x.abs() - p["legs"]
        radius = _round(period, p.get("radius", 0.08))
        u = ex.atan2(lx, -y) * radius
    else:
        radius = _round(period, p.get("radius", 0.15))
        u = ex.atan2(x, -y) * radius
    down = _bands(ex, u, period, band, soft)
    ground = atlas.linear(p.get("ground", "#E8E2D2"))
    if p["kind"] == "check":
        across = _bands(ex, z, period, band, soft)
        share = (down + across) * 0.5
    else:
        share = down
    main = p["kind"] == "check" or p.get("colour") is None
    if what == "mask":
        return ex.combine(share, 0, 0) if main else ex.rgb(0, 0, 0)
    under = (atlas.NEUTRAL,) * 3 if main else atlas.linear(p["colour"])
    return ex.mix(ex.rgb(*ground), ex.rgb(*under), share)


atlas.PAINTERS["pattern"] = painter
