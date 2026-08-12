/**
 * Rebuild the manifest.yaml `description` from the README head (everything
 * between the H1 and `## How it works`).
 * Run from pets/: deno task gen:docs
 */

/** Everything above this README heading becomes the description. */
export const SPLIT_HEADING = "## How it works";

/** Replace the `description: |` block, leaving every other byte alone. */
export function spliceDescription(
  manifest: string,
  description: string,
): string {
  const lines = manifest.split("\n");
  const start = lines.findIndex((l) => l.startsWith("description:"));
  if (start < 0) throw new Error("manifest.yaml: no description key");
  let end = start + 1;
  while (
    end < lines.length && (lines[end] === "" || lines[end].startsWith("  "))
  ) {
    end++;
  }
  const block = description.trimEnd().split("\n")
    .map((l) => (l.length ? `  ${l}` : ""));
  return [
    ...lines.slice(0, start),
    "description: |",
    ...block,
    ...lines.slice(end),
  ].join("\n");
}

/** README content between the H1 line and SPLIT_HEADING. */
export function readmeHead(readme: string): string {
  const idx = readme.indexOf(`\n${SPLIT_HEADING}\n`);
  if (idx < 0) {
    throw new Error(`README.md: missing "${SPLIT_HEADING}" heading`);
  }
  const lines = readme.slice(0, idx).split("\n");
  if (!lines[0].startsWith("# ")) {
    throw new Error("README.md must start with an H1");
  }
  return lines.slice(1).join("\n").trim();
}

if (import.meta.main) {
  const manifestText = await Deno.readTextFile("manifest.yaml");
  const readme = await Deno.readTextFile("README.md");
  await Deno.writeTextFile(
    "manifest.yaml",
    spliceDescription(manifestText, readmeHead(readme)),
  );
  console.log("manifest.yaml: description rebuilt from the README head");
}
