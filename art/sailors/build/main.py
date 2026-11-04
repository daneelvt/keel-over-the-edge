# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""The sailors' build, as Blender runs it: blender -b --python main.py --
job.json (tools/sailors writes the job and runs this).

Each version of the look is built alone in an emptied scene: the body,
the skeleton, the proxy, the garments, the hair and hat, the atlas, the
levels and the export, then its report.
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import sailor  # noqa: E402


def main():
    args = sys.argv[sys.argv.index("--") + 1:]
    if len(args) != 1:
        raise SystemExit("usage: blender -b --python main.py -- job.json")
    with open(args[0], encoding="utf8") as f:
        job = json.load(f)
    start = time.time()
    report = sailor.build_look(job)
    print(f"build: {job['look']['id']} in {time.time() - start:.1f} s")
    for version, r in report["versions"].items():
        print(f"  {version}: " + ", ".join(f"{k} {v}" for k, v in r["summary"].items()))


main()
