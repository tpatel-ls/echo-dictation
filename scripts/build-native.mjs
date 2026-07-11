import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "out", "native");
mkdirSync(outDir, { recursive: true });
const localIdentity = "Echo Local Code Signing";
const requestedTarget = process.argv.find((arg) => arg.startsWith("--target="))?.split("=")[1];
const target = requestedTarget || process.env.ECHO_NATIVE_TARGET || process.platform;

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

if (target === "darwin") buildDarwin();
else if (target === "win32") buildWindows();
else {
  console.error(`Unsupported native target: ${target}`);
  process.exit(1);
}

function buildDarwin() {
  for (const name of ["EchoKeyHelper.exe", "EchoPasteHelper.exe", "EchoSpeechHelper.exe"]) {
    rmSync(join(outDir, name), { force: true });
  }
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
      for (const framework of helper.frameworks) args.push("-framework", framework);
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
}

function buildWindows() {
  for (const name of ["EchoKeyHelper", "EchoPasteHelper", "EchoSpeechHelper", "EchoSpeechHelper.app"]) {
    rmSync(join(outDir, name), { recursive: true, force: true });
  }
  const runtime = process.env.ECHO_WINDOWS_RID || "win-x64";
  for (const name of ["EchoKeyHelper", "EchoPasteHelper", "EchoSpeechHelper"]) {
    const project = join(root, "native", "windows", name, `${name}.csproj`);
    const tempDir = mkdtempSync(join(tmpdir(), "echo-windows-"));
    try {
      run("dotnet", [
        "publish",
        project,
        "--configuration",
        "Release",
        "--runtime",
        runtime,
        "--self-contained",
        "true",
        "-p:EnableWindowsTargeting=true",
        "-p:PublishSingleFile=true",
        "-p:DebugType=None",
        "-p:DebugSymbols=false",
        "--output",
        tempDir
      ]);
      const source = join(tempDir, `${name}.exe`);
      if (!existsSync(source)) throw new Error(`dotnet did not produce ${source}`);
      copyFileSync(source, join(outDir, `${name}.exe`));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
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
