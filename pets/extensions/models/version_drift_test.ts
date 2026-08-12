import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { model as apt } from "./apt.ts";
import { model as aptRepository } from "./apt_repository.ts";
import { model as directory } from "./directory.ts";
import { model as groupMember } from "./group_member.ts";
import { model as role } from "./role.ts";
import { model as systemd } from "./systemd.ts";
import { model as templateFile } from "./template_file.ts";

Deno.test("every model version matches the manifest version", async () => {
  const manifest = await Deno.readTextFile(
    new URL("../../manifest.yaml", import.meta.url),
  );
  const version = manifest.match(/^version: "([^"]+)"$/m)?.[1];
  assertExists(version, "manifest.yaml version");
  for (
    const m of [
      apt,
      aptRepository,
      directory,
      groupMember,
      role,
      systemd,
      templateFile,
    ]
  ) {
    assertEquals(m.version, version, m.type);
  }
});
