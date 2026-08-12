import { z } from "npm:zod@4";
import {
  errorMessage,
  type FleetContext,
  fleetFacts,
  logHostStatus,
  nowIso,
  pyScript,
  type WriteResourceFn,
} from "./_lib/fleet.ts";
import { source as aptPy } from "./_payloads/apt.ts";
import { aptApplyFacts, aptCfg, aptCheckFacts } from "./_lib/cfg.ts";

const GlobalArgsSchema = z.object({
  fleet: z.string().min(1).describe(
    "@swamp/ssh model providing inventory and transport",
  ),
  packages: z.array(
    z.string().regex(/^[a-z0-9][a-z0-9.+-]*$/, "invalid Debian package name"),
  ).min(1).describe("Packages that must be installed"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

interface Ctx extends FleetContext {
  globalArgs: GlobalArgs;
  writeResource: WriteResourceFn;
}

const HostsArg = z.object({
  hosts: z.string().min(1).describe("Fleet host selector (name:X or tag:Y)"),
});

const StateSchema = z.object({
  packages: z.array(z.string()),
  missing: z.array(z.string()),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]),
  changes: z.array(z.string()),
  error: z.string().nullable(),
  timestamp: z.string(),
});

function missingOf(
  g: GlobalArgs,
  facts: { status: Record<string, string> },
): string[] {
  return g.packages.filter((p) => facts.status[p] !== "installed");
}

/**
 * Ensures Debian packages are installed on every host in the fleet.
 *
 * Remote logic lives in payloads/apt.py (lintable python, JSON in/out),
 * streamed over the fleet transport via runModel.
 */
export const model = {
  type: "@psftw/pets/apt",
  version: "2026.08.12.2",
  globalArguments: GlobalArgsSchema,
  inputsSchema: z.object({}),
  resources: {
    state: {
      description: "Per-host package compliance",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: {
    check: {
      description:
        "Report missing packages, flagging any without an install candidate (read-only, no sudo)",
      arguments: HostsArg,
      execute: async (args: { hosts: string }, context: Ctx) => {
        const g = context.globalArgs;
        const script = pyScript(aptPy, "check", aptCfg, {
          packages: g.packages,
        });
        const runs = await fleetFacts(
          context,
          g.fleet,
          args.hosts,
          script,
          aptCheckFacts,
        );
        const handles = [];
        for (const run of runs) {
          const missing = missingOf(g, run.data);
          const unavailable = new Set(run.data.unavailable);
          const status = missing.length === 0 ? "compliant" : "non_compliant";
          const changes = missing.map((p) =>
            unavailable.has(p)
              ? `install ${p} (no install candidate)`
              : `install ${p}`
          );
          logHostStatus(context, run.host, status, changes);
          handles.push(
            await context.writeResource("state", run.host, {
              packages: g.packages,
              missing,
              status,
              changes,
              error: null,
              timestamp: nowIso(),
            }),
          );
        }
        return { dataHandles: handles };
      },
    },
    apply: {
      description:
        "Refresh the apt index and install missing packages (sudo); no-op when compliant",
      arguments: HostsArg,
      execute: async (args: { hosts: string }, context: Ctx) => {
        const g = context.globalArgs;
        const script = pyScript(aptPy, "apply", aptCfg, {
          packages: g.packages,
        });
        try {
          const runs = await fleetFacts(
            context,
            g.fleet,
            args.hosts,
            script,
            aptApplyFacts,
            { sudo: true, timeoutSec: 600 },
          );
          const handles = [];
          for (const run of runs) {
            const missing = missingOf(g, run.data);
            const error = run.data.error ??
              (missing.length
                ? `still missing after apply: ${missing.join(", ")}`
                : null);
            const changes = run.data.installed.map((p) => `install ${p}`);
            const status = error !== null
              ? "failed"
              : changes.length === 0
              ? "compliant"
              : "applied";
            logHostStatus(context, run.host, status, changes);
            handles.push(
              await context.writeResource("state", run.host, {
                packages: g.packages,
                missing,
                status,
                changes,
                error,
                timestamp: nowIso(),
              }),
            );
          }
          return { dataHandles: handles };
        } catch (err) {
          await context.writeResource("state", args.hosts, {
            packages: g.packages,
            missing: [],
            status: "failed",
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
