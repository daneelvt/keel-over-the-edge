# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""The build's inputs: only files listed in SOURCES.md are read.

tools/sailors checks every listed file's SHA-256 and licence before
Blender starts, and that every vendored file is listed; here a file not
listed is refused, so nothing unlisted can come in by a path in a look.
MPFB's own data comes with MPFB, which is pinned by its archive's SHA-256.
"""

import os

_sources = None
_root = None


def load(job):
    global _sources, _root
    _sources = job["sources"]
    _root = os.path.join(job["root"], "art", "sailors")


def path(name):
    """The absolute path of a listed input, by its path in art/sailors."""
    if _sources is None:
        raise RuntimeError("the inputs are not loaded")
    if name not in _sources:
        raise PermissionError(f"{name} is not in SOURCES.md: list it with its pack, licence and SHA-256")
    return os.path.join(_root, name)
