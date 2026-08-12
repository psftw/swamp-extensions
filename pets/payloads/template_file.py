"""Templated file facts and apply for @psftw/pets/template-file.

apply stages to a same-directory temp file,
validates it as $FILE, installs atomically via os.replace, and runs
onChange only when the content hash changed.
"""
import base64
import grp
import hashlib
import json
import os
import pwd
import shutil
import subprocess
import tempfile

# BEGIN GENERATED TYPES — edit extensions/models/_lib/cfg.ts and run `deno task gen`.
from typing import TypedDict


class CheckCfg(TypedDict):
    path: str


class ApplyCfg(TypedDict):
    path: str
    contentB64: str
    owner: str
    group: str
    modeInt: int
    validateCommand: str | None
    onChange: str | None
# END GENERATED TYPES


def gather(cfg: CheckCfg):
    if not os.path.isfile(cfg["path"]):
        return {"exists": False}
    st = os.stat(cfg["path"])
    try:
        owner = pwd.getpwuid(st.st_uid).pw_name
    except KeyError:
        owner = str(st.st_uid)
    try:
        group = grp.getgrgid(st.st_gid).gr_name
    except KeyError:
        group = str(st.st_gid)
    with open(cfg["path"], "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    return {
        "exists": True,
        "hash": digest,
        "owner": owner,
        "group": group,
        "mode": st.st_mode & 0o7777,
    }


def check(cfg: CheckCfg):
    print(json.dumps(gather(cfg)))


def _install(cfg: ApplyCfg, content):
    d = os.path.dirname(cfg["path"])
    prefix = "." + os.path.basename(cfg["path"]) + "."
    fd, tmp = tempfile.mkstemp(dir=d, prefix=prefix)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(content)
        if cfg["validateCommand"]:
            env = dict(os.environ, FILE=tmp)
            r = subprocess.run(
                cfg["validateCommand"],
                shell=True,
                env=env,
                capture_output=True,
                text=True,
            )
            if r.returncode != 0:
                raise RuntimeError("validate failed: " + r.stderr.strip()[:1000])
        cur = gather(cfg)
        shutil.chown(tmp, cfg["owner"], cfg["group"])
        os.chmod(tmp, cfg["modeInt"])
        if cur.get("hash") == hashlib.sha256(content).hexdigest():
            os.unlink(tmp)
            performed = []
            if (cur.get("owner"), cur.get("group")) != (
                cfg["owner"],
                cfg["group"],
            ):
                shutil.chown(cfg["path"], cfg["owner"], cfg["group"])
                performed.append(
                    "chown " + cfg["owner"] + ":" + cfg["group"] + " " + cfg["path"]
                )
            if cur.get("mode") != cfg["modeInt"]:
                os.chmod(cfg["path"], cfg["modeInt"])
                performed.append("chmod " + oct(cfg["modeInt"]) + " " + cfg["path"])
            return False, performed
        os.replace(tmp, cfg["path"])
        return True, ["write " + cfg["path"]]
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def apply(cfg: ApplyCfg):
    err = None
    changed = False
    performed = []
    try:
        changed, performed = _install(cfg, base64.b64decode(cfg["contentB64"]))
        if changed and cfg["onChange"]:
            r = subprocess.run(
                cfg["onChange"], shell=True, capture_output=True, text=True
            )
            if r.returncode != 0:
                err = ("onChange failed: " + r.stderr.strip())[:2000]
    except Exception as e:
        err = err or str(e)[:2000]
    out = gather(cfg)
    out["changed"] = changed
    out["performed"] = performed
    out["error"] = err
    print(json.dumps(out))
