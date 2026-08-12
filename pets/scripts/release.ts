/**
 * Release to the swamp registry. Runs every pre-release check — local (fmt,
 * lint, types, tests), the manifest-description regeneration (gen:docs), and
 * registry-side checks (manifest fmt, version bump, quality score, push
 * dry-run with the adversarial-review gate) — then shows the exact push
 * command and asks for confirmation before pushing.
 *
 * The channel defaults to beta. Release notes come from the CHANGELOG.md
 * entry for the manifest version. Adversarial-review reports are per-release
 * artifacts in reviews/ (gitignored) via SWAMP_EXTENSION_REVIEW_DIR; when
 * none exists for the current content hash, the dry-run's skeleton is
 * written there and its path printed for hand-editing.
 * Exits non-zero when any check fails, the review is pending, the manifest
 * version hasn't been bumped, or the CHANGELOG entry is missing.
 *
 * Usage: deno task release [--channel beta|rc|stable]
 */

interface Step {
  name: string;
  cmd: string[];
  env?: Record<string, string>;
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
  skeleton?: string;
}

interface VersionInfo {
  currentPublished: string | null;
  nextVersion: string;
}

const channelIdx = Deno.args.indexOf("--channel");
const channel = channelIdx >= 0 ? Deno.args[channelIdx + 1] : "beta";
const deno = Deno.execPath();
const reviewDir = `${Deno.cwd()}/reviews`;

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
    name: "next version",
    cmd: [
      "swamp",
      "extension",
      "version",
      "--manifest",
      "manifest.yaml",
      "--json",
    ],
  },
  {
    name: "quality score",
    cmd: ["swamp", "extension", "quality", "manifest.yaml", "--json"],
  },
  {
    name: `push dry-run (${channel})`,
    cmd: [
      "swamp",
      "extension",
      "push",
      "manifest.yaml",
      "--dry-run",
      "--channel",
      channel,
      "--json",
    ],
    env: { SWAMP_EXTENSION_REVIEW_DIR: reviewDir },
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

/** The CHANGELOG.md section body for a version — the release notes. */
function changelogEntry(changelog: string, version: string): string | null {
  for (const section of changelog.split(/^## /m).slice(1)) {
    const nl = section.indexOf("\n");
    if (section.slice(0, nl).trim() === version) {
      return section.slice(nl + 1).trim();
    }
  }
  return null;
}

const results: StepResult[] = [];
for (const step of steps) {
  const t0 = performance.now();
  let ok = false;
  let output = "";
  try {
    const proc = await new Deno.Command(step.cmd[0], {
      args: step.cmd.slice(1),
      env: step.env,
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

const version = jsonObjects(
  results.find((r) => r.name === "next version")?.output ?? "",
).find((o) => (o as VersionInfo).nextVersion !== undefined) as
  | VersionInfo
  | undefined;
const manifest = await Deno.readTextFile("manifest.yaml");
const manifestVersion = manifest.match(/^version: "([^"]+)"/m)?.[1] ?? "";
const extensionName = manifest.match(/^name: "([^"]+)"/m)?.[1] ?? "";
const versionOk = !version || manifestVersion === version.nextVersion;
const notes = changelogEntry(
  await Deno.readTextFile("CHANGELOG.md").catch(() => ""),
  manifestVersion,
);

console.log("");
if (version) {
  console.log(
    `version  manifest ${manifestVersion}` +
      (versionOk
        ? ""
        : ` — expected next ${version.nextVersion}; bump manifest + model versions`),
  );
}
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
if (notes === null) {
  console.log(
    `notes    MISSING — add a "## ${manifestVersion}" entry to CHANGELOG.md`,
  );
} else if (notes.length > 5000) {
  console.log(`notes    TOO LONG — ${notes.length} chars (registry max 5000)`);
} else {
  console.log(
    `notes    ${notes.split("\n")[0]}${notes.includes("\n") ? " […]" : ""}`,
  );
}
const stale = warnings.find((w) => w.ruleId === "adversarial-review-report");
if (stale) {
  const exists = stale.file &&
    (await Deno.stat(stale.file).then(() => true).catch(() => false));
  if (!exists && stale.file && stale.skeleton) {
    await Deno.mkdir(stale.file.slice(0, stale.file.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.writeTextFile(
      stale.file,
      stale.skeleton.replace("<ISO-8601 timestamp>", new Date().toISOString()) +
        "\n",
    );
    console.log(
      `review   PENDING — skeleton written; set each verdict (pass/issue/na) in:`,
    );
  } else {
    console.log(`review   INCOMPLETE — finish the report at:`);
  }
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
const problems = [
  ...(failed.length ? [`${failed.length} FAILING`] : []),
  ...(stale ? ["review pending"] : []),
  ...(versionOk ? [] : ["version not bumped"]),
  ...(notes !== null && notes.length <= 5000 ? [] : ["release notes"]),
];
if (problems.length || notes === null) {
  console.log(
    `\n${problems.join(", ")} — fix the above, then re-run deno task release`,
  );
  Deno.exit(1);
}

const shellNotes = `'${notes.replaceAll("'", `'\\''`)}'`;
console.log(
  `\nall checks passed — push command:\n` +
    `  SWAMP_EXTENSION_REVIEW_DIR="$PWD/reviews" swamp extension push manifest.yaml \\\n` +
    `    --channel ${channel} --yes --release-notes ${shellNotes}`,
);
if (!confirm(`\npush ${extensionName}@${manifestVersion} to ${channel} now?`)) {
  console.log("not pushed — run the command above when ready");
  Deno.exit(0);
}
const push = new Deno.Command("swamp", {
  args: [
    "extension",
    "push",
    "manifest.yaml",
    "--channel",
    channel,
    "--release-notes",
    notes,
    "--yes",
  ],
  env: { SWAMP_EXTENSION_REVIEW_DIR: reviewDir },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).spawn();
Deno.exit((await push.status).code);
