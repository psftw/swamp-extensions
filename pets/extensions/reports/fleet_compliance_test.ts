import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { report } from "./fleet_compliance.ts";

const enc = new TextEncoder();

function ctx(
  handles: { name: string; specName: string; version: number }[],
  contents: Record<string, unknown>,
) {
  return {
    definition: { name: "vps" },
    methodName: "apply",
    executionStatus: "succeeded",
    modelType: "@psftw/pets/role",
    modelId: "id-1",
    dataHandles: handles,
    dataRepository: {
      getContent: (_t: string, _id: string, name: string, _v: number) =>
        Promise.resolve(
          name in contents ? enc.encode(JSON.stringify(contents[name])) : null,
        ),
    },
  };
}

Deno.test("fleet-compliance: renders aggregate, hosts, members, changes", async () => {
  const out = await report.execute(ctx(
    [
      { name: "web-1", specName: "state", version: 3 },
      { name: "tag:vps", specName: "summary", version: 1 },
    ],
    {
      "web-1": {
        status: "applied",
        changes: ["base-packages: installed curl"],
        members: { "base-packages": "applied", "docker-repo": "compliant" },
        timestamp: "2026-08-03T00:00:00Z",
      },
      "tag:vps": {
        status: "applied",
        hosts: { "web-1": "applied" },
        error: null,
        timestamp: "2026-08-03T00:00:00Z",
      },
    },
  ));
  assertStringIncludes(out.markdown, "# Fleet compliance — vps · apply");
  assertStringIncludes(out.markdown, "**Aggregate:** `applied`");
  assertStringIncludes(out.markdown, "| web-1 | `applied` | 1 |");
  assertStringIncludes(
    out.markdown,
    "| web-1 | docker-repo | `compliant` |",
  );
  assertStringIncludes(
    out.markdown,
    "- web-1: base-packages: installed curl",
  );
  assertEquals(out.json.aggregate, "applied");
  assertEquals(out.json.selector, "tag:vps");
});

Deno.test("fleet-compliance: graceful when the run produced no role state", async () => {
  const out = await report.execute(ctx([], {}));
  assertStringIncludes(out.markdown, "No role state was produced");
  assertEquals(out.json.role, "vps");
});
