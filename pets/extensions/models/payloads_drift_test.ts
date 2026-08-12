import { assertEquals } from "jsr:@std/assert@1";
import { source as aptPy } from "./_payloads/apt.ts";
import { source as aptRepositoryPy } from "./_payloads/apt_repository.ts";
import { source as directoryPy } from "./_payloads/directory.ts";
import { source as groupMemberPy } from "./_payloads/group_member.ts";
import { source as systemdPy } from "./_payloads/systemd.ts";
import { source as templateFilePy } from "./_payloads/template_file.ts";

const payloads: Record<string, string> = {
  apt: aptPy,
  apt_repository: aptRepositoryPy,
  directory: directoryPy,
  group_member: groupMemberPy,
  systemd: systemdPy,
  template_file: templateFilePy,
};

const srcDir = new URL("../../payloads/", import.meta.url);
const payloadsDir = new URL("./_payloads/", import.meta.url);

async function listStems(dir: URL, ext: string): Promise<string[]> {
  const stems: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(ext)) {
      stems.push(entry.name.slice(0, -ext.length));
    }
  }
  return stems.sort();
}

Deno.test("_payloads/*.ts exactly mirrors payloads/*.py (no strays, none missing)", async () => {
  const srcStems = await listStems(srcDir, ".py");
  const payloadStems = await listStems(payloadsDir, ".ts");
  assertEquals(payloadStems, srcStems);
  assertEquals(payloadStems, Object.keys(payloads).sort());
});

for (const [mod, generated] of Object.entries(payloads)) {
  Deno.test(`_payloads/${mod}.ts is byte-identical to payloads/${mod}.py`, async () => {
    const original = await Deno.readTextFile(
      new URL(`${mod}.py`, srcDir),
    );
    assertEquals(generated, original);
  });
}
