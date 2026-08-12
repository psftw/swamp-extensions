// GENERATED from payloads/group_member.py — edit that file and run `deno task gen`.
/** Python source of payloads/group_member.py, embedded verbatim. */
export const source: string =
  `"""Append-only group membership facts and apply for @psftw/pets/group-member.

apply appends with usermod -aG and never removes.
"""
import grp
import json
import pwd
import subprocess

# BEGIN GENERATED TYPES — edit extensions/models/_lib/cfg.ts and run \`deno task gen\`.
from typing import TypedDict


class Cfg(TypedDict):
    username: str
    group: str
# END GENERATED TYPES


def gather(cfg: Cfg):
    try:
        pw = pwd.getpwnam(cfg["username"])
    except KeyError:
        return {"userExists": False, "member": False, "groups": []}
    names = {g.gr_name for g in grp.getgrall() if cfg["username"] in g.gr_mem}
    try:
        names.add(grp.getgrgid(pw.pw_gid).gr_name)
    except KeyError:
        pass
    return {
        "userExists": True,
        "member": cfg["group"] in names,
        "groups": sorted(names),
    }


def check(cfg: Cfg):
    print(json.dumps(gather(cfg)))


def apply(cfg: Cfg):
    err = None
    changed = False
    cur = gather(cfg)
    if not cur["userExists"]:
        err = "user " + cfg["username"] + " not found"
    elif not cur["member"]:
        r = subprocess.run(
            ["usermod", "-aG", cfg["group"], cfg["username"]],
            capture_output=True,
            text=True,
        )
        if r.returncode != 0:
            err = ("usermod -aG failed: " + r.stderr.strip())[:2000]
        else:
            changed = True
    out = gather(cfg)
    out["changed"] = changed
    out["error"] = err
    print(json.dumps(out))
`;
