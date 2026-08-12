# Changelog

## 2026.08.12.4

Fix: `template-file` apply converged owner/group/mode silently when the content
hash already matched, reporting `compliant` with no changes recorded. It now
touches owner/mode only when drifted, reports the run as `applied`, and records
each chown/chmod in `changes`; apply facts gained a `performed` list. `changed`
still means content changed, so `onChange` semantics are unaffected.

## 2026.08.12.3

Fix: `template-file` and `apt-repository` apply encoded staged content with bare
`btoa`, which throws on non-Latin1 characters (e.g. an em dash in a template)
and would corrupt 0x80–0xFF characters relative to the UTF-8 content hash.
Content is now base64-encoded over UTF-8 bytes.

## 2026.08.12.2

Manifest description no longer contains generated API reference.

## 2026.08.12.1

Initial release.
