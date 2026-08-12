/**
 * Run every pre-release check — local (fmt, lint, types, tests), the
 * manifest-description regeneration (gen:docs), and registry-side checks
 * (manifest fmt, quality score, push dry-run with the adversarial-review
 * gate) — and print a human-readable summary.
 * Exits non-zero when any check fails.
 *
 * Usage: deno task preflight [--channel beta|rc]
 */

interface Step {
  name: string;
  cmd: string[];
}

interface StepResult extends Step {
  ok: boolean;
  ms: number;
  output: string;
}

interface Quality {
  earnedPoints: number;
  maxEarnablePoints: number;
  factors: {
    label: string;
    earnedPoints: number;
    maxPoints: number;
    status: string;
  }[];
  dependencyTrust?: {
    audited: {
      name: string;
      version: string;
      registry: string;
      license: string;
      passed: boolean;
    }[];
  };
}

interface ReviewWarning {
  ruleId: string;
  message: string;
  file?: string;
}

const channelIdx = Deno.args.indexOf("--channel");
const channel = channelIdx >= 0 ? Deno.args[channelIdx + 1] : undefined;
const deno = Deno.execPath();

const steps: Step[] = [
  { name: "deno fmt --check", cmd: [deno, "fmt", "--check"] },
  { name: "deno lint", cmd: [deno, "lint"] },
  { name: "ruff (payloads)", cmd: ["uvx", "ruff@0.16.1", "check", "payloads"] },
  {
    name: "mypy (payloads)",
    cmd: [
      "uvx",
      "mypy@2.3.0",
      "--check-untyped-defs",
      "--python-version",
      "3.13",
      "payloads",
    ],
  },
  { name: "deno check", cmd: [deno, "task", "check"] },
  { name: "deno test", cmd: [deno, "task", "test"] },
  { name: "gen docs", cmd: [deno, "task", "gen:docs"] },
  {
    name: "manifest fmt",
    cmd: ["swamp", "extension", "fmt", "manifest.yaml", "--check", "--json"],
  },
  {
    name: "quality score",
    cmd: ["swamp", "extension", "quality", "manifest.yaml", "--json"],
  },
  {
    name: channel ? `push dry-run (${channel})` : "push dry-run",
    cmd: [
      "swamp",
      "extension",
      "push",
      "manifest.yaml",
      "--dry-run",
      ...(channel ? ["--channel", channel] : []),
      "--json",
    ],
  },
];

/** Extract every top-level JSON object from mixed CLI output. */
function jsonObjects(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // non-JSON brace noise (e.g. log lines) — skip
        }
        start = -1;
      }
    }
  }
  return out;
}

const results: StepResult[] = [];
for (const step of steps) {
  const t0 = performance.now();
  let ok = false;
  let output = "";
  try {
    const proc = await new Deno.Command(step.cmd[0], {
      args: step.cmd.slice(1),
      stdout: "piped",
      stderr: "piped",
    }).output();
    ok = proc.success;
    output = new TextDecoder().decode(proc.stdout) +
      new TextDecoder().decode(proc.stderr);
  } catch (err) {
    output = err instanceof Error ? err.message : String(err);
  }
  const ms = Math.round(performance.now() - t0);
  results.push({ ...step, ok, ms, output });
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  ${step.name.padEnd(22)} ${
      String(ms).padStart(5)
    }ms`,
  );
}

const failed = results.filter((r) => !r.ok);
for (const r of failed) {
  console.log(`\n--- ${r.name} output ---`);
  console.log(r.output.slice(-3000).trim());
}

const quality = jsonObjects(
  results.find((r) => r.name === "quality score")?.output ?? "",
).find((o) => (o as Quality).factors !== undefined) as Quality | undefined;
const dryObjs = jsonObjects(
  results.find((r) => r.name.startsWith("push dry-run"))?.output ?? "",
);
const warnings =
  (dryObjs.find((o) => (o as Record<string, unknown>).reviewRuleWarnings) as
    | { reviewRuleWarnings: ReviewWarning[] }
    | undefined)?.reviewRuleWarnings ?? [];

console.log("");
if (quality) {
  const missing = quality.factors.filter((f) => f.status !== "earned");
  console.log(
    `quality  ${quality.earnedPoints}/${quality.maxEarnablePoints}` +
      (missing.length
        ? ` — missing: ${
          missing.map((f) => `${f.label} (${f.earnedPoints}/${f.maxPoints})`)
            .join(", ")
        }`
        : ""),
  );
}
const stale = warnings.find((w) => w.ruleId === "adversarial-review-report");
if (stale) {
  console.log(`review   MISSING or stale — write the report at:`);
  console.log(`         ${stale.file}`);
} else {
  const flagged = warnings
    .filter((w) => w.ruleId === "adversarial-review-dimension-issue")
    .map((w) => w.message.match(/^Dimension (\S+)/)?.[1] ?? "?");
  console.log(
    `review   report present` +
      (flagged.length ? ` — flagged: ${flagged.join(", ")}` : ""),
  );
}
for (const d of quality?.dependencyTrust?.audited ?? []) {
  console.log(
    `deps     ${d.name}@${d.version} (${d.registry}, ${d.license}) — ${
      d.passed ? "passed" : "FAILED"
    }`,
  );
}
console.log(
  `\n${
    failed.length ? `${failed.length} FAILING` : "all checks passed"
  } — next: swamp extension push manifest.yaml${
    channel ? ` --channel ${channel}` : ""
  }`,
);
if (failed.length) Deno.exit(1);
