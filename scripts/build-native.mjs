import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "out", "native");
mkdirSync(outDir, { recursive: true });

const helpers = [
  ["native/EchoKeyHelper.swift", "EchoKeyHelper"],
  ["native/EchoPasteHelper.swift", "EchoPasteHelper"]
];

for (const [source, output] of helpers) {
  const result = spawnSync(
    "swiftc",
    [
      "-O",
      "-framework",
      "ApplicationServices",
      "-framework",
      "AppKit",
      "-o",
      join(outDir, output),
      join(root, source)
    ],
    { stdio: "inherit" }
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
