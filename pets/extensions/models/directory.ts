import { z } from "npm:zod@4";
import {
  errorMessage,
  type FleetContext,
  fleetFacts,
  logHostStatus,
  normalizeMode,
  nowIso,
  pyScript,
  type WriteResourceFn,
} from "./_lib/fleet.ts";
import { source as directoryPy } from "./_payloads/directory.ts";
import {
  directoryApplyFacts,
  directoryCfg,
  directoryCheckFacts,
  dirFact,
} from "./_lib/cfg.ts";

const NAME_RE = /^[a-z_][a-z0-9_-]*\$?$/;

const DirSchema = z.object({
  path: z.string().startsWith("/").describe("Absolute directory path"),
  owner: z.string().regex(NAME_RE).describe("Owning user"),
  group: z.string().regex(NAME_RE).describe("Owning group"),
  mode: z.string().regex(/^[0-7]{3,4}$/).describe('Octal mode (e.g. "0750")'),
});

const GlobalArgsSchema = z.object({
  fleet: z.string().min(1).describe(
    "@swamp/ssh model providing inventory and transport",
  ),
  dirs: z.array(DirSchema).min(1).describe("Directories that must exist"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
type Dir = z.infer<typeof DirSchema>;

interface Ctx extends FleetContext {
  globalArgs: GlobalArgs;
  writeResource: WriteResourceFn;
}

const HostsArg = z.object({
  hosts: z.string().min(1).describe("Fleet host selector (name:X or tag:Y)"),
});

const StateSchema = z.object({
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]),
  dirs: z.array(z.object({
    path: z.string(),
    ok: z.boolean(),
    detail: z.string(),
  })),
  changes: z.array(z.string()),
  error: z.string().nullable(),
  timestamp: z.string(),
});

type DirFact = z.infer<typeof dirFact>;
type DirFacts = z.infer<typeof directoryCheckFacts>;

function dirsCfg(g: GlobalArgs) {
  return {
    dirs: g.dirs.map((d) => ({
      path: d.path,
      owner: d.owner,
      group: d.group,
      modeInt: normalizeMode(d.mode),
    })),
  };
}

function judge(d: Dir, fact: DirFact | undefined) {
  if (!fact || fact.state === "absent") {
    return {
      ok: false,
      detail: "absent",
      changes: [`mkdir ${d.path} (${d.owner}:${d.group} ${d.mode})`],
      broken: false,
    };
  }
  if (fact.state === "other") {
    return {
      ok: false,
      detail: "exists but is not a directory",
      changes: [],
      broken: true,
    };
  }
  const changes: string[] = [];
  if (fact.owner !== d.owner || fact.group !== d.group) {
    changes.push(
      `chown ${d.owner}:${d.group} ${d.path} (is ${fact.owner}:${fact.group})`,
    );
  }
  if (fact.mode !== normalizeMode(d.mode)) {
    changes.push(
      `chmod ${d.mode} ${d.path} (is ${(fact.mode ?? 0).toString(8)})`,
    );
  }
  return {
    ok: changes.length === 0,
    detail: changes.length === 0 ? "ok" : changes.join("; "),
    changes,
    broken: false,
  };
}

function judgeAll(g: GlobalArgs, facts: DirFacts) {
  const judged = g.dirs.map((d) => ({
    d,
    j: judge(d, facts.dirs.find((f) => f.path === d.path)),
  }));
  return {
    dirs: judged.map(({ d, j }) => ({
      path: d.path,
      ok: j.ok,
      detail: j.detail,
    })),
    changes: judged.flatMap(({ j }) => j.changes),
    broken: judged.some(({ j }) => j.broken),
  };
}

/**
 * Ensures directories exist with the desired owner, group, and mode.
 *
 * One model instance owns the whole list — single round-trip per host, no
 * per-directory fan-out. Facts come from os.stat/pwd/grp; modes travel as
 * integers so no octal-string comparison can drift.
 */
export const model = {
  type: "@psftw/pets/directory",
  version: "2026.08.12.3",
  globalArguments: GlobalArgsSchema,
  inputsSchema: z.object({}),
  resources: {
    state: {
      description: "Per-host directory compliance",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: {
    check: {
      description:
        "Report drift on all managed directories (read-only, no sudo)",
      arguments: HostsArg,
      execute: async (args: { hosts: string }, context: Ctx) => {
        const g = context.globalArgs;
        const script = pyScript(
          directoryPy,
          "check",
          directoryCfg,
          dirsCfg(g),
        );
        const runs = await fleetFacts(
          context,
          g.fleet,
          args.hosts,
          script,
          directoryCheckFacts,
        );
        const handles = [];
        for (const run of runs) {
          const j = judgeAll(g, run.data);
          const status = j.broken
            ? "failed"
            : j.changes.length === 0
            ? "compliant"
            : "non_compliant";
          logHostStatus(context, run.host, status, j.changes);
          handles.push(
            await context.writeResource("state", run.host, {
              status,
              dirs: j.dirs,
              changes: j.changes,
              error: j.broken ? "path exists but is not a directory" : null,
              timestamp: nowIso(),
            }),
          );
        }
        return { dataHandles: handles };
      },
    },
    apply: {
      description:
        "mkdir/chown/chmod drifted directories (sudo); refuses non-directory paths",
      arguments: HostsArg,
      execute: async (args: { hosts: string }, context: Ctx) => {
        const g = context.globalArgs;
        const script = pyScript(
          directoryPy,
          "apply",
          directoryCfg,
          dirsCfg(g),
        );
        try {
          const runs = await fleetFacts(
            context,
            g.fleet,
            args.hosts,
            script,
            directoryApplyFacts,
            { sudo: true },
          );
          const handles = [];
          for (const run of runs) {
            const j = judgeAll(g, run.data);
            const performed = run.data.performed;
            const error = run.data.error ??
              (j.changes.length || j.broken
                ? "drift remains after apply"
                : null);
            const status = error !== null
              ? "failed"
              : performed.length
              ? "applied"
              : "compliant";
            logHostStatus(context, run.host, status, performed);
            handles.push(
              await context.writeResource("state", run.host, {
                status,
                dirs: j.dirs,
                changes: performed,
                error,
                timestamp: nowIso(),
              }),
            );
          }
          return { dataHandles: handles };
        } catch (err) {
          await context.writeResource("state", args.hosts, {
            status: "failed",
            dirs: [],
            changes: [],
            error: errorMessage(err),
            timestamp: nowIso(),
          });
          throw err;
        }
      },
    },
  },
  reports: [],
};
