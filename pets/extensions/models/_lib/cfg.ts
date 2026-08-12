/**
 * Wire contracts for the payload boundary, both directions. Outbound: cfg
 * schemas that pyScript parses before serialization and that `deno task gen`
 * emits as TypedDict blocks into payloads/*.py (checked by
 * `deno task typecheck:py`). Inbound: facts schemas that fleetFacts parses
 * per host, mirroring exactly what each payload entry point prints.
 */
import { z } from "npm:zod@4";

/** Cfg for payloads/apt.py — both entry points take the package list. */
export const aptCfg = z.object({
  packages: z.array(z.string()),
});

/** Cfg for apt_repository.py check. */
export const aptRepositoryCheckCfg = z.object({
  path: z.string(),
  signedBy: z.string().nullable(),
});

/** Cfg for apt_repository.py apply — adds rendered content and key source. */
export const aptRepositoryApplyCfg = aptRepositoryCheckCfg.extend({
  contentB64: z.string(),
  gpgKeyUrl: z.string().nullable(),
});

/** One directory spec inside directoryCfg (emitted as its own TypedDict). */
export const dirCfg = z.object({
  path: z.string(),
  owner: z.string(),
  group: z.string(),
  modeInt: z.int(),
});

/** Cfg for payloads/directory.py — the full managed-directory list. */
export const directoryCfg = z.object({
  dirs: z.array(dirCfg),
});

/** Cfg for payloads/group_member.py — the managed (user, group) pair. */
export const groupMemberCfg = z.object({
  username: z.string(),
  group: z.string(),
});

/** Cfg for systemd.py check. */
export const systemdCheckCfg = z.object({
  service: z.string(),
});

/** Cfg for systemd.py apply — adds the desired unit state. */
export const systemdApplyCfg = systemdCheckCfg.extend({
  enabled: z.boolean(),
  running: z.boolean(),
});

/** Cfg for template_file.py check. */
export const templateFileCheckCfg = z.object({
  path: z.string(),
});

/** Cfg for template_file.py apply — adds content, ownership, and hooks. */
export const templateFileApplyCfg = templateFileCheckCfg.extend({
  contentB64: z.string(),
  owner: z.string(),
  group: z.string(),
  modeInt: z.int(),
  validateCommand: z.string().nullable(),
  onChange: z.string().nullable(),
});

/** Facts from apt.py check: per-package status + no-candidate packages. */
export const aptCheckFacts = z.object({
  status: z.record(z.string(), z.string()),
  unavailable: z.array(z.string()),
});

/** Facts from apt.py apply: post-install status and what was installed. */
export const aptApplyFacts = z.object({
  status: z.record(z.string(), z.string()),
  installed: z.array(z.string()),
  error: z.string().nullable(),
});

/** Facts from apt_repository.py check: sources hash and key presence. */
export const aptRepositoryCheckFacts = z.object({
  fileHash: z.string().nullable(),
  keyPresent: z.boolean(),
});

/** Facts from apt_repository.py apply: what was written and fetched. */
export const aptRepositoryApplyFacts = aptRepositoryCheckFacts.extend({
  wroteSources: z.boolean(),
  fetchedKey: z.boolean(),
  error: z.string().nullable(),
});

/** One directory's observed state inside directoryCheckFacts. */
export const dirFact = z.object({
  path: z.string(),
  state: z.enum(["absent", "dir", "other"]),
  owner: z.string().optional(),
  group: z.string().optional(),
  mode: z.int().optional(),
});

/** Facts from directory.py check. */
export const directoryCheckFacts = z.object({ dirs: z.array(dirFact) });

/** Facts from directory.py apply: operations actually performed. */
export const directoryApplyFacts = directoryCheckFacts.extend({
  performed: z.array(z.string()),
  error: z.string().nullable(),
});

/** Facts from group_member.py check. */
export const groupMemberCheckFacts = z.object({
  userExists: z.boolean(),
  member: z.boolean(),
  groups: z.array(z.string()),
});

/** Facts from group_member.py apply. */
export const groupMemberApplyFacts = groupMemberCheckFacts.extend({
  changed: z.boolean(),
  error: z.string().nullable(),
});

/** Facts from systemd.py check: raw `systemctl show` property values. */
export const systemdCheckFacts = z.object({
  unitFileState: z.string(),
  activeState: z.string(),
});

/** Facts from systemd.py apply: systemctl actions actually performed. */
export const systemdApplyFacts = systemdCheckFacts.extend({
  performed: z.array(z.string()),
  error: z.string().nullable(),
});

/** Facts from template_file.py check: existence, hash, ownership, mode. */
export const templateFileCheckFacts = z.object({
  exists: z.boolean(),
  hash: z.string().optional(),
  owner: z.string().optional(),
  group: z.string().optional(),
  mode: z.int().optional(),
});

/** Facts from template_file.py apply. */
export const templateFileApplyFacts = templateFileCheckFacts.extend({
  changed: z.boolean(),
  error: z.string().nullable(),
});

/**
 * TypedDict blocks per payload module, name → schema in emission order.
 * Object schemas nested inside another (by reference) must be listed
 * before their container so fields can name them. Cfg only — facts flow
 * the other way; Python is their producer, not their consumer.
 */
export const payloadTypes: Record<string, Record<string, z.ZodObject>> = {
  apt: { Cfg: aptCfg },
  apt_repository: {
    CheckCfg: aptRepositoryCheckCfg,
    ApplyCfg: aptRepositoryApplyCfg,
  },
  directory: { Dir: dirCfg, Cfg: directoryCfg },
  group_member: { Cfg: groupMemberCfg },
  systemd: { CheckCfg: systemdCheckCfg, ApplyCfg: systemdApplyCfg },
  template_file: {
    CheckCfg: templateFileCheckCfg,
    ApplyCfg: templateFileApplyCfg,
  },
};
