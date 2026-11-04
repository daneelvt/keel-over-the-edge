# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""MPFB, called as a library, and the order a sailor is made in.

Blender imports an extension's modules under its repository's package
(bl_ext.user_default.mpfb...), and MPFB imports its own relatively, so its
services are found here by the end of their names. Only services and
entities are used: MPFB's operators need a window.

A sailor is made in one order, and each step once: the shape, the rig, the
extra bones, the proxy, the garments, the export. Fitting the rig again
after the shape changed drifts the bones' rolls, so nothing here refits.
"""

import os
import sys

STEPS = ("shape", "rig", "bones", "proxy", "garments", "export")


def module(suffix):
    """The MPFB module whose name ends in suffix, as services.humanservice."""
    for name, mod in sys.modules.items():
        if name.endswith(".mpfb." + suffix):
            return mod
    raise RuntimeError(f"MPFB's {suffix} is not loaded: is MPFB installed and enabled in the build's profile?")


def service(name):
    """An MPFB service class, as service("HumanService")."""
    return getattr(module("services." + name.lower()), name)


def entity(path, name):
    """An MPFB entity class, as entity("rig", "Rig")."""
    return getattr(module("entities." + path), name)


def data(*parts):
    """A file in MPFB's own data: its base mesh, rigs, weights and targets."""
    path = os.path.join(service("LocationService").get_mpfb_data(), *parts)
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    return path


def version():
    """MPFB's version, from its manifest."""
    root = os.path.dirname(os.path.dirname(module("services.humanservice").__file__))
    with open(os.path.join(root, "blender_manifest.toml"), encoding="utf8") as f:
        for line in f:
            if line.startswith("version = "):
                return line.split('"')[1]
    raise RuntimeError("MPFB's manifest names no version")


class Order:
    """The steps of one sailor, refused out of order or twice."""

    def __init__(self, name):
        self.name = name
        self.done = []

    def step(self, step):
        if step not in STEPS:
            raise ValueError(f"{self.name}: no step {step!r}")
        want = STEPS[len(self.done)] if len(self.done) < len(STEPS) else None
        if step != want:
            raise RuntimeError(f"{self.name}: {step} after {', '.join(self.done) or 'nothing'}: "
                               f"the order is {', '.join(STEPS)}, each once (never refit)")
        self.done.append(step)
