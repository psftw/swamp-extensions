import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createModelTestContext } from "@swamp-club/swamp-testing";
import { queuedRunModel } from "./_lib/test_run_model.ts";
import { model } from "./role.ts";

function roleContext(
  globalArgs: {
    fleet: string;
    requireCharDevices: string[];
    members: string[];
  },
  methodName: string,
) {
  const { context: base, getWrittenResources } = createModelTestContext({
    globalArgs,
    methodName,
  });
  return { base, getWrittenResources };
}

Deno.test("role.check: sequences members in order and rolls up per-host state", async () => {
  const globalArgs = {
    fleet: "ssh-fleet",
    requireCharDevices: [],
    members: ["member-a", "member-b"],
  };
  const { base, getWrittenResources } = roleContext(globalArgs, "check");
  const { runModel, calls } = queuedRunModel([
    {
      ok: true,
      resources: [{
        name: "host1",
        specName: "state",
        kind: "resource",
        attributes: { status: "compliant", changes: [] },
      }],
    },
    {
      ok: true,
      resources: [{
        name: "host1",
        specName: "state",
        kind: "resource",
        attributes: { status: "non_compliant", changes: ["do the thing"] },
      }],
    },
  ]);
  const context = { ...base, globalArgs, runModel };

  await model.methods.check.execute({ hosts: "tag:all" }, context);

  assertEquals(calls.map((c) => [c.definition, c.method]), [
    ["member-a", "check"],
    ["member-b", "check"],
  ]);
  assertEquals(calls[0].arguments?.hosts, "tag:all");

  const [written] = getWrittenResources();
  assertEquals(written.name, "host1");
  assertEquals(written.data.status, "non_compliant");
  assertEquals(written.data.changes, ["member-b: do the thing"]);
  assertEquals(written.data.members, {
    "member-a": "compliant",
    "member-b": "non_compliant",
  });
  assertEquals(written.data.error, null);
});

Deno.test("role.check: compliant rollup when no member reports drift", async () => {
  const globalArgs = {
    fleet: "ssh-fleet",
    requireCharDevices: [],
    members: ["member-a"],
  };
  const { base, getWrittenResources } = roleContext(globalArgs, "check");
  const { runModel } = queuedRunModel([
    {
      ok: true,
      resources: [{
        name: "host1",
        specName: "state",
        kind: "resource",
        attributes: { status: "compliant", changes: [] },
      }],
    },
  ]);
  const context = { ...base, globalArgs, runModel };

  await model.methods.check.execute({ hosts: "tag:all" }, context);

  const [written] = getWrittenResources();
  assertEquals(written.data.status, "compliant");
  assertEquals(written.data.error, null);
});

Deno.test("role.apply: refuses to converge when a required char device is missing", async () => {
  const globalArgs = {
    fleet: "ssh-fleet",
    requireCharDevices: ["/dev/kvm"],
    members: ["member-a"],
  };
  const { base, getWrittenResources } = roleContext(globalArgs, "apply");
  const { runModel, calls } = queuedRunModel([
    { ok: false, error: { message: "no such device" } },
  ]);
  const context = { ...base, globalArgs, runModel };

  await assertRejects(
    () => model.methods.apply.execute({ hosts: "tag:all" }, context),
    Error,
    "required device check (test -c /dev/kvm) failed — refusing to converge: no such device",
  );

  assertEquals(calls.length, 1);
  assertEquals(calls[0].definition, "ssh-fleet");
  assertEquals(calls[0].method, "exec");
  assertEquals(calls[0].arguments, {
    hosts: "tag:all",
    command: "test -c /dev/kvm",
  });

  const [written] = getWrittenResources();
  assertEquals(written.specName, "summary");
  assertEquals(written.name, "tag:all");
  assertEquals(written.data.status, "failed");
  assertEquals(written.data.hosts, {});
  assertEquals(
    written.data.error,
    "required device check (test -c /dev/kvm) failed — refusing to converge: no such device",
  );
});

Deno.test("role.apply: probes every required char device with a single combined test", async () => {
  const globalArgs = {
    fleet: "ssh-fleet",
    requireCharDevices: ["/dev/kvm", "/dev/net/tun"],
    members: ["member-a"],
  };
  const { base } = roleContext(globalArgs, "apply");
  const { runModel, calls } = queuedRunModel([
    { ok: false, error: { message: "missing" } },
  ]);
  const context = { ...base, globalArgs, runModel };

  await assertRejects(() =>
    model.methods.apply.execute({ hosts: "tag:all" }, context)
  );

  assertEquals(
    calls[0].arguments?.command,
    "test -c /dev/kvm && test -c /dev/net/tun",
  );
});

Deno.test("role.apply: aborts remaining members once one reports a failed state", async () => {
  const globalArgs = {
    fleet: "ssh-fleet",
    requireCharDevices: [],
    members: ["member-a", "member-b"],
  };
  const { base, getWrittenResources } = roleContext(globalArgs, "apply");
  const { runModel, calls } = queuedRunModel([
    {
      ok: true,
      resources: [{
        name: "host1",
        specName: "state",
        kind: "resource",
        attributes: { status: "failed", changes: [] },
      }],
    },
  ]);
  const context = { ...base, globalArgs, runModel };

  await assertRejects(
    () => model.methods.apply.execute({ hosts: "tag:all" }, context),
    Error,
    "member-a.apply reported failed state — aborting the remaining members",
  );

  assertEquals(calls.map((c) => c.definition), ["member-a"]);

  const [written] = getWrittenResources();
  assertEquals(written.specName, "summary");
  assertEquals(written.name, "tag:all");
  assertEquals(written.data.status, "failed");
  assertEquals(written.data.hosts, {});
});

Deno.test("role.apply: applies every member in order and rolls up applied state", async () => {
  const globalArgs = {
    fleet: "ssh-fleet",
    requireCharDevices: [],
    members: ["member-a", "member-b"],
  };
  const { base, getWrittenResources } = roleContext(globalArgs, "apply");
  const { runModel, calls } = queuedRunModel([
    {
      ok: true,
      resources: [{
        name: "host1",
        specName: "state",
        kind: "resource",
        attributes: { status: "applied", changes: ["installed x"] },
      }],
    },
    {
      ok: true,
      resources: [{
        name: "host1",
        specName: "state",
        kind: "resource",
        attributes: { status: "applied", changes: [] },
      }],
    },
  ]);
  const context = { ...base, globalArgs, runModel };

  await model.methods.apply.execute({ hosts: "tag:all" }, context);

  assertEquals(calls.map((c) => [c.definition, c.method]), [
    ["member-a", "apply"],
    ["member-b", "apply"],
  ]);
  const written = getWrittenResources();
  assertEquals(written[0].data.status, "applied");
  assertEquals(written[0].data.changes, ["member-a: installed x"]);

  const summary = written.find((r) => r.specName === "summary")!;
  assertEquals(summary.name, "tag:all");
  assertEquals(summary.data.status, "applied");
  assertEquals(summary.data.hosts, { host1: "applied" });
  assertEquals(summary.data.error, null);
});

Deno.test("role.apply: per-host and summary status is compliant when no member reports changes", async () => {
  const globalArgs = {
    fleet: "ssh-fleet",
    requireCharDevices: [],
    members: ["member-a"],
  };
  const { base, getWrittenResources } = roleContext(globalArgs, "apply");
  const { runModel } = queuedRunModel([
    {
      ok: true,
      resources: [{
        name: "host1",
        specName: "state",
        kind: "resource",
        attributes: { status: "applied", changes: [] },
      }],
    },
  ]);
  const context = { ...base, globalArgs, runModel };

  await model.methods.apply.execute({ hosts: "tag:all" }, context);

  const written = getWrittenResources();
  const state = written.find((r) => r.specName === "state")!;
  assertEquals(state.data.status, "compliant");

  const summary = written.find((r) => r.specName === "summary")!;
  assertEquals(summary.name, "tag:all");
  assertEquals(summary.data.status, "compliant");
  assertEquals(summary.data.hosts, { host1: "compliant" });
});

Deno.test("role.check: writes a summary resource named for the hosts selector", async () => {
  const globalArgs = {
    fleet: "ssh-fleet",
    requireCharDevices: [],
    members: ["member-a"],
  };
  const { base, getWrittenResources } = roleContext(globalArgs, "check");
  const { runModel } = queuedRunModel([
    {
      ok: true,
      resources: [{
        name: "host1",
        specName: "state",
        kind: "resource",
        attributes: { status: "compliant", changes: [] },
      }],
    },
  ]);
  const context = { ...base, globalArgs, runModel };

  await model.methods.check.execute({ hosts: "tag:vps" }, context);

  const summary = getWrittenResources().find((r) => r.specName === "summary")!;
  assertEquals(summary.name, "tag:vps");
  assertEquals(summary.data.status, "compliant");
  assertEquals(summary.data.hosts, { host1: "compliant" });
  assertEquals(summary.data.error, null);
});

Deno.test("role.check: summary worst-of picks failed over non_compliant and compliant", async () => {
  const globalArgs = {
    fleet: "ssh-fleet",
    requireCharDevices: [],
    members: ["member-a"],
  };
  const { base, getWrittenResources } = roleContext(globalArgs, "check");
  const { runModel } = queuedRunModel([
    {
      ok: true,
      resources: [
        {
          name: "host1",
          specName: "state",
          kind: "resource",
          attributes: { status: "compliant", changes: [] },
        },
        {
          name: "host2",
          specName: "state",
          kind: "resource",
          attributes: { status: "non_compliant", changes: ["fix y"] },
        },
        {
          name: "host3",
          specName: "state",
          kind: "resource",
          attributes: { status: "failed", changes: [] },
        },
      ],
    },
  ]);
  const context = { ...base, globalArgs, runModel };

  await model.methods.check.execute({ hosts: "tag:vps" }, context);

  const summary = getWrittenResources().find((r) => r.specName === "summary")!;
  assertEquals(summary.data.status, "failed");
  assertEquals(summary.data.hosts, {
    host1: "compliant",
    host2: "non_compliant",
    host3: "failed",
  });
});
