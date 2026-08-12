import { assertEquals } from "jsr:@std/assert@1";
import { createModelTestContext } from "@swamp-club/swamp-testing";
import { queuedRunModel } from "./_lib/test_run_model.ts";
import { model } from "./systemd.ts";

function checkContext(
  globalArgs: {
    fleet: string;
    service: string;
    enabled: boolean;
    ensure: "running" | "stopped";
  },
  facts: { unitFileState: string; activeState: string },
) {
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
          attributes: { host: "host1", stdout: JSON.stringify(facts) },
        },
      ],
    },
  ]);
  return {
    context: { ...base, globalArgs, runModel },
    getWrittenResources,
  };
}

/** apply()'s facts carry `performed` — the steps the payload executed. */
function applyContext(
  globalArgs: {
    fleet: string;
    service: string;
    enabled: boolean;
    ensure: "running" | "stopped";
  },
  facts: {
    unitFileState: string;
    activeState: string;
    error?: string | null;
    performed?: string[];
  },
) {
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
          attributes: { host: "host1", stdout: JSON.stringify(facts) },
        },
      ],
    },
  ]);
  return {
    context: { ...base, globalArgs, runModel },
    getWrittenResources,
  };
}

Deno.test("systemd.check: compliant when enabled+active match desired", async () => {
  const { context, getWrittenResources } = checkContext(
    { fleet: "ssh-fleet", service: "nginx", enabled: true, ensure: "running" },
    { unitFileState: "enabled", activeState: "active" },
  );
  await model.methods.check.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "compliant");
  assertEquals(written.data.changes, []);
});

Deno.test("systemd.check: drift reports enable+start changes", async () => {
  const { context, getWrittenResources } = checkContext(
    { fleet: "ssh-fleet", service: "nginx", enabled: true, ensure: "running" },
    { unitFileState: "disabled", activeState: "inactive" },
  );
  await model.methods.check.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "non_compliant");
  assertEquals(written.data.changes, [
    "systemctl enable nginx",
    "systemctl start nginx",
  ]);
});

Deno.test("systemd.check: drift reports disable+stop when unit should be stopped", async () => {
  const { context, getWrittenResources } = checkContext(
    {
      fleet: "ssh-fleet",
      service: "telnet",
      enabled: false,
      ensure: "stopped",
    },
    { unitFileState: "enabled", activeState: "active" },
  );
  await model.methods.check.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "non_compliant");
  assertEquals(written.data.changes, [
    "systemctl disable telnet",
    "systemctl stop telnet",
  ]);
});

Deno.test("systemd.apply: compliant when already enabled+active", async () => {
  const desired = {
    fleet: "ssh-fleet",
    service: "nginx",
    enabled: true,
    ensure: "running" as const,
  };
  const { context, getWrittenResources } = applyContext(desired, {
    unitFileState: "enabled",
    activeState: "active",
    error: null,
    performed: [],
  });
  await model.methods.apply.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "compliant");
  assertEquals(written.data.changes, []);
});

Deno.test("systemd.apply: applied when enable+start ran", async () => {
  const desired = {
    fleet: "ssh-fleet",
    service: "nginx",
    enabled: true,
    ensure: "running" as const,
  };
  const { context, getWrittenResources } = applyContext(desired, {
    unitFileState: "enabled",
    activeState: "active",
    error: null,
    performed: ["enable", "start"],
  });
  await model.methods.apply.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "applied");
  assertEquals(written.data.changes, ["enable", "start"]);
});
