import { assertEquals } from "jsr:@std/assert@1";
import { createModelTestContext } from "@swamp-club/swamp-testing";
import { queuedRunModel } from "./_lib/test_run_model.ts";
import { model } from "./group_member.ts";

function checkContext(
  globalArgs: { fleet: string; username: string; group: string },
  facts: { userExists: boolean; member: boolean; groups: string[] },
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

function applyContext(
  globalArgs: { fleet: string; username: string; group: string },
  facts: {
    userExists: boolean;
    member: boolean;
    groups: string[];
    changed?: boolean;
    error?: string | null;
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

Deno.test("group_member.check: compliant when already a member", async () => {
  const { context, getWrittenResources } = checkContext(
    { fleet: "ssh-fleet", username: "deploy", group: "docker" },
    { userExists: true, member: true, groups: ["deploy", "docker"] },
  );
  await model.methods.check.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "compliant");
  assertEquals(written.data.member, true);
  assertEquals(written.data.changes, []);
  assertEquals(written.data.error, null);
});

Deno.test("group_member.check: non_compliant appends the missing membership", async () => {
  const { context, getWrittenResources } = checkContext(
    { fleet: "ssh-fleet", username: "deploy", group: "docker" },
    { userExists: true, member: false, groups: ["deploy"] },
  );
  await model.methods.check.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "non_compliant");
  assertEquals(written.data.member, false);
  assertEquals(written.data.changes, ["add deploy to docker"]);
  assertEquals(written.data.error, null);
});

Deno.test("group_member.check: failed when the user doesn't exist", async () => {
  const { context, getWrittenResources } = checkContext(
    { fleet: "ssh-fleet", username: "ghost", group: "docker" },
    { userExists: false, member: false, groups: [] },
  );
  await model.methods.check.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "failed");
  assertEquals(written.data.changes, []);
  assertEquals(written.data.error, "user ghost not found");
});

Deno.test("group_member.apply: compliant when already a member (no usermod run)", async () => {
  const { context, getWrittenResources } = applyContext(
    { fleet: "ssh-fleet", username: "deploy", group: "docker" },
    {
      userExists: true,
      member: true,
      groups: ["deploy", "docker"],
      changed: false,
      error: null,
    },
  );
  await model.methods.apply.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "compliant");
  assertEquals(written.data.changes, []);
});

Deno.test("group_member.apply: applied when usermod -aG ran", async () => {
  const { context, getWrittenResources } = applyContext(
    { fleet: "ssh-fleet", username: "deploy", group: "docker" },
    {
      userExists: true,
      member: true,
      groups: ["deploy", "docker"],
      changed: true,
      error: null,
    },
  );
  await model.methods.apply.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "applied");
  assertEquals(written.data.changes, [
    "add deploy to docker (re-login required)",
  ]);
});
