/**
 * Rebuild the manifest.yaml `description` from two sources: the README head
 * (everything between the H1 and `## How it works`) and an API reference
 * generated from the model/report modules — zod schemas via z.toJSONSchema,
 * each module's first JSDoc paragraph as its published summary.
 * Run from pets/: deno task gen:docs
 */
import { z } from "npm:zod@4";

/** Everything above this README heading becomes the description preamble. */
export const SPLIT_HEADING = "## How it works";

/** Read a top-level `key:` string list from the swamp-fmt-canonical manifest. */
export function yamlList(manifest: string, key: string): string[] {
  const lines = manifest.split("\n");
  const start = lines.indexOf(`${key}:`);
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^ {2}- (?:"([^"]+)"|(\S+))$/);
    if (!m) break;
    out.push(m[1] ?? m[2]);
  }
  return out;
}

/** Replace the `description: |` block, leaving every other byte alone. */
export function spliceDescription(
  manifest: string,
  description: string,
): string {
  const lines = manifest.split("\n");
  const start = lines.findIndex((l) => l.startsWith("description:"));
  if (start < 0) throw new Error("manifest.yaml: no description key");
  let end = start + 1;
  while (
    end < lines.length && (lines[end] === "" || lines[end].startsWith("  "))
  ) {
    end++;
  }
  const block = description.trimEnd().split("\n")
    .map((l) => (l.length ? `  ${l}` : ""));
  return [
    ...lines.slice(0, start),
    "description: |",
    ...block,
    ...lines.slice(end),
  ].join("\n");
}

/** README content between the H1 line and SPLIT_HEADING. */
export function readmeHead(readme: string): string {
  const idx = readme.indexOf(`\n${SPLIT_HEADING}\n`);
  if (idx < 0) {
    throw new Error(`README.md: missing "${SPLIT_HEADING}" heading`);
  }
  const lines = readme.slice(0, idx).split("\n");
  if (!lines[0].startsWith("# ")) {
    throw new Error("README.md must start with an H1");
  }
  return lines.slice(1).join("\n").trim();
}

/** First JSDoc paragraph of the exported model/report, as one line. */
export function jsdocSummary(source: string): string {
  // Forbid */ inside the capture so only the JSDoc block immediately
  // preceding the export matches, not one on an earlier export.
  const m = source.match(
    /\/\*\*((?:[^*]|\*(?!\/))*)\*\/\nexport const (?:model|report)\b/,
  );
  if (!m) throw new Error("missing JSDoc on the exported model/report");
  const text = m[1].split("\n")
    .map((l) => l.replace(/^\s*\*? ?/, ""))
    .join("\n")
    .trim();
  return text.split(/\n\s*\n/)[0].replaceAll("\n", " ").trim();
}

/** The subset of JSON Schema that z.toJSONSchema emits for pets schemas. */
interface JsonSchema {
  type?: string | string[];
  anyOf?: JsonSchema[];
  enum?: unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: JsonSchema | boolean;
  description?: string;
  format?: string;
  default?: unknown;
}

/** Compact type label for a schema node. */
export function typeOf(s: JsonSchema): string {
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (s.anyOf) return s.anyOf.map(typeOf).join(" | ");
  if (s.type === "array") return `${typeOf(s.items ?? {})}[]`;
  if (s.type === "object") {
    if (s.properties) return `{${Object.keys(s.properties).join(", ")}}`;
    const v = s.additionalProperties;
    return `map<string, ${
      typeof v === "object" && v !== null ? typeOf(v) : "any"
    }>`;
  }
  return typeof s.type === "string" ? s.type : "any";
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

function configRows(
  schema: JsonSchema,
  prefix: string,
): [string, string, string][] {
  const req = new Set(schema.required ?? []);
  const rows: [string, string, string][] = [];
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const notes: string[] = [];
    if (prop.format) notes.push(prop.format);
    if ("default" in prop) {
      notes.push(`default: ${JSON.stringify(prop.default)}`);
    } else notes.push(req.has(name) ? "required" : "optional");
    rows.push([
      `\`${prefix}${name}\``,
      cell(`${typeOf(prop)} (${notes.join(", ")})`),
      cell(prop.description ?? ""),
    ]);
    const items = prop.type === "array" ? prop.items : undefined;
    if (items?.properties) {
      rows.push(...configRows(items, `${prefix}${name}[].`));
    }
  }
  return rows;
}

/** Markdown table of an object schema's fields, object arrays flattened. */
export function configTable(schema: JsonSchema): string[] {
  return [
    "| field | type | description |",
    "| --- | --- | --- |",
    ...configRows(schema, "").map(([f, t, d]) => `| ${f} | ${t} | ${d} |`),
  ];
}

/** Inline `name` type list of an object schema's fields. */
export function fieldList(schema: JsonSchema): string {
  return Object.entries(schema.properties ?? {})
    .map(([name, p]) => `\`${name}\` ${typeOf(p)}`)
    .join(", ");
}

function argsInline(schema: JsonSchema): string {
  return Object.entries(schema.properties ?? {})
    .map(([name, p]) =>
      `\`${name}\` (${typeOf(p)})${p.description ? `: ${p.description}` : ""}`
    )
    .join("; ");
}

/** The exported-model surface the docs are generated from. */
interface ModelDef {
  type: string;
  globalArguments: z.ZodType;
  methods: Record<string, { description: string; arguments: z.ZodType }>;
  resources: Record<string, { description: string; schema: z.ZodType }>;
  reports: string[];
}

/** The exported-report surface the docs are generated from. */
interface ReportDef {
  name: string;
  description: string;
  scope: string;
}

export function modelSection(def: ModelDef, summary: string): string {
  const out: string[] = [`### \`${def.type}\``, "", summary, ""];
  const cfg = z.toJSONSchema(def.globalArguments, {
    io: "input",
  }) as JsonSchema;
  out.push("**Configuration**", "", ...configTable(cfg), "");
  const methods = Object.entries(def.methods);
  const argSchemas = methods.map(([, m]) =>
    z.toJSONSchema(m.arguments, { io: "input" }) as JsonSchema
  );
  const uniform = argSchemas.every((s) =>
    JSON.stringify(s) === JSON.stringify(argSchemas[0])
  );
  const shared = uniform ? argsInline(argSchemas[0]) : "";
  out.push(shared ? `**Methods** — each takes ${shared}` : "**Methods**", "");
  methods.forEach(([name, m], i) => {
    out.push(`- \`${name}\` — ${m.description}`);
    if (!uniform) {
      for (const [arg, p] of Object.entries(argSchemas[i].properties ?? {})) {
        out.push(
          `  - \`${arg}\` (${typeOf(p)})${
            p.description ? `: ${p.description}` : ""
          }`,
        );
      }
    }
  });
  out.push("", "**Resources**", "");
  for (const [name, r] of Object.entries(def.resources)) {
    const schema = z.toJSONSchema(r.schema) as JsonSchema;
    out.push(`- \`${name}\` — ${r.description}. Fields: ${fieldList(schema)}`);
  }
  if (def.reports.length) {
    out.push(
      "",
      `Every run renders ${def.reports.map((r) => `\`${r}\``).join(", ")}.`,
    );
  }
  return out.join("\n");
}

export function reportSection(def: ReportDef, boundTo: string[]): string {
  const out: string[] = [
    `### \`${def.name}\``,
    "",
    def.description.replace(/\.?$/, "."),
    "",
  ];
  if (boundTo.length) {
    out.push(
      `Rendered automatically after every ${
        boundTo.map((t) => `\`${t}\``).join(", ")
      } run; fetch with \`swamp report get ${def.name} --model <name>\`.`,
    );
  } else {
    out.push(`Scope: ${def.scope}.`);
  }
  return out.join("\n");
}

if (import.meta.main) {
  const manifestText = await Deno.readTextFile("manifest.yaml");
  const readme = await Deno.readTextFile("README.md");

  const reportBindings = new Map<string, string[]>();
  const modelSections: string[] = [];
  for (const file of yamlList(manifestText, "models")) {
    const path = `extensions/models/${file}`;
    const src = await Deno.readTextFile(path);
    const { model } = await import(
      new URL(`../${path}`, import.meta.url).href
    ) as { model: ModelDef };
    for (const rep of model.reports) {
      reportBindings.set(rep, [...(reportBindings.get(rep) ?? []), model.type]);
    }
    modelSections.push(modelSection(model, jsdocSummary(src)));
  }

  const reportSections: string[] = [];
  for (const file of yamlList(manifestText, "reports")) {
    const path = `extensions/reports/${file}`;
    const { report } = await import(
      new URL(`../${path}`, import.meta.url).href
    ) as { report: ReportDef };
    reportSections.push(
      reportSection(report, reportBindings.get(report.name) ?? []),
    );
  }

  const api = [
    "## Models",
    "",
    modelSections.join("\n\n"),
    ...(reportSections.length
      ? ["", "## Reports", "", reportSections.join("\n\n")]
      : []),
  ].join("\n");
  const description = `${readmeHead(readme)}\n\n${api}`;
  await Deno.writeTextFile(
    "manifest.yaml",
    spliceDescription(manifestText, description),
  );
  console.log(
    `manifest.yaml: description rebuilt — README head + ${modelSections.length} models, ${reportSections.length} reports`,
  );
}
