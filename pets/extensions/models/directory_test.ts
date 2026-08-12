import { assertEquals } from "jsr:@std/assert@1";
import { createModelTestContext } from "@swamp-club/swamp-testing";
import { queuedRunModel } from "./_lib/test_run_model.ts";
import { model } from "./directory.ts";

const dir = { path: "/opt/foo", owner: "root", group: "root", mode: "0750" };

function checkContext(
  facts: { dirs: unknown[]; error?: string | null },
) {
  const globalArgs = { fleet: "ssh-fleet", dirs: [dir] };
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

/** apply()'s facts carry `performed` — the actions the payload executed. */
function applyContext(
  facts: { dirs: unknown[]; error?: string | null; performed?: string[] },
) {
  const globalArgs = { fleet: "ssh-fleet", dirs: [dir] };
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

Deno.test("directory.check: non_compliant with mkdir when absent", async () => {
  const { context, getWrittenResources } = checkContext({
    dirs: [{ path: "/opt/foo", state: "absent" }],
  });
  await model.methods.check.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "non_compliant");
  assertEquals(written.data.dirs, [
    { path: "/opt/foo", ok: false, detail: "absent" },
  ]);
  assertEquals(written.data.changes, [
    "mkdir /opt/foo (root:root 0750)",
  ]);
  assertEquals(written.data.error, null);
});

Deno.test("directory.check: compliant when mode/owner/group match (string vs stat int)", async () => {
  const { context, getWrittenResources } = checkContext({
    dirs: [{
      path: "/opt/foo",
      state: "dir",
      owner: "root",
      group: "root",
      mode: 0o750,
    }],
  });
  await model.methods.check.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "compliant");
  assertEquals(written.data.dirs, [
    { path: "/opt/foo", ok: true, detail: "ok" },
  ]);
  assertEquals(written.data.changes, []);
});

Deno.test("directory.check: normalizes desired mode string against the stat int", async () => {
  const { context, getWrittenResources } = checkContext({
    dirs: [{
      path: "/opt/foo",
      state: "dir",
      owner: "root",
      group: "root",
      mode: 0o755,
    }],
  });
  await model.methods.check.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "non_compliant");
  assertEquals(written.data.changes, [
    "chmod 0750 /opt/foo (is 755)",
  ]);
});

Deno.test("directory.check: owner/group drift", async () => {
  const { context, getWrittenResources } = checkContext({
    dirs: [{
      path: "/opt/foo",
      state: "dir",
      owner: "www-data",
      group: "www-data",
      mode: 0o750,
    }],
  });
  await model.methods.check.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.changes, [
    "chown root:root /opt/foo (is www-data:www-data)",
  ]);
});

Deno.test("directory.check: failed when the path exists but isn't a directory", async () => {
  const { context, getWrittenResources } = checkContext({
    dirs: [{ path: "/opt/foo", state: "other" }],
  });
  await model.methods.check.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "failed");
  assertEquals(written.data.dirs, [
    { path: "/opt/foo", ok: false, detail: "exists but is not a directory" },
  ]);
  assertEquals(written.data.error, "path exists but is not a directory");
});

const compliantDirFacts = {
  dirs: [{
    path: "/opt/foo",
    state: "dir",
    owner: "root",
    group: "root",
    mode: 0o750,
  }],
};

Deno.test("directory.apply: compliant when nothing needed to change", async () => {
  const { context, getWrittenResources } = applyContext(
    { ...compliantDirFacts, error: null, performed: [] },
  );
  await model.methods.apply.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "compliant");
  assertEquals(written.data.changes, []);
});

Deno.test("directory.apply: applied when the directory was created", async () => {
  const { context, getWrittenResources } = applyContext(
    {
      ...compliantDirFacts,
      error: null,
      performed: ["created /opt/foo", "chown app:app /opt/foo"],
    },
  );
  await model.methods.apply.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "applied");
  assertEquals(written.data.changes, [
    "created /opt/foo",
    "chown app:app /opt/foo",
  ]);
});
