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
import { source as systemdPy } from "./_payloads/systemd.ts";
import {
  systemdApplyCfg,
  systemdApplyFacts,
  systemdCheckCfg,
  systemdCheckFacts,
} from "./_lib/cfg.ts";

const GlobalArgsSchema = z.object({
  fleet: z.string().min(1).describe(
    "@swamp/ssh model providing inventory and transport",
  ),
  service: z.string().regex(/^[A-Za-z0-9@._-]+$/).describe(
    "Unit name (e.g. nginx or getty@tty1)",
  ),
  enabled: z.boolean().describe("Unit must be enabled at boot"),
  ensure: z.enum(["running", "stopped"]).describe("Desired active state"),
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
  service: z.string(),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]),
  enabled: z.string(),
  active: z.string(),
  changes: z.array(z.string()),
  error: z.string().nullable(),
  timestamp: z.string(),
});

type UnitFacts = z.infer<typeof systemdCheckFacts>;

function drift(g: GlobalArgs, facts: UnitFacts): string[] {
  const changes: string[] = [];
  if ((facts.unitFileState === "enabled") !== g.enabled) {
    changes.push(g.enabled ? "enable" : "disable");
  }
  if ((facts.activeState === "active") !== (g.ensure === "running")) {
    changes.push(g.ensure === "running" ? "start" : "stop");
  }
  return changes;
}

/**
 * Ensures a systemd unit's enabled-at-boot and running/stopped state.
 *
 * Facts come from `systemctl show -p` key=value properties, not
 * human-facing keywords.
 */
export const model = {
  type: "@psftw/pets/systemd",
  version: "2026.08.12.2",
  globalArguments: GlobalArgsSchema,
  inputsSchema: z.object({}),
  resources: {
    state: {
      description: "Per-host unit state compliance",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: {
    check: {
      description: "Report unit enabled/active drift (read-only, no sudo)",
      arguments: HostsArg,
      execute: async (args: { hosts: string }, context: Ctx) => {
        const g = context.globalArgs;
        const script = pyScript(systemdPy, "check", systemdCheckCfg, {
          service: g.service,
        });
        const runs = await fleetFacts(
          context,
          g.fleet,
          args.hosts,
          script,
          systemdCheckFacts,
        );
        const handles = [];
        for (const run of runs) {
          const drifted = drift(g, run.data);
          const status = drifted.length === 0 ? "compliant" : "non_compliant";
          const changes = drifted.map((c) => `systemctl ${c} ${g.service}`);
          logHostStatus(context, run.host, status, changes);
          handles.push(
            await context.writeResource("state", run.host, {
              service: g.service,
              status,
              enabled: run.data.unitFileState,
              active: run.data.activeState,
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
        "systemctl enable/disable + start/stop to match desired state (sudo)",
      arguments: HostsArg,
      execute: async (args: { hosts: string }, context: Ctx) => {
        const g = context.globalArgs;
        const script = pyScript(systemdPy, "apply", systemdApplyCfg, {
          service: g.service,
          enabled: g.enabled,
          running: g.ensure === "running",
        });
        try {
          const runs = await fleetFacts(
            context,
            g.fleet,
            args.hosts,
            script,
            systemdApplyFacts,
            { sudo: true },
          );
          const handles = [];
          for (const run of runs) {
            const remaining = drift(g, run.data);
            const performed = run.data.performed;
            const error = run.data.error ??
              (remaining.length
                ? `drift remains after apply: ${remaining.join(", ")}`
                : null);
            const status = error !== null
              ? "failed"
              : performed.length
              ? "applied"
              : "compliant";
            logHostStatus(context, run.host, status, performed);
            handles.push(
              await context.writeResource("state", run.host, {
                service: g.service,
                status,
                enabled: run.data.unitFileState,
                active: run.data.activeState,
                changes: performed,
                error,
                timestamp: nowIso(),
              }),
            );
          }
          return { dataHandles: handles };
        } catch (err) {
          await context.writeResource("state", args.hosts, {
            service: g.service,
            status: "failed",
            enabled: "unknown",
            active: "unknown",
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
