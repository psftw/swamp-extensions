"""Deb822 apt source + signing key facts and apply for @psftw/pets/apt-repository.

Keys ending in .asc are stored armored as-is (official Docker Debian docs).
"""
import base64
import hashlib
import json
import os
import subprocess
import tempfile
import urllib.request

# BEGIN GENERATED TYPES — edit extensions/models/_lib/cfg.ts and run `deno task gen`.
from typing import TypedDict


class CheckCfg(TypedDict):
    path: str
    signedBy: str | None


class ApplyCfg(TypedDict):
    path: str
    signedBy: str | None
    contentB64: str
    gpgKeyUrl: str | None
# END GENERATED TYPES


def gather(cfg: CheckCfg):
    out: dict[str, object] = {"fileHash": None, "keyPresent": True}
    if os.path.isfile(cfg["path"]):
        with open(cfg["path"], "rb") as f:
            out["fileHash"] = hashlib.sha256(f.read()).hexdigest()
    if cfg["signedBy"]:
        out["keyPresent"] = (
            os.path.isfile(cfg["signedBy"]) and os.path.getsize(cfg["signedBy"]) > 0
        )
    return out


def check(cfg: CheckCfg):
    print(json.dumps(gather(cfg)))


def _install(dest: str, data: bytes):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(dest))
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.chmod(tmp, 0o644)
        os.replace(tmp, dest)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def _fetch_key(signed: str, url: str):
    d = os.path.dirname(signed)
    os.makedirs(d, exist_ok=True)
    os.chmod(d, 0o755)
    data = urllib.request.urlopen(url, timeout=30).read()
    if not signed.endswith(".asc"):
        r = subprocess.run(["gpg", "--dearmor"], input=data, capture_output=True)
        if r.returncode != 0:
            raise RuntimeError("gpg --dearmor failed: " + r.stderr.decode()[:500])
        data = r.stdout
    _install(signed, data)


def apply(cfg: ApplyCfg):
    err = None
    wrote_sources = False
    fetched_key = False
    try:
        facts = gather(cfg)
        if cfg["signedBy"] and cfg["gpgKeyUrl"] and not facts["keyPresent"]:
            _fetch_key(cfg["signedBy"], cfg["gpgKeyUrl"])
            fetched_key = True
        content = base64.b64decode(cfg["contentB64"])
        if facts["fileHash"] != hashlib.sha256(content).hexdigest():
            _install(cfg["path"], content)
            wrote_sources = True
    except Exception as e:
        err = str(e)[:2000]
    out = gather(cfg)
    out["wroteSources"] = wrote_sources
    out["fetchedKey"] = fetched_key
    out["error"] = err
    print(json.dumps(out))
