import { z } from "npm:zod@4";
import {
  errorMessage,
  type FleetContext,
  logHostStatus,
  nowIso,
  type WriteResourceFn,
} from "./_lib/fleet.ts";

const GlobalArgsSchema = z.object({
  fleet: z.string().min(1).describe(
    "@swamp/ssh model providing inventory and transport",
  ),
  requireCharDevices: z.array(z.string().regex(/^\/[A-Za-z0-9/_.-]+$/))
    .default([]).describe(
      "Character devices that must exist; apply refuses without them",
    ),
  members: z.array(z.string().min(1)).min(1).describe(
    "Granular @psftw/pets model instances (each implementing check and apply), in execution order",
  ),
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
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]),
  changes: z.array(z.string()),
  members: z.record(z.string(), z.string()),
  error: z.string().nullable(),
  timestamp: z.string(),
});

const SummarySchema = z.object({
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]),
  hosts: z.record(z.string(), z.string()),
  error: z.string().nullable(),
  timestamp: z.string(),
});

interface HostRollup {
  changes: string[];
  members: Record<string, string>;
  failed: boolean;
}

async function runPhase(
  context: Ctx,
  phase: "check" | "apply",
  hosts: string,
): Promise<Map<string, HostRollup>> {
  const g = context.globalArgs;
  const perHost = new Map<string, HostRollup>();
  for (const [i, m] of g.members.entries()) {
    context.logger.info("[{n}/{total}] {member}: {phase} on {hosts}", {
      n: i + 1,
      total: g.members.length,
      member: m,
      phase,
      hosts,
    });
    const result = await context.runModel({
      definition: m,
      method: phase,
      arguments: { hosts },
    });
    if (!result.ok) {
      throw new Error(`${m}.${phase} failed: ${result.error.message}`);
    }
    let anyFailed = false;
    const tally: Record<string, number> = {};
    for (const h of result.resources.filter((r) => r.specName === "state")) {
      const a = h.attributes ?? {};
      const entry = perHost.get(h.name) ??
        { changes: [], members: {}, failed: false };
      const status = String(a.status ?? "unknown");
      entry.members[m] = status;
      tally[status] = (tally[status] ?? 0) + 1;
      if (status === "failed") {
        entry.failed = true;
        anyFailed = true;
      }
      for (const c of (a.changes as string[] | undefined) ?? []) {
        entry.changes.push(`${m}: ${c}`);
      }
      perHost.set(h.name, entry);
    }
    context.logger.info("[{n}/{total}] {member}: {tally}", {
      n: i + 1,
      total: g.members.length,
      member: m,
      tally: Object.entries(tally).map(([s, c]) => `${s}=${c}`).join(" "),
    });
    if (phase === "apply" && anyFailed) {
      throw new Error(
        `${m}.${phase} reported failed state — aborting the remaining members`,
      );
    }
  }
  return perHost;
}

function worstOf(
  statuses: string[],
): "compliant" | "non_compliant" | "applied" | "failed" {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("applied")) return "applied";
  if (statuses.includes("non_compliant")) return "non_compliant";
  return "compliant";
}

async function writeRollups(
  context: Ctx,
  perHost: Map<string, HostRollup>,
  okStatus: "compliant" | "applied",
  driftStatus: "non_compliant" | "applied",
) {
  const handles = [];
  const hostStatuses: Record<string, string> = {};
  for (const [host, r] of perHost) {
    const status = r.failed
      ? "failed"
      : r.changes.length
      ? driftStatus
      : okStatus;
    hostStatuses[host] = status;
    logHostStatus(context, host, status, r.changes);
    handles.push(
      await context.writeResource("state", host, {
        status,
        changes: r.changes,
        members: r.members,
        error: r.failed ? "one or more members reported failed state" : null,
        timestamp: nowIso(),
      }),
    );
  }
  return { handles, hostStatuses };
}

async function writeSummary(
  context: Ctx,
  hosts: string,
  hostStatuses: Record<string, string>,
) {
  const status = worstOf(Object.values(hostStatuses));
  context.logger.info("summary[{hosts}]: {status}", { hosts, status });
  return await context.writeResource("summary", hosts, {
    status,
    hosts: hostStatuses,
    error: null,
    timestamp: nowIso(),
  });
}

/**
 * Sequences member models' check/apply across the fleet and rolls their
 * per-host states into one aggregate state plus a selector-keyed summary.
 *
 * Desired state stays in the member model definitions — an instance of
 * this type owns only the execution order and the converge refusals
 * (requireCharDevices, e.g. /dev/kvm: without it qemu silently falls back
 * to software emulation).
 */
export const model = {
  type: "@psftw/pets/role",
  version: "2026.08.12.4",
  globalArguments: GlobalArgsSchema,
  inputsSchema: z.object({}),
  resources: {
    state: {
      description:
        "Per-host aggregate role compliance (member states hold detail)",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    summary: {
      description:
        "Selector-keyed roll-up across all hosts (stable name for CEL/data.latest consumers)",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: {
    check: {
      description:
        "Run every member's check and roll up per-host drift (read-only, no sudo)",
      arguments: HostsArg,
      execute: async (args: { hosts: string }, context: Ctx) => {
        const perHost = await runPhase(context, "check", args.hosts);
        const { handles, hostStatuses } = await writeRollups(
          context,
          perHost,
          "compliant",
          "non_compliant",
        );
        const summary = await writeSummary(context, args.hosts, hostStatuses);
        return { dataHandles: [...handles, summary] };
      },
    },
    apply: {
      description:
        "Verify required devices, then run every member's apply in order (sudo)",
      arguments: HostsArg,
      execute: async (args: { hosts: string }, context: Ctx) => {
        const g = context.globalArgs;
        try {
          if (g.requireCharDevices.length) {
            const cmd = g.requireCharDevices
              .map((d) => `test -c ${d}`)
              .join(" && ");
            context.logger.info(
              "verifying required devices on {hosts}: {devices}",
              {
                hosts: args.hosts,
                devices: g.requireCharDevices.join(", "),
              },
            );
            const probe = await context.runModel({
              definition: g.fleet,
              method: "exec",
              arguments: { hosts: args.hosts, command: cmd },
            });
            if (!probe.ok) {
              throw new Error(
                `required device check (${cmd}) failed — refusing to converge: ${probe.error.message}`,
              );
            }
          }
          const perHost = await runPhase(context, "apply", args.hosts);
          const { handles, hostStatuses } = await writeRollups(
            context,
            perHost,
            "compliant",
            "applied",
          );
          const summary = await writeSummary(
            context,
            args.hosts,
            hostStatuses,
          );
          return { dataHandles: [...handles, summary] };
        } catch (err) {
          await context.writeResource("summary", args.hosts, {
            status: "failed",
            hosts: {},
            error: errorMessage(err),
            timestamp: nowIso(),
          });
          throw err;
        }
      },
    },
  },
  reports: ["@psftw/pets/fleet-compliance"],
};
