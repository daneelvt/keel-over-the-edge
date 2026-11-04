# SPDX-License-Identifier: LicenseRef-All-Rights-Reserved
"""The sailors' build, as Blender runs it: blender -b --python main.py --
job.json (tools/sailors writes the job and runs this).

Each version of the look is built alone in an emptied scene: the body,
the skeleton, the proxy, the garments, the hair and hat, the atlas, the
levels and the export, each level judged by the gates; its clips; then
its report, the gates' measures and the review sheets. A gate that fails
fails the build, after all of it is written.
"""

import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(1, os.path.join(os.path.dirname(HERE), "review"))

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
        for clip, m in r["clips"].items():
            failed = [g for g, x in m.items() if isinstance(x, dict) and not x.get("ok", True)]
            print(f"    {clip}: {m['frames']} frames in {m['seconds']} s" + (f", failed {', '.join(failed)}" if failed else ""))
    print(f"  the sheets in {report['sheet seconds']} s, in {report['path']}")
    worse = [c for c in report["changes"] if c.endswith("(worse)")]
    print(f"  since the last run: {len(report['changes'])} gates moved, {len(worse)} for the worse")
    for c in worse:
        print(f"    {c}")
    if report["failures"]:
        if job["look"].get("gates") == "report":
            print("  the gates that failed, reported only (a check of the build's machinery):\n    " +
                  "\n    ".join(report["failures"]))
        else:
            raise AssertionError("the gates failed:\n  " + "\n  ".join(report["failures"]))


main()
