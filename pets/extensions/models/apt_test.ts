import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createModelTestContext } from "@swamp-club/swamp-testing";
import { queuedRunModel } from "./_lib/test_run_model.ts";
import { model } from "./apt.ts";

function checkContext(
  packages: string[],
  stdout: Record<string, unknown>,
) {
  const globalArgs = { fleet: "ssh-fleet", packages };
  const { context: base, getWrittenResources } = createModelTestContext({
    globalArgs,
    methodName: "check",
  });
  const { runModel } = queuedRunModel([
    {
      ok: true,
      resources: [
        {
          name: "host1",
          specName: "runResult",
          kind: "resource",
          attributes: { host: "host1", stdout: JSON.stringify(stdout) },
        },
      ],
    },
  ]);
  return {
    context: { ...base, globalArgs, runModel },
    getWrittenResources,
  };
}

function applyContext(
  packages: string[],
  stdout: Record<string, unknown>,
) {
  const globalArgs = { fleet: "ssh-fleet", packages };
  const { context: base, getWrittenResources } = createModelTestContext({
    globalArgs,
    methodName: "apply",
  });
  const { runModel } = queuedRunModel([
    {
      ok: true,
      resources: [
        {
          name: "host1",
          specName: "runResult",
          kind: "resource",
          attributes: { host: "host1", stdout: JSON.stringify(stdout) },
        },
      ],
    },
  ]);
  return {
    context: { ...base, globalArgs, runModel },
    getWrittenResources,
  };
}

Deno.test("apt.check: compliant when every package is installed", async () => {
  const { context, getWrittenResources } = checkContext(["curl"], {
    status: { curl: "installed" },
    unavailable: [],
  });
  await model.methods.check.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.specName, "state");
  assertEquals(written.name, "host1");
  assertEquals(written.data.status, "compliant");
  assertEquals(written.data.missing, []);
  assertEquals(written.data.changes, []);
});

Deno.test("apt.check: non_compliant lists missing packages", async () => {
  const { context, getWrittenResources } = checkContext(["curl", "htop"], {
    status: { curl: "installed", htop: "missing" },
    unavailable: [],
  });
  await model.methods.check.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "non_compliant");
  assertEquals(written.data.missing, ["htop"]);
  assertEquals(written.data.changes, ["install htop"]);
});

Deno.test("apt.check: flags packages with no install candidate", async () => {
  const { context, getWrittenResources } = checkContext(["ghost-pkg"], {
    status: { "ghost-pkg": "missing" },
    unavailable: ["ghost-pkg"],
  });
  await model.methods.check.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "non_compliant");
  assertEquals(written.data.missing, ["ghost-pkg"]);
  assertEquals(written.data.changes, [
    "install ghost-pkg (no install candidate)",
  ]);
});

Deno.test("apt.apply: compliant when nothing was missing", async () => {
  const { context, getWrittenResources } = applyContext(["curl"], {
    status: { curl: "installed" },
    installed: [],
    error: null,
  });
  await model.methods.apply.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "compliant");
  assertEquals(written.data.changes, []);
  assertEquals(written.data.missing, []);
});

Deno.test("apt.apply: transport failure persists a selector-keyed failed state and rethrows", async () => {
  const globalArgs = { fleet: "ssh-fleet", packages: ["curl"] };
  const { context: base, getWrittenResources } = createModelTestContext({
    globalArgs,
    methodName: "apply",
  });
  const { runModel } = queuedRunModel([
    { ok: false, error: { message: "connect timeout" } },
  ]);
  const context = { ...base, globalArgs, runModel };
  await assertRejects(
    () => model.methods.apply.execute({ hosts: "tag:all" }, context),
    Error,
    "ssh-fleet.script(tag:all) failed: connect timeout",
  );
  const [written] = getWrittenResources();
  assertEquals(written.specName, "state");
  assertEquals(written.name, "tag:all");
  assertEquals(written.data.status, "failed");
  assertEquals(
    written.data.error,
    "ssh-fleet.script(tag:all) failed: connect timeout",
  );
});

Deno.test("apt.apply: applied when packages were installed", async () => {
  const { context, getWrittenResources } = applyContext(["curl", "htop"], {
    status: { curl: "installed", htop: "installed" },
    installed: ["htop"],
    error: null,
  });
  await model.methods.apply.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "applied");
  assertEquals(written.data.changes, ["install htop"]);
});
