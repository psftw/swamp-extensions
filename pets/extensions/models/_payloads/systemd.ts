// GENERATED from payloads/systemd.py — edit that file and run `deno task gen`.
/** Python source of payloads/systemd.py, embedded verbatim. */
export const source: string =
  `"""systemd unit facts and apply for @psftw/pets/systemd.

Facts come from
\`systemctl show -p\` key=value properties, not human-facing keywords.
"""
import json
import subprocess

# BEGIN GENERATED TYPES — edit extensions/models/_lib/cfg.ts and run \`deno task gen\`.
from typing import TypedDict


class CheckCfg(TypedDict):
    service: str


class ApplyCfg(TypedDict):
    service: str
    enabled: bool
    running: bool
# END GENERATED TYPES


def gather(cfg: CheckCfg):
    r = subprocess.run(
        [
            "systemctl",
            "show",
            cfg["service"],
            "--property=UnitFileState",
            "--property=ActiveState",
        ],
        capture_output=True,
        text=True,
    )
    props = dict(
        line.split("=", 1)
        for line in r.stdout.splitlines()
        if "=" in line
    )
    return {
        "unitFileState": props.get("UnitFileState", ""),
        "activeState": props.get("ActiveState", ""),
    }


def check(cfg: CheckCfg):
    print(json.dumps(gather(cfg)))


def apply(cfg: ApplyCfg):
    err = None
    cur = gather(cfg)
    steps = []
    if (cur["unitFileState"] == "enabled") != cfg["enabled"]:
        steps.append("enable" if cfg["enabled"] else "disable")
    if (cur["activeState"] == "active") != cfg["running"]:
        steps.append("start" if cfg["running"] else "stop")
    performed = []
    for s in steps:
        r = subprocess.run(
            ["systemctl", s, cfg["service"]], capture_output=True, text=True
        )
        if r.returncode != 0:
            err = ("systemctl " + s + " failed: " + r.stderr.strip())[:2000]
            break
        performed.append(s)
    out = gather(cfg)
    out["error"] = err
    out["performed"] = performed
    print(json.dumps(out))
`;
