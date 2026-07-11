import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "out", "native");
mkdirSync(outDir, { recursive: true });
const localIdentity = "Echo Local Code Signing";

const helpers = [
  {
    source: "native/EchoKeyHelper.swift",
    output: "EchoKeyHelper",
    frameworks: ["ApplicationServices", "AppKit"]
  },
  {
    source: "native/EchoPasteHelper.swift",
    output: "EchoPasteHelper",
    frameworks: ["ApplicationServices"]
  },
  {
    source: "native/EchoSpeechHelper.swift",
    output: "EchoSpeechHelper",
    bundleName: "EchoSpeechHelper.app",
    swiftOptions: ["-parse-as-library"],
    frameworks: ["Speech", "AVFoundation"],
    infoPlist: {
      CFBundleIdentifier: "com.tanay.echo.speech-helper",
      CFBundleName: "EchoSpeechHelper",
      NSSpeechRecognitionUsageDescription:
        "Echo uses Apple Speech only as a secondary accuracy check for existing dictation audio."
    }
  }
];

const identity = findLocalIdentity() ? localIdentity : "-";

for (const helper of helpers) {
  const bundlePath = helper.bundleName ? join(outDir, helper.bundleName) : null;
  if (bundlePath) {
    rmSync(bundlePath, { recursive: true, force: true });
    rmSync(join(outDir, helper.output), { force: true });
    mkdirSync(join(bundlePath, "Contents", "MacOS"), { recursive: true });
  }
  const outputPath = bundlePath
    ? join(bundlePath, "Contents", "MacOS", helper.output)
    : join(outDir, helper.output);
  const tempDir = mkdtempSync(join(tmpdir(), "echo-native-"));
  try {
    const args = [...(helper.swiftOptions ?? []), "-O"];
    for (const framework of helper.frameworks) {
      args.push("-framework", framework);
    }
    if (helper.infoPlist) {
      const infoRelativePath = "Contents/Info.plist";
      const plistPath = bundlePath
        ? join(bundlePath, infoRelativePath)
        : join(tempDir, `${helper.output}-Info.plist`);
      writeFileSync(plistPath, infoPlist(helper.infoPlist));
      args.push("-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", plistPath);
    }
    args.push("-o", outputPath, join(root, helper.source));
    run("swiftc", args);
    sign(outputPath, identity);
    if (bundlePath) sign(bundlePath, identity);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function findLocalIdentity() {
  const result = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8"
  });
  if (result.status !== 0) return false;
  const escaped = localIdentity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b[A-Fa-f0-9]{10,}\\s+"${escaped}"`).test(result.stdout);
}

function sign(path, identity) {
  run("codesign", ["--force", "--options", "runtime", "--sign", identity, path]);
}

function infoPlist(values) {
  const entries = Object.entries({
    CFBundleExecutable: values.CFBundleName,
    CFBundleIdentifier: values.CFBundleIdentifier,
    CFBundleName: values.CFBundleName,
    CFBundlePackageType: "APPL",
    CFBundleShortVersionString: "1.0",
    CFBundleVersion: "1",
    NSSpeechRecognitionUsageDescription: values.NSSpeechRecognitionUsageDescription
  })
    .map(([key, value]) => `  <key>${key}</key>\n  <string>${escapeXml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${entries}
</dict>
</plist>
`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
