import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  configTable,
  fieldList,
  jsdocSummary,
  readmeHead,
  spliceDescription,
  SPLIT_HEADING,
  typeOf,
  yamlList,
} from "./gen_docs.ts";

Deno.test("typeOf renders scalars, arrays, enums, unions, records", () => {
  assertEquals(typeOf({ type: "string" }), "string");
  assertEquals(typeOf({ type: "boolean" }), "boolean");
  assertEquals(
    typeOf({ type: "array", items: { type: "string" } }),
    "string[]",
  );
  assertEquals(typeOf({ type: "string", enum: ["a", "b"] }), '"a" | "b"');
  assertEquals(
    typeOf({ anyOf: [{ type: "string" }, { type: "null" }] }),
    "string | null",
  );
  assertEquals(
    typeOf({ type: "object", additionalProperties: { type: "string" } }),
    "map<string, string>",
  );
  assertEquals(
    typeOf({ type: "object", additionalProperties: {} }),
    "map<string, any>",
  );
  assertEquals(
    typeOf({
      type: "array",
      items: { type: "object", properties: { p: {}, q: {} } },
    }),
    "{p, q}[]",
  );
});

Deno.test("configTable marks requiredness and flattens object arrays", () => {
  const rows = configTable({
    type: "object",
    properties: {
      fleet: { type: "string", description: "transport" },
      dirs: {
        type: "array",
        items: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      variables: { type: "object", additionalProperties: {}, default: {} },
    },
    required: ["fleet", "dirs"],
  });
  assertEquals(rows, [
    "| field | type | description |",
    "| --- | --- | --- |",
    "| `fleet` | string (required) | transport |",
    "| `dirs` | {path}[] (required) |  |",
    "| `dirs[].path` | string (required) |  |",
    "| `variables` | map<string, any> (default: {}) |  |",
  ]);
});

Deno.test("configTable escapes pipes in enum cells", () => {
  const rows = configTable({
    type: "object",
    properties: { ensure: { type: "string", enum: ["running", "stopped"] } },
    required: ["ensure"],
  });
  assertEquals(
    rows[2],
    '| `ensure` | "running" \\| "stopped" (required) |  |',
  );
});

Deno.test("fieldList renders inline name/type pairs", () => {
  assertEquals(
    fieldList({
      type: "object",
      properties: {
        status: { type: "string", enum: ["ok"] },
        error: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    }),
    '`status` "ok", `error` string | null',
  );
});

Deno.test("readmeHead strips the H1 and stops at the split heading", () => {
  const head = readmeHead(
    `# title\n\nintro\n\n## Example\n\nbody\n\n${SPLIT_HEADING}\n\nrest\n`,
  );
  assertEquals(head, "intro\n\n## Example\n\nbody");
});

Deno.test("readmeHead throws without the split heading", () => {
  assertThrows(() => readmeHead("# title\n\nintro\n"));
});

Deno.test("jsdocSummary takes the first paragraph as one line", () => {
  const src = `/**
 * Ensures things are
 * ensured.
 *
 * Implementation notes stay unpublished.
 */
export const model = {};
`;
  assertEquals(jsdocSummary(src), "Ensures things are ensured.");
});

Deno.test("jsdocSummary skips JSDoc on earlier exports", () => {
  const src = `/** Helper doc. */
export const helper = 1;

/**
 * The model's own summary.
 */
export const model = {};
`;
  assertEquals(jsdocSummary(src), "The model's own summary.");
});

Deno.test("spliceDescription replaces only the description block", () => {
  const manifest = `name: "@x/y"
description: |

  old text

  more old
dependencies:
  - "@swamp/ssh"
`;
  assertEquals(
    spliceDescription(manifest, "new one\n\nnew two"),
    `name: "@x/y"
description: |
  new one

  new two
dependencies:
  - "@swamp/ssh"
`,
  );
});

Deno.test("yamlList reads plain and quoted entries, stops at next key", () => {
  const manifest = `models:
  - role.ts
  - "apt.ts"
reports:
  - fleet_compliance.ts
labels:
  - ssh
`;
  assertEquals(yamlList(manifest, "models"), ["role.ts", "apt.ts"]);
  assertEquals(yamlList(manifest, "reports"), ["fleet_compliance.ts"]);
  assertEquals(yamlList(manifest, "missing"), []);
});
