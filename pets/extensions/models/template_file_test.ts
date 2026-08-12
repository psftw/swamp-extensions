import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createModelTestContext } from "@swamp-club/swamp-testing";
import { sha256Hex } from "./_lib/fleet.ts";
import { queuedRunModel } from "./_lib/test_run_model.ts";
import { model } from "./template_file.ts";

const repoDir = new URL("./testdata", import.meta.url).pathname;

const globalArgs = {
  fleet: "ssh-fleet",
  path: "/etc/hello.conf",
  templatePath: "hello.liquid",
  owner: "root",
  group: "root",
  mode: "0644",
  variables: { greeting: "ops" },
};

const renderedText = "hello host1 from ops\n";

function checkContext(
  facts: {
    exists: boolean;
    hash?: string;
    owner?: string;
    group?: string;
    mode?: number;
  },
) {
  const { context: base, getWrittenResources } = createModelTestContext({
    globalArgs,
    methodName: "check",
    repoDir,
  });
  const { runModel, calls } = queuedRunModel([
    {
      ok: true,
      resources: [
        {
          name: "sel",
          specName: "selection",
          kind: "resource",
          attributes: {
            hosts: [{ name: "host1", address: "10.0.0.1", tags: [] }],
          },
        },
      ],
    },
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
    calls,
  };
}

function applyContext(
  postFacts: {
    exists: boolean;
    hash?: string;
    owner?: string;
    group?: string;
    mode?: number;
    changed?: boolean;
    performed?: string[];
    error?: string | null;
  },
) {
  const { context: base, getWrittenResources } = createModelTestContext({
    globalArgs,
    methodName: "apply",
    repoDir,
  });
  const { runModel, calls } = queuedRunModel([
    {
      ok: true,
      resources: [
        {
          name: "sel",
          specName: "selection",
          kind: "resource",
          attributes: {
            hosts: [{ name: "host1", address: "10.0.0.1", tags: [] }],
          },
        },
      ],
    },
    {
      ok: true,
      resources: [
        {
          name: "host1",
          specName: "runResult",
          kind: "resource",
          attributes: { host: "host1", stdout: JSON.stringify(postFacts) },
        },
      ],
    },
  ]);
  return {
    context: { ...base, globalArgs, runModel },
    getWrittenResources,
    calls,
  };
}

Deno.test("template_file.check: renders the Liquid template with host+variables", async () => {
  const expectedHash = await sha256Hex(renderedText);
  const { context, getWrittenResources } = checkContext({
    exists: true,
    hash: expectedHash,
    owner: "root",
    group: "root",
    mode: 0o644,
  });
  await model.methods.check.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "compliant");
  assertEquals(written.data.contentMatch, true);
  assertEquals(written.data.expectedHash, expectedHash);
  assertEquals(written.data.changes, []);
});

Deno.test("template_file.check: non_compliant when the remote hash differs", async () => {
  const { context, getWrittenResources } = checkContext({
    exists: true,
    hash: "stale-hash",
    owner: "root",
    group: "root",
    mode: 0o644,
  });
  await model.methods.check.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "non_compliant");
  assertEquals(written.data.contentMatch, false);
  assertEquals(written.data.actualHash, "stale-hash");
  assertEquals(written.data.changes, ["write /etc/hello.conf"]);
});

Deno.test("template_file.check: absent file reports write with no owner/mode checks", async () => {
  const { context, getWrittenResources } = checkContext({ exists: false });
  await model.methods.check.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "non_compliant");
  assertEquals(written.data.actualHash, "absent");
  assertEquals(written.data.changes, ["write /etc/hello.conf"]);
});

Deno.test("template_file.check: content matches but owner/mode drift", async () => {
  const expectedHash = await sha256Hex(renderedText);
  const { context, getWrittenResources } = checkContext({
    exists: true,
    hash: expectedHash,
    owner: "www-data",
    group: "www-data",
    mode: 0o600,
  });
  await model.methods.check.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "non_compliant");
  assertEquals(written.data.contentMatch, true);
  assertEquals(written.data.changes, [
    "chown root:root (is www-data:www-data)",
    "chmod 0644 (is 600)",
  ]);
});

Deno.test("template_file.check: resolves the fleet before gathering facts", async () => {
  const { context, calls } = checkContext({ exists: false });
  await model.methods.check.execute({ hosts: "tag:all" }, context);
  assertEquals(calls.map((c) => c.method), ["resolve", "script"]);
});

Deno.test("template_file.apply: compliant when the install was a no-op (hash already matched)", async () => {
  const expectedHash = await sha256Hex(renderedText);
  const { context, getWrittenResources } = applyContext({
    exists: true,
    hash: expectedHash,
    owner: "root",
    group: "root",
    mode: 0o644,
    changed: false,
    performed: [],
    error: null,
  });
  await model.methods.apply.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "compliant");
  assertEquals(written.data.changes, []);
});

Deno.test("template_file.apply: applied when the file content changed", async () => {
  const expectedHash = await sha256Hex(renderedText);
  const { context, getWrittenResources } = applyContext({
    exists: true,
    hash: expectedHash,
    owner: "root",
    group: "root",
    mode: 0o644,
    changed: true,
    performed: ["write /etc/hello.conf"],
    error: null,
  });
  await model.methods.apply.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "applied");
  assertEquals(written.data.changes, ["write /etc/hello.conf"]);
});

Deno.test("template_file.apply: applied when only owner/mode converged (no content change, no onChange)", async () => {
  const expectedHash = await sha256Hex(renderedText);
  const performed = [
    "chown root:root /etc/hello.conf",
    "chmod 0o644 /etc/hello.conf",
  ];
  const { context, getWrittenResources } = applyContext({
    exists: true,
    hash: expectedHash,
    owner: "root",
    group: "root",
    mode: 0o644,
    changed: false,
    performed,
    error: null,
  });
  await model.methods.apply.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "applied");
  assertEquals(written.data.changes, performed);
  assertEquals(written.data.error, null);
});

Deno.test("template_file.check: rejects a runResult host absent from resolve, writing nothing", async () => {
  const { context: base, getWrittenResources } = createModelTestContext({
    globalArgs,
    methodName: "check",
    repoDir,
  });
  const { runModel } = queuedRunModel([
    {
      ok: true,
      resources: [
        {
          name: "sel",
          specName: "selection",
          kind: "resource",
          attributes: {
            hosts: [{ name: "host1", address: "10.0.0.1", tags: [] }],
          },
        },
      ],
    },
    {
      ok: true,
      resources: [
        {
          name: "rogue",
          specName: "runResult",
          kind: "resource",
          attributes: {
            host: "rogue",
            stdout: JSON.stringify({ exists: false }),
          },
        },
      ],
    },
  ]);
  await assertRejects(
    () =>
      model.methods.check.execute(
        { hosts: "tag:all" },
        { ...base, globalArgs, runModel },
      ),
    Error,
    "runResult for host 'rogue' absent from resolve",
  );
  assertEquals(getWrittenResources(), []);
});

Deno.test("template_file.check: rejects when a resolved host has no runResult, writing nothing", async () => {
  const { context: base, getWrittenResources } = createModelTestContext({
    globalArgs,
    methodName: "check",
    repoDir,
  });
  const { runModel } = queuedRunModel([
    {
      ok: true,
      resources: [
        {
          name: "sel",
          specName: "selection",
          kind: "resource",
          attributes: {
            hosts: [
              { name: "host1", address: "10.0.0.1", tags: [] },
              { name: "host2", address: "10.0.0.2", tags: [] },
            ],
          },
        },
      ],
    },
    {
      ok: true,
      resources: [
        {
          name: "host1",
          specName: "runResult",
          kind: "resource",
          attributes: {
            host: "host1",
            stdout: JSON.stringify({ exists: false }),
          },
        },
      ],
    },
  ]);
  await assertRejects(
    () =>
      model.methods.check.execute(
        { hosts: "tag:all" },
        { ...base, globalArgs, runModel },
      ),
    Error,
    "no runResult for resolved host 'host2'",
  );
  assertEquals(getWrittenResources(), []);
});
