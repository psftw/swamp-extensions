import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { readmeHead, spliceDescription, SPLIT_HEADING } from "./gen_docs.ts";

Deno.test("readmeHead strips the H1 and stops at the split heading", () => {
  const head = readmeHead(
    `# title\n\nintro\n\n## Example\n\nbody\n\n${SPLIT_HEADING}\n\nrest\n`,
  );
  assertEquals(head, "intro\n\n## Example\n\nbody");
});

Deno.test("readmeHead throws without the split heading", () => {
  assertThrows(() => readmeHead("# title\n\nintro\n"));
});

Deno.test("spliceDescription replaces only the description block", () => {
  const manifest = `name: "@x/y"
description: |

  old text

  more old
dependencies:
  - "@swamp/ssh"
`;
  assertEquals(
    spliceDescription(manifest, "new one\n\nnew two"),
    `name: "@x/y"
description: |
  new one

  new two
dependencies:
  - "@swamp/ssh"
`,
  );
});
