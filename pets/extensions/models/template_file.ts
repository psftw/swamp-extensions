import { z } from "npm:zod@4";
import { Liquid } from "npm:liquidjs@10.28.0";
import {
  errorMessage,
  type FleetContext,
  fleetFacts,
  type FleetHost,
  fleetResolve,
  logHostStatus,
  normalizeMode,
  nowIso,
  pyScript,
  sha256Hex,
  type WriteResourceFn,
} from "./_lib/fleet.ts";
import { source as templateFilePy } from "./_payloads/template_file.ts";
import {
  templateFileApplyCfg,
  templateFileApplyFacts,
  templateFileCheckCfg,
  templateFileCheckFacts,
} from "./_lib/cfg.ts";

const NAME_RE = /^[a-z_][a-z0-9_-]*\$?$/;

const GlobalArgsSchema = z.object({
  fleet: z.string().min(1).describe(
    "@swamp/ssh model providing inventory and transport",
  ),
  path: z.string().startsWith("/").describe("Destination file on the host"),
  templatePath: z.string().describe(
    "Liquid template, relative to the repo root",
  ),
  owner: z.string().regex(NAME_RE).describe("File owner"),
  group: z.string().regex(NAME_RE).describe("File group"),
  mode: z.string().regex(/^[0-7]{3,4}$/).describe('Octal mode (e.g. "0644")'),
  variables: z.record(z.string(), z.unknown()).default({}).describe(
    "Extra render-context values, merged with per-host `host`",
  ),
  validateCommand: z.string().optional().describe(
    'Run against the staged file as $FILE before install (e.g. nft -c -f "$FILE")',
  ),
  onChange: z.string().optional().describe(
    "Run after install, only when the content hash changed",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

interface Ctx extends FleetContext {
  globalArgs: GlobalArgs;
  repoDir: string;
  writeResource: WriteResourceFn;
}

const HostsArg = z.object({
  hosts: z.string().min(1).describe("Fleet host selector (name:X or tag:Y)"),
});

const StateSchema = z.object({
  path: z.string(),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]),
  contentMatch: z.boolean(),
  expectedHash: z.string(),
  actualHash: z.string(),
  changes: z.array(z.string()),
  error: z.string().nullable(),
  timestamp: z.string(),
});

type FileFacts = z.infer<typeof templateFileCheckFacts>;

const engine = new Liquid({ strictVariables: true, strictFilters: true });

async function render(
  context: Ctx,
  host: FleetHost,
): Promise<{ text: string; hash: string }> {
  const g = context.globalArgs;
  const tpl = await Deno.readTextFile(`${context.repoDir}/${g.templatePath}`);
  const text = await engine.parseAndRender(tpl, {
    ...g.variables,
    host: { name: host.name, address: host.address, tags: host.tags },
  });
  return { text, hash: await sha256Hex(text) };
}

function judge(g: GlobalArgs, expectedHash: string, facts: FileFacts) {
  const actualHash = facts.exists ? facts.hash ?? "unreadable" : "absent";
  const contentMatch = actualHash === expectedHash;
  const changes: string[] = [];
  if (!contentMatch) changes.push(`write ${g.path}`);
  if (facts.exists) {
    if (facts.owner !== g.owner || facts.group !== g.group) {
      changes.push(
        `chown ${g.owner}:${g.group} (is ${facts.owner}:${facts.group})`,
      );
    }
    if (facts.mode !== normalizeMode(g.mode)) {
      changes.push(`chmod ${g.mode} (is ${(facts.mode ?? 0).toString(8)})`);
    }
  }
  return { contentMatch, actualHash, changes };
}

/**
 * Installs a Liquid-rendered file atomically, with optional validate and
 * onChange hooks.
 *
 * Templates are repo files, rendered locally with LiquidJS (sandboxed by
 * design — no arbitrary code in templates).
 * The render context exposes `host` ({name, address, tags}) from the
 * fleet's resolve data plus any configured `variables`, so per-host
 * conditionals need no workflow CEL.
 *
 * apply pipeline per host: stage rendered bytes to a same-directory temp
 * file → run validateCommand against it ($FILE) → atomic os.replace → run
 * onChange only when the content hash changed (handler semantics). check
 * never stages anything: local render + remote hash/stat compare only,
 * via python hashlib/os.stat — no command-output parsing.
 */
export const model = {
  type: "@psftw/pets/template-file",
  version: "2026.08.12.2",
  globalArguments: GlobalArgsSchema,
  inputsSchema: z.object({}),
  resources: {
    state: {
      description: "Per-host rendered-file compliance",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: {
    check: {
      description:
        "Render locally and compare remote hash/owner/mode (read-only, no sudo)",
      arguments: HostsArg,
      execute: async (args: { hosts: string }, context: Ctx) => {
        const g = context.globalArgs;
        const members = await fleetResolve(context, g.fleet, args.hosts);
        const script = pyScript(templateFilePy, "check", templateFileCheckCfg, {
          path: g.path,
        });
        const runs = await fleetFacts(
          context,
          g.fleet,
          args.hosts,
          script,
          templateFileCheckFacts,
        );
        // resolve and script use the same selector, so their host sets must
        // agree — a mismatch is transport incoherence, not drift.
        const memberNames = new Set(members.map((m) => m.name));
        for (const run of runs) {
          if (!memberNames.has(run.host)) {
            throw new Error(
              `${g.fleet}.script(${args.hosts}) returned runResult for host '${run.host}' absent from resolve (see README: Fleet protocol)`,
            );
          }
        }
        const runByHost = new Map(runs.map((r) => [r.host, r]));
        const pairs = members.map((member) => {
          const run = runByHost.get(member.name);
          if (!run) {
            throw new Error(
              `${g.fleet}.script(${args.hosts}) returned no runResult for resolved host '${member.name}' (see README: Fleet protocol)`,
            );
          }
          return { member, run };
        });
        const handles = [];
        for (const { member, run } of pairs) {
          const { hash } = await render(context, member);
          const j = judge(g, hash, run.data);
          const status = j.changes.length === 0 ? "compliant" : "non_compliant";
          logHostStatus(context, run.host, status, j.changes);
          handles.push(
            await context.writeResource("state", run.host, {
              path: g.path,
              status,
              contentMatch: j.contentMatch,
              expectedHash: hash,
              actualHash: j.actualHash,
              changes: j.changes,
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
        "Stage, validate, atomically install, run onChange when the hash changed (sudo)",
      arguments: HostsArg,
      execute: async (args: { hosts: string }, context: Ctx) => {
        const g = context.globalArgs;
        const members = await fleetResolve(context, g.fleet, args.hosts);
        const handles = [];
        try {
          for (const member of members) {
            const { text, hash } = await render(context, member);
            const script = pyScript(
              templateFilePy,
              "apply",
              templateFileApplyCfg,
              {
                path: g.path,
                contentB64: btoa(text),
                owner: g.owner,
                group: g.group,
                modeInt: normalizeMode(g.mode),
                validateCommand: g.validateCommand ?? null,
                onChange: g.onChange ?? null,
              },
            );
            const runs = await fleetFacts(
              context,
              g.fleet,
              `name:${member.name}`,
              script,
              templateFileApplyFacts,
              { sudo: true, timeoutSec: 120 },
            );
            for (const run of runs) {
              if (run.host !== member.name) {
                throw new Error(
                  `${g.fleet}.script(name:${member.name}) returned runResult for host '${run.host}' (see README: Fleet protocol)`,
                );
              }
              const j = judge(g, hash, run.data);
              const error = run.data.error ??
                (j.changes.length ? "drift remains after apply" : null);
              const status = error !== null
                ? "failed"
                : run.data.changed
                ? "applied"
                : "compliant";
              const changes = run.data.changed ? [`write ${g.path}`] : [];
              logHostStatus(context, run.host, status, changes);
              handles.push(
                await context.writeResource("state", run.host, {
                  path: g.path,
                  status,
                  contentMatch: j.contentMatch,
                  expectedHash: hash,
                  actualHash: j.actualHash,
                  changes,
                  error,
                  timestamp: nowIso(),
                }),
              );
            }
          }
          return { dataHandles: handles };
        } catch (err) {
          await context.writeResource("state", args.hosts, {
            path: g.path,
            status: "failed",
            contentMatch: false,
            expectedHash: "",
            actualHash: "",
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
