import { assertEquals } from "jsr:@std/assert@1";
import { createModelTestContext } from "@swamp-club/swamp-testing";
import { sha256Hex } from "./_lib/fleet.ts";
import { queuedRunModel } from "./_lib/test_run_model.ts";
import { deb822, model } from "./apt_repository.ts";

const globalArgs = {
  fleet: "ssh-fleet",
  name: "docker",
  uris: ["https://download.docker.com/linux/debian"],
  suites: ["bookworm"],
  components: ["stable"],
  signedBy: "/etc/apt/keyrings/docker.asc",
};

function expectedDeb822(): string {
  return deb822(globalArgs);
}

function checkContext(
  facts: { fileHash: string | null; keyPresent: boolean },
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
  facts: {
    fileHash: string | null;
    keyPresent: boolean;
    wroteSources?: boolean;
    fetchedKey?: boolean;
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

Deno.test("apt_repository.check: compliant when hash and key match", async () => {
  const expectedHash = await sha256Hex(expectedDeb822());
  const { context, getWrittenResources } = checkContext({
    fileHash: expectedHash,
    keyPresent: true,
  });
  await model.methods.check.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "compliant");
  assertEquals(written.data.sourcesMatch, true);
  assertEquals(written.data.keyPresent, true);
  assertEquals(written.data.changes, []);
  assertEquals(written.data.path, "/etc/apt/sources.list.d/docker.sources");
});

Deno.test("apt_repository.check: non_compliant when the content hash differs", async () => {
  const { context, getWrittenResources } = checkContext({
    fileHash: "stale-hash",
    keyPresent: true,
  });
  await model.methods.check.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "non_compliant");
  assertEquals(written.data.sourcesMatch, false);
  assertEquals(written.data.changes, [
    "write /etc/apt/sources.list.d/docker.sources",
  ]);
});

Deno.test("apt_repository.check: flags a missing signing key even when sources match", async () => {
  const expectedHash = await sha256Hex(expectedDeb822());
  const { context, getWrittenResources } = checkContext({
    fileHash: expectedHash,
    keyPresent: false,
  });
  await model.methods.check.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "non_compliant");
  assertEquals(written.data.sourcesMatch, true);
  assertEquals(written.data.keyPresent, false);
  assertEquals(written.data.changes, [
    "fetch key to /etc/apt/keyrings/docker.asc",
  ]);
});

Deno.test("apt_repository.check: file absent reports no hash match", async () => {
  const { context, getWrittenResources } = checkContext({
    fileHash: null,
    keyPresent: false,
  });
  await model.methods.check.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "non_compliant");
  assertEquals(written.data.sourcesMatch, false);
  assertEquals(written.data.changes, [
    "write /etc/apt/sources.list.d/docker.sources",
    "fetch key to /etc/apt/keyrings/docker.asc",
  ]);
});

Deno.test("apt_repository.apply: compliant when nothing was written or fetched", async () => {
  const expectedHash = await sha256Hex(expectedDeb822());
  const { context, getWrittenResources } = applyContext({
    fileHash: expectedHash,
    keyPresent: true,
    wroteSources: false,
    fetchedKey: false,
    error: null,
  });
  await model.methods.apply.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "compliant");
  assertEquals(written.data.changes, []);
});

Deno.test("apt_repository.apply: applied when the sources file was written", async () => {
  const expectedHash = await sha256Hex(expectedDeb822());
  const { context, getWrittenResources } = applyContext({
    fileHash: expectedHash,
    keyPresent: true,
    wroteSources: true,
    fetchedKey: false,
    error: null,
  });
  await model.methods.apply.execute({ hosts: "tag:all" }, context);
  const [written] = getWrittenResources();
  assertEquals(written.data.status, "applied");
  assertEquals(written.data.changes, [
    "write /etc/apt/sources.list.d/docker.sources",
  ]);
});
