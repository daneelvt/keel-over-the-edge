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
each with its pack, licence and SHA-256. The bodies, rig, weights and
targets the build uses are MPFB's own, inside its pinned archive. Eyes and
face units come with the faces.

The motion clips are Quaternius' Universal Animation Library (CC0), bought
in its Source edition: only the clips the build uses are copied, each
into a file of its own with the library's skeleton and nothing else, by
`go run ./tools/sailors -vendor UAL1.glb -into quaternius -pack "..." -clips
Idle_Loop,...` from the edition's `Unreal-Godot/UAL1.glb` (SHA-256
d1cb4537efa4c06a953ca951e5935062f88c2580ac68e45045592d587bddb43d), which
prints their rows. The library's licence comes with them.

| File                                    | Pack                                                                    | Licence | SHA-256                                                          |
| --------------------------------------- | ----------------------------------------------------------------------- | ------- | ---------------------------------------------------------------- |
| `vendor/quaternius/License.txt`         | Quaternius, Universal Animation Library (Source)                        | CC0-1.0 | 6d01f55c6e4c49a2c9963e147e561945ae2c83958c8ca667d90a6bffdbfac061 |
| `vendor/quaternius/Crouch_Enter.glb`    | Quaternius, Universal Animation Library (Source), Unreal-Godot/UAL1.glb | CC0-1.0 | f27635721bd09875aa97199231330329f8e3a8c88cd4420bdbcc62eed7270324 |
| `vendor/quaternius/Crouch_Exit.glb`     | Quaternius, Universal Animation Library (Source), Unreal-Godot/UAL1.glb | CC0-1.0 | d716d7c8e117e2dba1531b0bb687e9a0a24e6c32240a5cb14de09b0ab36a871d |
| `vendor/quaternius/Crouch_Fwd_Loop.glb` | Quaternius, Universal Animation Library (Source), Unreal-Godot/UAL1.glb | CC0-1.0 | 23af7046ec0705111a1d6f78048abf11d373c62bcd27a15af713be39e2b70448 |
| `vendor/quaternius/Idle_Loop.glb`       | Quaternius, Universal Animation Library (Source), Unreal-Godot/UAL1.glb | CC0-1.0 | 7384c02bb4349e77206523e0d1b58a17b0f230f8596a6c270270eb5a889558d3 |
| `vendor/quaternius/Swim_Idle_Loop.glb`  | Quaternius, Universal Animation Library (Source), Unreal-Godot/UAL1.glb | CC0-1.0 | 9d1a8d48327c8bb05a9fb56323bf0836ac18e07665bbbf90c4379fb3897ca41e |
