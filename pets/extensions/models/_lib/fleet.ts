/**
 * Fleet transport for @psftw/pets models.
 *
 * These models own no ssh code: every remote touch goes through the repo's
 * @swamp/ssh fleet model via ctx.runModel. Fact gathering runs python3 on
 * the host and emits a single JSON document — no parsing of human-oriented
 * command output. Scripts must exit 0; drift is data, and a non-zero exit
 * means transport or execution failure and surfaces as a thrown error.
 */
import type { z } from "npm:zod@4";

/** Resource handle from a runModel result — the subset pets reads. */
export interface DataHandle {
  name: string;
  specName: string;
  kind: string;
  attributes?: Record<string, unknown>;
}

/** runModel outcome: result resources on success, a message on failure. */
export type RunModelResult =
  | { ok: true; resources: DataHandle[] }
  | { ok: false; error: { message: string } };

/** The context.runModel signature pets depends on. */
export type RunModelFn = (options: {
  definition: string;
  method: string;
  arguments?: Record<string, unknown>;
}) => Promise<RunModelResult>;

/** The context.logger slice pets uses (LogTape-style `{placeholder}` messages). */
export interface FleetLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
}

/** Minimal execution context every pets method needs. */
export interface FleetContext {
  runModel: RunModelFn;
  logger: FleetLogger;
}

/** The context.writeResource signature pets depends on. */
export interface WriteResourceFn {
  (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
}

/** One resolved fleet member from the selection resource. */
export interface FleetHost {
  name: string;
  address: string;
  tags: string[];
}

/** Resolve a selector to fleet members without connecting. */
export async function fleetResolve(
  ctx: FleetContext,
  fleet: string,
  hosts: string,
): Promise<FleetHost[]> {
  const result = await ctx.runModel({
    definition: fleet,
    method: "resolve",
    arguments: { hosts },
  });
  if (!result.ok) {
    throw new Error(
      `${fleet}.resolve(${hosts}) failed: ${result.error.message}`,
    );
  }
  const sel = result.resources.find((r) => r.specName === "selection");
  if (!sel) {
    throw new Error(
      `${fleet}.resolve returned no 'selection' resource — is '${fleet}' a fleet-protocol model? (see README: Fleet protocol)`,
    );
  }
  const list = (sel.attributes?.hosts ?? []) as Partial<FleetHost>[];
  ctx.logger.debug("{fleet}.resolve({hosts}): {count} host(s)", {
    fleet,
    hosts,
    count: list.length,
  });
  return list.map((h) => ({
    name: String(h.name),
    address: String(h.address),
    tags: (h.tags ?? []) as string[],
  }));
}

/** One live-progress line per converged host. */
export function logHostStatus(
  ctx: FleetContext,
  host: string,
  status: string,
  changes: string[],
): void {
  ctx.logger.info(
    changes.length ? "{host}: {status} — {changes}" : "{host}: {status}",
    { host, status, changes: changes.join("; ") },
  );
}

/**
 * Run a python3 script on the selected hosts; the script must print exactly
 * one JSON document to stdout, parsed and validated per host against the
 * facts schema (_lib/cfg.ts) — the inbound wire contract.
 */
export async function fleetFacts<S extends z.ZodType>(
  ctx: FleetContext,
  fleet: string,
  hosts: string,
  script: string,
  schema: S,
  opts?: { sudo?: boolean; timeoutSec?: number },
): Promise<Array<{ host: string; data: z.output<S> }>> {
  ctx.logger.info("running on {hosts} via {fleet}{sudo}", {
    hosts,
    fleet,
    sudo: opts?.sudo ? " (sudo)" : "",
  });
  const result = await ctx.runModel({
    definition: fleet,
    method: "script",
    arguments: {
      hosts,
      script,
      interpreter: "python3",
      sudo: opts?.sudo ?? false,
      ...(opts?.timeoutSec !== undefined
        ? { timeoutSec: opts.timeoutSec }
        : {}),
    },
  });
  if (!result.ok) {
    throw new Error(
      `${fleet}.script(${hosts}) failed: ${result.error.message}`,
    );
  }
  const runResults = result.resources.filter((r) => r.specName === "runResult");
  ctx.logger.debug("{fleet}: {count} host(s) returned facts", {
    fleet,
    count: runResults.length,
  });
  if (runResults.length === 0) {
    throw new Error(
      `${fleet}.script returned no 'runResult' resources — is '${fleet}' a fleet-protocol model? (see README: Fleet protocol)`,
    );
  }
  return runResults.map((r) => {
    const a = r.attributes ?? {};
    const host = String(a.host ?? "unknown");
    const stdout = String(a.stdout ?? "");
    let facts: unknown;
    try {
      facts = JSON.parse(stdout);
    } catch {
      throw new Error(
        `${fleet}: host ${host} returned non-JSON facts: ${
          stdout.slice(0, 200)
        }`,
      );
    }
    try {
      return { host, data: schema.parse(facts) as z.output<S> };
    } catch (err) {
      throw new Error(
        `${fleet}: host ${host} returned facts violating the contract: ${
          errorMessage(err).slice(0, 300)
        }`,
      );
    }
  });
}

/**
 * Embed a value into a python script as a parsed-JSON literal. Quotes are
 * JSON-escaped to ' so the raw triple-quoted wrapper cannot be broken
 * by data.
 */
function py(value: unknown): string {
  const json = JSON.stringify(value).replaceAll("'", "\\u0027");
  return `json.loads(r'''${json}''')`;
}

/**
 * Append the single generated entry-point call to a lintable python module
 * (generated from payloads/*.py — see scripts/gen_payloads.ts). The module
 * must be self-contained (functions taking cfg); only this one line is
 * generated. cfg is validated against its wire contract (_lib/cfg.ts)
 * before serialization — a non-conforming cfg throws before any host runs.
 */
export function pyScript<S extends z.ZodType>(
  source: string,
  entry: string,
  schema: S,
  cfg: z.input<S>,
): string {
  return `${source}\n${entry}(${py(schema.parse(cfg))})\n`;
}

/**
 * Octal-normalized mode: desired modes are strings ("0750", "2775") while
 * os.stat reports integers — comparing strings would report false drift.
 */
export function normalizeMode(mode: string): number {
  return parseInt(mode, 8);
}

/** Hex SHA-256, matching hashlib.sha256().hexdigest() on the payload side. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Timestamp for state resources (ISO-8601 UTC). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Error → message string without losing non-Error throwables. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
