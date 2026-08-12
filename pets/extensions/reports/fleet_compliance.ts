interface Handle {
  name: string;
  specName: string;
  version: number;
}

interface ReportCtx {
  definition: { name: string };
  methodName: string;
  executionStatus: string;
  modelType: string;
  modelId: string;
  dataHandles: Handle[];
  dataRepository: {
    getContent: (
      modelType: string,
      modelId: string,
      name: string,
      version: number,
    ) => Promise<Uint8Array | null>;
  };
}

interface HostState {
  status: string;
  changes: string[];
  members: Record<string, string>;
  timestamp: string;
}

interface Summary {
  status: string;
  hosts: Record<string, string>;
  error: string | null;
  timestamp: string;
}

async function readJson<T>(ctx: ReportCtx, h: Handle): Promise<T | null> {
  const raw = await ctx.dataRepository.getContent(
    ctx.modelType,
    ctx.modelId,
    h.name,
    h.version,
  );
  return raw ? JSON.parse(new TextDecoder().decode(raw)) as T : null;
}

/**
 * Fleet-compliance report for @psftw/pets/role runs: renders the per-host
 * roll-ups and member statuses a check/apply produced into one table, plus
 * the selector-keyed aggregate. Bound via the role model's `reports` list.
 */
export const report = {
  name: "@psftw/pets/fleet-compliance",
  description:
    "Per-host role compliance: aggregate, member statuses, and changes",
  scope: "method",
  labels: ["compliance", "audit"],
  execute: async (context: ReportCtx) => {
    const role = context.definition.name;
    const method = context.methodName;
    const title =
      `# Fleet compliance — ${role} · ${method} (${context.executionStatus})`;

    const stateHandles = context.dataHandles.filter(
      (h) => h.specName === "state",
    );
    const summaryHandle = context.dataHandles.find(
      (h) => h.specName === "summary",
    );
    const summary = summaryHandle
      ? await readJson<Summary>(context, summaryHandle)
      : null;

    if (!stateHandles.length && !summary) {
      return {
        markdown: `${title}\n\nNo role state was produced by this run.`,
        json: { role, method, executionStatus: context.executionStatus },
      };
    }

    const hosts: Record<string, HostState> = {};
    for (const h of stateHandles) {
      const s = await readJson<HostState>(context, h);
      if (s) hosts[h.name] = s;
    }

    const lines = [title, ""];
    if (summary) {
      lines.push(
        `**Aggregate:** \`${summary.status}\` across ` +
          `${Object.keys(summary.hosts).length} host(s) — selector ` +
          `\`${summaryHandle?.name}\` — ${summary.timestamp}` +
          (summary.error ? ` — error: ${summary.error}` : ""),
        "",
      );
    }

    lines.push("| Host | Status | Changes |", "| --- | --- | --- |");
    for (const [host, s] of Object.entries(hosts)) {
      lines.push(`| ${host} | \`${s.status}\` | ${s.changes.length} |`);
    }

    lines.push("", "## Members", "", "| Host | Member | Status |");
    lines.push("| --- | --- | --- |");
    for (const [host, s] of Object.entries(hosts)) {
      for (const [member, status] of Object.entries(s.members)) {
        lines.push(`| ${host} | ${member} | \`${status}\` |`);
      }
    }

    const allChanges = Object.entries(hosts).flatMap(([host, s]) =>
      s.changes.map((c) => `- ${host}: ${c}`)
    );
    if (allChanges.length) {
      lines.push("", "## Changes", "", ...allChanges);
    }

    return {
      markdown: lines.join("\n"),
      json: {
        role,
        method,
        executionStatus: context.executionStatus,
        selector: summaryHandle?.name ?? null,
        aggregate: summary?.status ?? null,
        hosts,
      },
    };
  },
};
