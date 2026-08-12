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
import { source as groupMemberPy } from "./_payloads/group_member.ts";
import {
  groupMemberApplyFacts,
  groupMemberCfg,
  groupMemberCheckFacts,
} from "./_lib/cfg.ts";

const NAME_RE = /^[a-z_][a-z0-9_-]*\$?$/;

const GlobalArgsSchema = z.object({
  fleet: z.string().min(1).describe(
    "@swamp/ssh model providing inventory and transport",
  ),
  username: z.string().regex(NAME_RE).describe(
    "User whose membership is managed",
  ),
  group: z.string().regex(NAME_RE).describe(
    "Supplementary group the user must belong to",
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
  username: z.string(),
  group: z.string(),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]),
  member: z.boolean(),
  groups: z.array(z.string()),
  changes: z.array(z.string()),
  error: z.string().nullable(),
  timestamp: z.string(),
});

type MemberFacts = z.infer<typeof groupMemberCheckFacts>;

function stateOf(g: GlobalArgs, facts: MemberFacts) {
  return {
    username: g.username,
    group: g.group,
    member: facts.member,
    groups: facts.groups,
    timestamp: nowIso(),
  };
}

/**
 * Append-only supplementary group membership over the fleet.
 *
 * Manages exactly one (user, group) pair: apply appends with `usermod -aG`
 * and never removes anything — declaring a full group list would strip
 * memberships like `sudo`. Facts come from python's pwd/grp modules.
 */
export const model = {
  type: "@psftw/pets/group-member",
  version: "2026.08.12.3",
  globalArguments: GlobalArgsSchema,
  inputsSchema: z.object({}),
  resources: {
    state: {
      description: "Per-host membership compliance",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: {
    check: {
      description:
        "Report whether the user is in the group (read-only, no sudo)",
      arguments: HostsArg,
      execute: async (args: { hosts: string }, context: Ctx) => {
        const g = context.globalArgs;
        const script = pyScript(groupMemberPy, "check", groupMemberCfg, {
          username: g.username,
          group: g.group,
        });
        const runs = await fleetFacts(
          context,
          g.fleet,
          args.hosts,
          script,
          groupMemberCheckFacts,
        );
        const handles = [];
        for (const run of runs) {
          const f = run.data;
          const status = !f.userExists
            ? "failed"
            : f.member
            ? "compliant"
            : "non_compliant";
          const changes = f.userExists && !f.member
            ? [`add ${g.username} to ${g.group}`]
            : [];
          logHostStatus(context, run.host, status, changes);
          handles.push(
            await context.writeResource("state", run.host, {
              ...stateOf(g, f),
              status,
              changes,
              error: f.userExists ? null : `user ${g.username} not found`,
            }),
          );
        }
        return { dataHandles: handles };
      },
    },
    apply: {
      description: "Append the user to the group with usermod -aG (sudo)",
      arguments: HostsArg,
      execute: async (args: { hosts: string }, context: Ctx) => {
        const g = context.globalArgs;
        const script = pyScript(groupMemberPy, "apply", groupMemberCfg, {
          username: g.username,
          group: g.group,
        });
        try {
          const runs = await fleetFacts(
            context,
            g.fleet,
            args.hosts,
            script,
            groupMemberApplyFacts,
            { sudo: true },
          );
          const handles = [];
          for (const run of runs) {
            const f = run.data;
            const error = f.error ??
              (f.member ? null : "not a member after apply");
            const status = error !== null
              ? "failed"
              : f.changed
              ? "applied"
              : "compliant";
            const changes = f.changed
              ? [`add ${g.username} to ${g.group} (re-login required)`]
              : [];
            logHostStatus(context, run.host, status, changes);
            handles.push(
              await context.writeResource("state", run.host, {
                ...stateOf(g, f),
                status,
                changes,
                error,
              }),
            );
          }
          return { dataHandles: handles };
        } catch (err) {
          await context.writeResource("state", args.hosts, {
            username: g.username,
            group: g.group,
            status: "failed",
            member: false,
            groups: [],
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
