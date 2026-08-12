"""Package presence facts and apply for @psftw/pets/apt.

Invoked over the fleet's python3 interpreter; the caller appends a single
entry-point call, e.g. check(json.loads(r'''{"packages": [...]}''')).
Every entry point prints exactly one JSON document to stdout.
"""
import json
import os
import subprocess

# BEGIN GENERATED TYPES — edit extensions/models/_lib/cfg.ts and run `deno task gen`.
from typing import TypedDict


class Cfg(TypedDict):
    packages: list[str]
# END GENERATED TYPES


def gather(cfg: Cfg):
    st = {}
    for p in cfg["packages"]:
        r = subprocess.run(
            ["dpkg-query", "-W", "-f", "${db:Status-Status}", p],
            capture_output=True,
            text=True,
        )
        s = r.stdout.strip()
        st[p] = s if r.returncode == 0 and s else "missing"
    return st


def _no_candidate(missing):
    """Packages apt has no record of — a typo, or a repo not yet configured.
    Detected via apt-cache exit code against the local index (no parsing)."""
    out = []
    for p in missing:
        r = subprocess.run(["apt-cache", "show", p], capture_output=True)
        if r.returncode != 0:
            out.append(p)
    return out


def check(cfg: Cfg):
    st = gather(cfg)
    missing = [p for p in cfg["packages"] if st[p] != "installed"]
    print(json.dumps({"status": st, "unavailable": _no_candidate(missing)}))


def apply(cfg: Cfg):
    """Install missing packages, refreshing the index first — a correct
    install requires a usable index, so freshness is this model's own
    precondition. Idempotent re-runs (nothing missing) touch nothing."""
    err = None
    st = gather(cfg)
    missing = [p for p in cfg["packages"] if st[p] != "installed"]
    if missing:
        env = dict(os.environ, DEBIAN_FRONTEND="noninteractive")
        r = subprocess.run(
            ["apt-get", "update"], capture_output=True, text=True, env=env
        )
        if r.returncode != 0:
            err = ("apt-get update failed: " + r.stderr.strip())[:2000]
        else:
            r = subprocess.run(
                ["apt-get", "install", "-y"] + missing,
                capture_output=True,
                text=True,
                env=env,
            )
            if r.returncode != 0:
                err = ("apt-get install failed: " + r.stderr.strip())[:2000]
    print(json.dumps({"status": gather(cfg), "installed": missing, "error": err}))
