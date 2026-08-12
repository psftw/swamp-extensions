import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { z } from "npm:zod@4";
import {
  errorMessage,
  fleetFacts,
  fleetResolve,
  normalizeMode,
  pyScript,
  sha256Hex,
} from "./fleet.ts";
import { queuedRunModel } from "./test_run_model.ts";

const logger = { debug() {}, info() {} };

function extractPayload(script: string): string {
  const match = script.match(/json\.loads\(r'''([\s\S]*)'''\)\)\n$/);
  if (!match) throw new Error("script missing json.loads(r'''...''') tail");
  return match[1];
}

Deno.test("pyScript assembles source + entry call line", () => {
  const script = pyScript(
    "def check(cfg):\n    pass\n",
    "check",
    z.object({ a: z.int() }),
    { a: 1 },
  );
  assertEquals(
    script,
    "def check(cfg):\n    pass\n\ncheck(json.loads(r'''{\"a\":1}'''))\n",
  );
});

Deno.test("pyScript embedded JSON round-trips to the cfg object", () => {
  const cfg = { packages: ["curl", "htop"], nested: { n: 1, ok: true } };
  const schema = z.object({
    packages: z.array(z.string()),
    nested: z.object({ n: z.int(), ok: z.boolean() }),
  });
  const script = pyScript("SOURCE\n", "check", schema, cfg);
  assertEquals(JSON.parse(extractPayload(script)), cfg);
});

Deno.test("pyScript escapes single quotes so the r''' wrapper can't break", () => {
  const cfg = { note: "it's a 'test' with '''triple''' quotes" };
  const script = pyScript(
    "SOURCE\n",
    "check",
    z.object({ note: z.string() }),
    cfg,
  );
  const payload = extractPayload(script);
  assertEquals(payload.includes("'"), false);
  assertEquals(JSON.parse(payload), cfg);
});

Deno.test("pyScript survives unicode", () => {
  const cfg = { name: "héllo 世界 🎉" };
  const script = pyScript(
    "SOURCE\n",
    "check",
    z.object({ name: z.string() }),
    cfg,
  );
  assertEquals(JSON.parse(extractPayload(script)), cfg);
});

Deno.test("pyScript rejects cfg that violates the wire contract", () => {
  assertThrows(() =>
    pyScript("SOURCE\n", "check", z.object({ a: z.int() }), {
      a: "1",
    } as never)
  );
});

Deno.test("fleetResolve maps selection hosts", async () => {
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
              { name: "host1", address: "10.0.0.1", tags: ["web"] },
              { name: "host2", address: "10.0.0.2", tags: [] },
            ],
          },
        },
      ],
    },
  ]);
  const hosts = await fleetResolve({ runModel, logger }, "myfleet", "tag:all");
  assertEquals(hosts, [
    { name: "host1", address: "10.0.0.1", tags: ["web"] },
    { name: "host2", address: "10.0.0.2", tags: [] },
  ]);
});

Deno.test("fleetResolve throws with fleet+selector in message on failure", async () => {
  const { runModel } = queuedRunModel([
    { ok: false, error: { message: "no such fleet" } },
  ]);
  await assertRejects(
    () => fleetResolve({ runModel, logger }, "myfleet", "tag:all"),
    Error,
    "myfleet.resolve(tag:all) failed: no such fleet",
  );
});

Deno.test("fleetFacts parses per-host stdout JSON", async () => {
  const { runModel } = queuedRunModel([
    {
      ok: true,
      resources: [
        {
          name: "h1",
          specName: "runResult",
          kind: "resource",
          attributes: { host: "h1", stdout: JSON.stringify({ foo: 1 }) },
        },
      ],
    },
  ]);
  const runs = await fleetFacts(
    { runModel, logger },
    "myfleet",
    "tag:all",
    "print(1)",
    z.object({ foo: z.int() }),
  );
  assertEquals(runs, [{ host: "h1", data: { foo: 1 } }]);
});

Deno.test("fleetFacts names the host when facts violate the contract", async () => {
  const { runModel } = queuedRunModel([
    {
      ok: true,
      resources: [
        {
          name: "h1",
          specName: "runResult",
          kind: "resource",
          attributes: { host: "h1", stdout: JSON.stringify({ foo: "bar" }) },
        },
      ],
    },
  ]);
  await assertRejects(
    () =>
      fleetFacts(
        { runModel, logger },
        "myfleet",
        "tag:all",
        "print(1)",
        z.object({ foo: z.int() }),
      ),
    Error,
    "host h1 returned facts violating the contract",
  );
});

Deno.test("fleetResolve throws when the fleet returns no 'selection' resource", async () => {
  const { runModel } = queuedRunModel([
    { ok: true, resources: [] },
  ]);
  await assertRejects(
    () => fleetResolve({ runModel, logger }, "myfleet", "tag:all"),
    Error,
    "myfleet.resolve returned no 'selection' resource — is 'myfleet' a fleet-protocol model? (see README: Fleet protocol)",
  );
});

Deno.test("fleetFacts throws naming the host on non-JSON stdout", async () => {
  const { runModel } = queuedRunModel([
    {
      ok: true,
      resources: [
        {
          name: "h1",
          specName: "runResult",
          kind: "resource",
          attributes: { host: "h1", stdout: "not json" },
        },
      ],
    },
  ]);
  await assertRejects(
    () =>
      fleetFacts(
        { runModel, logger },
        "myfleet",
        "tag:all",
        "print(1)",
        z.object({}),
      ),
    Error,
    "host h1 returned non-JSON facts",
  );
});

Deno.test("fleetFacts throws when the script returns ok but no 'runResult' resources", async () => {
  const { runModel } = queuedRunModel([
    { ok: true, resources: [] },
  ]);
  await assertRejects(
    () =>
      fleetFacts(
        { runModel, logger },
        "myfleet",
        "tag:all",
        "print(1)",
        z.object({}),
      ),
    Error,
    "myfleet.script returned no 'runResult' resources — is 'myfleet' a fleet-protocol model? (see README: Fleet protocol)",
  );
});

Deno.test("fleetFacts passes sudo/timeoutSec through to runModel arguments", async () => {
  const { runModel, calls } = queuedRunModel([
    {
      ok: true,
      resources: [
        {
          name: "h1",
          specName: "runResult",
          kind: "resource",
          attributes: { host: "h1", stdout: "{}" },
        },
      ],
    },
  ]);
  await fleetFacts(
    { runModel, logger },
    "myfleet",
    "tag:all",
    "print(1)",
    z.object({}),
    { sudo: true, timeoutSec: 42 },
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].definition, "myfleet");
  assertEquals(calls[0].method, "script");
  assertEquals(calls[0].arguments?.hosts, "tag:all");
  assertEquals(calls[0].arguments?.script, "print(1)");
  assertEquals(calls[0].arguments?.interpreter, "python3");
  assertEquals(calls[0].arguments?.sudo, true);
  assertEquals(calls[0].arguments?.timeoutSec, 42);
});

Deno.test("fleetFacts defaults sudo to false and omits timeoutSec", async () => {
  const { runModel, calls } = queuedRunModel([
    {
      ok: true,
      resources: [
        {
          name: "h1",
          specName: "runResult",
          kind: "resource",
          attributes: { host: "h1", stdout: "{}" },
        },
      ],
    },
  ]);
  await fleetFacts(
    { runModel, logger },
    "myfleet",
    "tag:all",
    "print(1)",
    z.object({}),
  );
  assertEquals(calls[0].arguments?.sudo, false);
  assertEquals("timeoutSec" in (calls[0].arguments ?? {}), false);
});

Deno.test("normalizeMode parses octal, sticky bit included", () => {
  assertEquals(normalizeMode("0750"), 0o750);
  assertEquals(normalizeMode("2775"), 0o2775);
});

Deno.test("sha256Hex matches known vectors", async () => {
  assertEquals(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assertEquals(
    await sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

Deno.test("errorMessage unwraps Error, stringifies non-Error", () => {
  assertEquals(errorMessage(new Error("boom")), "boom");
  assertEquals(errorMessage("plain"), "plain");
  assertEquals(errorMessage(42), "42");
});
