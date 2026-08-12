"""Directory facts and apply for @psftw/pets/directory.

Modes travel as integers (modeInt) so no octal-string comparison can
drift. apply refuses non-directory paths.
"""
import grp
import json
import os
import pwd
import shutil
import stat

# BEGIN GENERATED TYPES — edit extensions/models/_lib/cfg.ts and run `deno task gen`.
from typing import TypedDict


class Dir(TypedDict):
    path: str
    owner: str
    group: str
    modeInt: int


class Cfg(TypedDict):
    dirs: list[Dir]
# END GENERATED TYPES


def _owner_group(st):
    try:
        o = pwd.getpwuid(st.st_uid).pw_name
    except KeyError:
        o = str(st.st_uid)
    try:
        g = grp.getgrgid(st.st_gid).gr_name
    except KeyError:
        g = str(st.st_gid)
    return o, g


def gather(cfg: Cfg):
    res = []
    for d in cfg["dirs"]:
        e: dict[str, object] = {"path": d["path"]}
        try:
            st = os.stat(d["path"], follow_symlinks=False)
        except FileNotFoundError:
            e["state"] = "absent"
        else:
            e["state"] = "dir" if stat.S_ISDIR(st.st_mode) else "other"
            e["mode"] = st.st_mode & 0o7777
            e["owner"], e["group"] = _owner_group(st)
        res.append(e)
    return {"dirs": res}


def check(cfg: Cfg):
    print(json.dumps(gather(cfg)))


def apply(cfg: Cfg):
    err = None
    performed = []
    try:
        for d in cfg["dirs"]:
            p = d["path"]
            if os.path.exists(p) and not os.path.isdir(p):
                raise RuntimeError(p + " exists but is not a directory")
            if not os.path.isdir(p):
                os.makedirs(p)
                performed.append("created " + p)
            st = os.stat(p, follow_symlinks=False)
            owner, group = _owner_group(st)
            if (owner, group) != (d["owner"], d["group"]):
                shutil.chown(p, d["owner"], d["group"])
                performed.append(
                    "chown " + d["owner"] + ":" + d["group"] + " " + p
                )
            if st.st_mode & 0o7777 != d["modeInt"]:
                os.chmod(p, d["modeInt"])
                performed.append("chmod " + oct(d["modeInt"]) + " " + p)
    except Exception as e:
        err = str(e)[:2000]
    out = gather(cfg)
    out["error"] = err
    out["performed"] = performed
    print(json.dumps(out))
