# Releasing

`deno task release` does everything: checks, review gating, and the push (beta
channel by default; `--channel rc|stable` overrides). Release notes are the
CHANGELOG.md entry for the manifest version. Every push wants an
adversarial-review report keyed to a content hash of the published files
(models, reports, README, LICENSE, manifest, deno.json/lock) — any change to
those means a fresh review. Reports are per-release artifacts in `reviews/`
(gitignored); the task sets `SWAMP_EXTENSION_REVIEW_DIR` itself.

1. Add a `## <version>` entry to `CHANGELOG.md`; bump `version` in
   `manifest.yaml` and in each model
   (`swamp extension version --manifest manifest.yaml --json` prints the next).
2. `deno task release` — fmt/lint/types/tests, docs regen, manifest,
   version-bump, and release-notes checks, quality score, push dry-run. When no
   review exists for the current content it writes a skeleton into `reviews/`,
   prints the path, and exits non-zero.
3. Review the code, then hand-edit that file: set each dimension's verdict to
   `pass`, `issue` (with a note — surfaces as a non-blocking push warning), or
   `na`.
4. Re-run `deno task release` — when everything passes it shows the exact push
   command and asks for confirmation before pushing. Decline and it leaves you
   the command to run manually.
