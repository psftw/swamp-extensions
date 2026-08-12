import { z } from "npm:zod@4";
import {
  errorMessage,
  type FleetContext,
  fleetFacts,
  logHostStatus,
  nowIso,
  pyScript,
  sha256Hex,
  type WriteResourceFn,
} from "./_lib/fleet.ts";
import { source as aptRepositoryPy } from "./_payloads/apt_repository.ts";
import {
  aptRepositoryApplyCfg,
  aptRepositoryApplyFacts,
  aptRepositoryCheckCfg,
  aptRepositoryCheckFacts,
} from "./_lib/cfg.ts";

const GlobalArgsSchema = z.object({
  fleet: z.string().min(1).describe(
    "@swamp/ssh model providing inventory and transport",
  ),
  name: z.string().regex(/^[a-z0-9-]+$/).describe(
    "Filename stem for /etc/apt/sources.list.d/<name>.sources",
  ),
  uris: z.array(z.string().url()).min(1).describe("Repository base URLs"),
  suites: z.array(z.string()).min(1).describe(
    "Distribution suites (e.g. trixie-pgdg)",
  ),
  components: z.array(z.string()).min(1).describe(
    "Repository components (e.g. main)",
  ),
  architectures: z.array(z.string()).optional().describe(
    "Restrict to these architectures",
  ),
  gpgKeyUrl: z.string().url().optional().describe(
    "Key fetched to signedBy when absent (.asc target: stored armored as-is)",
  ),
  signedBy: z.string().startsWith("/").optional().describe(
    "Keyring path referenced by Signed-By",
  ),
});

/** Parsed global arguments (exported for tests). */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

interface Ctx extends FleetContext {
  globalArgs: GlobalArgs;
  writeResource: WriteResourceFn;
}

const HostsArg = z.object({
  hosts: z.string().min(1).describe("Fleet host selector (name:X or tag:Y)"),
});

const StateSchema = z.object({
  path: z.string(),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]),
  sourcesMatch: z.boolean(),
  keyPresent: z.boolean(),
  changes: z.array(z.string()),
  error: z.string().nullable(),
  timestamp: z.string(),
});

type RepoFacts = z.infer<typeof aptRepositoryCheckFacts>;

function sourcesPath(g: GlobalArgs): string {
  return `/etc/apt/sources.list.d/${g.name}.sources`;
}

/** Render the deb822 .sources content exactly as apply installs it. */
export function deb822(g: GlobalArgs): string {
  const lines = ["Types: deb"];
  lines.push(`URIs: ${g.uris.join(" ")}`);
  lines.push(`Suites: ${g.suites.join(" ")}`);
  lines.push(`Components: ${g.components.join(" ")}`);
  if (g.architectures) {
    lines.push(`Architectures: ${g.architectures.join(" ")}`);
  }
  if (g.signedBy) lines.push(`Signed-By: ${g.signedBy}`);
  return lines.join("\n") + "\n";
}

function checkCfg(g: GlobalArgs) {
  return { path: sourcesPath(g), signedBy: g.signedBy ?? null };
}

function judge(g: GlobalArgs, expected: string, facts: RepoFacts) {
  const sourcesMatch = facts.fileHash === expected;
  const changes = [
    ...(sourcesMatch ? [] : [`write ${sourcesPath(g)}`]),
    ...(facts.keyPresent ? [] : [`fetch key to ${g.signedBy}`]),
  ];
  return { sourcesMatch, changes };
}

/**
 * Manages a deb822 `.sources` apt repository entry and its signing key.
 *
 * Renders the .sources file exactly as the official Docker Debian docs
 * prescribe (deb822, Types/URIs/Suites/Components/Architectures/Signed-By,
 * trailing newline); keys ending in .asc are installed armored, without
 * dearmoring, matching those docs.
 */
export const model = {
  type: "@psftw/pets/apt-repository",
  version: "2026.08.12.1",
  globalArguments: GlobalArgsSchema,
  inputsSchema: z.object({}),
  resources: {
    state: {
      description: "Per-host apt source compliance",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: {
    check: {
      description:
        "Compare .sources content hash and key presence (read-only, no sudo)",
      arguments: HostsArg,
      execute: async (args: { hosts: string }, context: Ctx) => {
        const g = context.globalArgs;
        const expected = await sha256Hex(deb822(g));
        const script = pyScript(
          aptRepositoryPy,
          "check",
          aptRepositoryCheckCfg,
          checkCfg(g),
        );
        const runs = await fleetFacts(
          context,
          g.fleet,
          args.hosts,
          script,
          aptRepositoryCheckFacts,
        );
        const handles = [];
        for (const run of runs) {
          const j = judge(g, expected, run.data);
          const status = j.changes.length === 0 ? "compliant" : "non_compliant";
          logHostStatus(context, run.host, status, j.changes);
          handles.push(
            await context.writeResource("state", run.host, {
              path: sourcesPath(g),
              status,
              sourcesMatch: j.sourcesMatch,
              keyPresent: run.data.keyPresent,
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
        "Install the .sources file and fetch the signing key if absent (sudo); no-op when compliant",
      arguments: HostsArg,
      execute: async (args: { hosts: string }, context: Ctx) => {
        const g = context.globalArgs;
        const expected = await sha256Hex(deb822(g));
        const script = pyScript(
          aptRepositoryPy,
          "apply",
          aptRepositoryApplyCfg,
          {
            ...checkCfg(g),
            contentB64: btoa(deb822(g)),
            gpgKeyUrl: g.gpgKeyUrl ?? null,
          },
        );
        try {
          const runs = await fleetFacts(
            context,
            g.fleet,
            args.hosts,
            script,
            aptRepositoryApplyFacts,
            { sudo: true, timeoutSec: 120 },
          );
          const handles = [];
          for (const run of runs) {
            const j = judge(g, expected, run.data);
            const error = run.data.error ??
              (j.changes.length ? "post-apply verification failed" : null);
            const changes = [
              ...(run.data.wroteSources ? [`write ${sourcesPath(g)}`] : []),
              ...(run.data.fetchedKey ? [`fetch key to ${g.signedBy}`] : []),
            ];
            const status = error !== null
              ? "failed"
              : changes.length === 0
              ? "compliant"
              : "applied";
            logHostStatus(context, run.host, status, changes);
            handles.push(
              await context.writeResource("state", run.host, {
                path: sourcesPath(g),
                status,
                sourcesMatch: j.sourcesMatch,
                keyPresent: run.data.keyPresent,
                changes,
                error,
                timestamp: nowIso(),
              }),
            );
          }
          return { dataHandles: handles };
        } catch (err) {
          await context.writeResource("state", args.hosts, {
            path: sourcesPath(g),
            status: "failed",
            sourcesMatch: false,
            keyPresent: false,
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
