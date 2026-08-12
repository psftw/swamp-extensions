/**
 * Regenerate the two derived layers of the payload pipeline:
 *   - the GENERATED TYPES block inside each payloads/*.py (from _lib/cfg.ts)
 *   - extensions/models/_payloads/*.ts embedding each payload verbatim
 * Run from pets/: deno task gen
 */
import { z } from "npm:zod@4";
import { payloadTypes } from "../extensions/models/_lib/cfg.ts";

/** Opening marker of the generated TypedDict block in payloads/*.py. */
export const TYPES_BEGIN =
  "# BEGIN GENERATED TYPES — edit extensions/models/_lib/cfg.ts and run `deno task gen`.";
/** Closing marker of the generated TypedDict block in payloads/*.py. */
export const TYPES_END = "# END GENERATED TYPES";

/**
 * Escape arbitrary text for embedding in a TS template literal. Backslash
 * doubling must run first: the later passes insert deliberate escape
 * backslashes that must not be re-escaped. LF-only input — the parser
 * normalizes CR/CRLF to LF in cooked values, so CR would not round-trip
 * (guarded in gen_payloads_test.ts).
 */
export function escape(source: string): string {
  return source
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("${", "\\${");
}

/** Render the generated _payloads/<mod>.ts embedding the payload verbatim. */
export function emitModule(mod: string, source: string): string {
  return `// GENERATED from payloads/${mod}.py — edit that file and run \`deno task gen\`.
/** Python source of payloads/${mod}.py, embedded verbatim. */
export const source: string =
  \`${escape(source)}\`;
`;
}

function pyType(schema: z.ZodType, named: Map<z.ZodType, string>): string {
  const name = named.get(schema);
  if (name) return name;
  if (schema instanceof z.ZodNullable) {
    return `${pyType(schema.unwrap() as z.ZodType, named)} | None`;
  }
  if (schema instanceof z.ZodArray) {
    return `list[${pyType(schema.element as z.ZodType, named)}]`;
  }
  if (schema instanceof z.ZodString) return "str";
  if (schema instanceof z.ZodBoolean) return "bool";
  if (schema instanceof z.ZodNumber) {
    return z.toJSONSchema(schema).type === "integer" ? "int" : "float";
  }
  throw new Error(`no python mapping for ${schema.constructor.name}`);
}

/** Render the GENERATED TYPES block: one TypedDict per named cfg schema. */
export function emitTypes(types: Record<string, z.ZodObject>): string {
  const named = new Map<z.ZodType, string>(
    Object.entries(types).map(([name, schema]) => [schema, name]),
  );
  let notRequired = false;
  const classes = Object.entries(types).map(([name, schema]) => {
    const fields = Object.entries(schema.shape).map(([key, field]) => {
      if (field instanceof z.ZodOptional) {
        notRequired = true;
        return `    ${key}: NotRequired[${
          pyType(field.unwrap() as z.ZodType, named)
        }]`;
      }
      return `    ${key}: ${pyType(field as z.ZodType, named)}`;
    });
    return `class ${name}(TypedDict):\n${fields.join("\n")}`;
  });
  const imports = notRequired
    ? "from typing import NotRequired, TypedDict"
    : "from typing import TypedDict";
  return [TYPES_BEGIN, imports, "", "", classes.join("\n\n\n"), TYPES_END]
    .join("\n");
}

function markerRange(pySource: string): [string[], number, number] {
  const lines = pySource.split("\n");
  const begin = lines.findIndex((l) => l.startsWith("# BEGIN GENERATED TYPES"));
  const end = lines.indexOf(TYPES_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error("payload missing GENERATED TYPES markers");
  }
  return [lines, begin, end];
}

/** Slice the current GENERATED TYPES block out of a payload source. */
export function extractTypes(pySource: string): string {
  const [lines, begin, end] = markerRange(pySource);
  return lines.slice(begin, end + 1).join("\n");
}

/** Replace the GENERATED TYPES block in a payload source. */
export function injectTypes(pySource: string, block: string): string {
  const [lines, begin, end] = markerRange(pySource);
  return [...lines.slice(0, begin), block, ...lines.slice(end + 1)].join("\n");
}

if (import.meta.main) {
  const srcDir = new URL("../payloads/", import.meta.url);
  const outDir = new URL("../extensions/models/_payloads/", import.meta.url);

  const modules: string[] = [];
  for await (const entry of Deno.readDir(srcDir)) {
    if (entry.isFile && entry.name.endsWith(".py")) {
      modules.push(entry.name.slice(0, -".py".length));
    }
  }
  modules.sort();

  const stray = Object.keys(payloadTypes).filter((m) => !modules.includes(m));
  if (stray.length) {
    throw new Error(`payloadTypes entries without a payload: ${stray}`);
  }

  for (const mod of modules) {
    const types = payloadTypes[mod];
    if (!types) throw new Error(`no payloadTypes entry for ${mod}`);
    const pyUrl = new URL(`${mod}.py`, srcDir);
    const source = injectTypes(
      await Deno.readTextFile(pyUrl),
      emitTypes(types),
    );
    await Deno.writeTextFile(pyUrl, source);
    await Deno.writeTextFile(
      new URL(`${mod}.ts`, outDir),
      emitModule(mod, source),
    );
  }

  for await (const entry of Deno.readDir(outDir)) {
    if (entry.isFile && entry.name.endsWith(".ts")) {
      const mod = entry.name.slice(0, -".ts".length);
      if (!modules.includes(mod)) {
        await Deno.remove(new URL(entry.name, outDir));
      }
    }
  }
}
