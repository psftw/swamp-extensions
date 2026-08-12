import { assert, assertEquals } from "jsr:@std/assert@1";
import { emitModule, emitTypes, escape, extractTypes } from "./gen_payloads.ts";
import { payloadTypes } from "../extensions/models/_lib/cfg.ts";

// Hand-derived pairs: the right side is exactly what must appear inside the
// generated template literal for the parser to cook back the left side.
const fixtures: [source: string, escaped: string][] = [
  ["hello\nworld\n", "hello\nworld\n"],
  ["back\\slash", "back\\\\slash"],
  ["\\\\", "\\\\\\\\"],
  ["line\\", "line\\\\"],
  ["`", "\\`"],
  ["``", "\\`\\`"],
  ["${x}", "\\${x}"],
  ["\\${", "\\\\\\${"],
  ["$", "$"],
  ["$ {", "$ {"],
  ["$${", "$\\${"],
  ["$\n{", "$\n{"],
];

for (const [source, escaped] of fixtures) {
  Deno.test(`escape: ${JSON.stringify(source)}`, () => {
    assertEquals(escape(source), escaped);
  });
}

/**
 * Cooked-value semantics for the subset escape() can emit. Valid only under
 * the invariant below: every backslash in escape() output is followed by
 * one of \ ` $, each of which cooks to itself.
 */
function decode(escaped: string): string {
  let out = "";
  for (let i = 0; i < escaped.length; i++) {
    if (escaped[i] === "\\") i++;
    out += escaped[i];
  }
  return out;
}

const alphabet = ["\\", "`", "$", "{", "}", "a", "\n"];

Deno.test("escape: round-trips and upholds the decoder invariant over all short combinations", () => {
  const corpus = fixtures.map(([source]) => source);
  for (const a of alphabet) {
    for (const b of alphabet) {
      for (const c of alphabet) {
        corpus.push(a + b + c, a + b + c + a + b + c);
      }
    }
  }
  for (const source of corpus) {
    const escaped = escape(source);
    for (let i = 0; i < escaped.length; i++) {
      if (escaped[i] === "\\") {
        assert(
          ["\\", "`", "$"].includes(escaped[i + 1]),
          `stray escape in ${JSON.stringify(escaped)} at ${i}`,
        );
        i++;
      }
    }
    assertEquals(decode(escaped), source);
  }
});

Deno.test("emitModule: wraps the escaped source in the documented shape", () => {
  assertEquals(
    emitModule("x", "print(`${a}`)\n"),
    "// GENERATED from payloads/x.py — edit that file and run `deno task gen`.\n" +
      "/** Python source of payloads/x.py, embedded verbatim. */\n" +
      "export const source: string =\n" +
      "  `print(\\`\\${a}\\`)\n`;\n",
  );
});

Deno.test("emitTypes: named nesting and layout (directory)", () => {
  assertEquals(
    emitTypes(payloadTypes.directory),
    "# BEGIN GENERATED TYPES — edit extensions/models/_lib/cfg.ts and run `deno task gen`.\n" +
      "from typing import TypedDict\n\n\n" +
      "class Dir(TypedDict):\n" +
      "    path: str\n    owner: str\n    group: str\n    modeInt: int\n\n\n" +
      "class Cfg(TypedDict):\n    dirs: list[Dir]\n" +
      "# END GENERATED TYPES",
  );
});

Deno.test("payloads/*.py GENERATED TYPES blocks match _lib/cfg.ts", async () => {
  const srcDir = new URL("../payloads/", import.meta.url);
  const stems: string[] = [];
  for await (const entry of Deno.readDir(srcDir)) {
    if (entry.isFile && entry.name.endsWith(".py")) {
      stems.push(entry.name.slice(0, -".py".length));
    }
  }
  assertEquals(stems.sort(), Object.keys(payloadTypes).sort());
  for (const mod of stems) {
    const text = await Deno.readTextFile(new URL(`${mod}.py`, srcDir));
    assertEquals(extractTypes(text), emitTypes(payloadTypes[mod]));
  }
});

// Template literals cook CR and CRLF to LF, so a payload containing CR would
// not survive the round-trip. Keep payload sources LF-only.
Deno.test("payloads/*.py are LF-only", async () => {
  const srcDir = new URL("../payloads/", import.meta.url);
  for await (const entry of Deno.readDir(srcDir)) {
    if (entry.isFile && entry.name.endsWith(".py")) {
      const text = await Deno.readTextFile(new URL(entry.name, srcDir));
      assert(!text.includes("\r"), `${entry.name} contains a carriage return`);
    }
  }
});
