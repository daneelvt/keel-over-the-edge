# Sources

Everything the sailors' build reads that the game did not make itself.
The art is all rights reserved, so only CC0 inputs are allowed: nothing
that asks for credit, forbids selling, or was made by an AI service.
`tools/sailors` checks this file before Blender starts: each program's
row against its pin, each file's SHA-256 and licence, and that every
file under `vendor/` is listed. The build reads no input that is not.

## Programs

The programs run on the developer's machine only; neither is shipped.
MPFB's code is a build tool; its human, rigs, weights and targets are
CC0 (MakeHuman's licence: "free to do as you see fit with the asset or
derivates").

| Program  | Version | Licence                                       | From                                                                | SHA-256                                                          |
| -------- | ------- | --------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| MPFB     | 2.0.18  | GPL-3.0-or-later (code); CC0-1.0 (its assets) | extensions.blender.org, `add-on-mpfb-v2.0.18.zip`                   | c075b3e9b94b8e5556a5f03f4653602d02ea306de08126e8f55ed6dee28a2dad |
| gltfpack | 1.3     | MIT                                           | github.com/zeux/meshoptimizer, release `v1.3`, `gltfpack-macos.zip` | 1002fe6a437aa005eca541502c27b8d2b184f91f4ad0c6d282e3614a1e35e75a |

Blender itself (5.2 LTS, GPL-3.0-or-later) is installed by hand; the build
refuses another series.

## Files

Files from others, copied into `vendor/` because the build reads them:
each with its pack, licence and SHA-256. None yet: the bodies, rig,
weights and targets the build uses are MPFB's own, inside its pinned
archive. Eyes, face units and the motion clips come with the faces and
the motion.

| File | Pack | Licence | SHA-256 |
| ---- | ---- | ------- | ------- |
