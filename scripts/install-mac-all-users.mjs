import { cpSync, chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { codesignArgs, findIdentityHash, hasAdhocSignature, LOCAL_CODESIGN_IDENTITY } from "./mac-signing.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const label = "com.tanay.echo";
const appName = "Echo.app";
const sourceApp = findBuiltApp();
const installedApp = join("/Applications", appName);
const sourceLaunchAgent = join(root, "launchd", `${label}.plist`);
const installedLaunchAgent = join("/Library/LaunchAgents", `${label}.plist`);
const uid = currentConsoleUid();

if (process.platform !== "darwin") {
  fail("This installer only supports macOS.");
}

if (!sourceApp) {
  fail("Could not find dist/mac*/Echo.app. Run npm run dist:mac first.");
}

if (uid !== undefined) {
  runLaunchctlForUser(["bootout", `gui/${uid}/${label}`], { allowFailure: true });
}
run("pkill", ["-TERM", "-f", `${installedApp}/Contents`], { allowFailure: true });
run("sleep", ["1"], { allowFailure: true });
run("pkill", ["-KILL", "-f", `${installedApp}/Contents`], { allowFailure: true });

rmSync(installedApp, { recursive: true, force: true });
cpSync(sourceApp, installedApp, { recursive: true, force: true, verbatimSymlinks: true });
run("xattr", ["-cr", installedApp], { allowFailure: true });
run("chmod", ["-R", "a+rX", installedApp]);
signInstalledApp(installedApp);

mkdirSync(dirname(installedLaunchAgent), { recursive: true });
cpSync(sourceLaunchAgent, installedLaunchAgent);
chmodSync(installedLaunchAgent, 0o644);
run("plutil", ["-lint", installedLaunchAgent]);

if (uid !== undefined) {
  runLaunchctlForUser(["bootstrap", `gui/${uid}`, installedLaunchAgent]);
  runLaunchctlForUser(["enable", `gui/${uid}/${label}`], { allowFailure: true });
  runLaunchctlForUser(["kickstart", "-k", `gui/${uid}/${label}`]);
}

console.log(`Installed ${installedApp}`);
console.log(`Installed ${installedLaunchAgent}`);

function findBuiltApp() {
  const dist = join(root, "dist");
  if (!existsSync(dist)) {
    return undefined;
  }

  for (const candidate of ["mac-arm64", "mac", "mac-universal"]) {
    const app = join(dist, candidate, appName);
    if (existsSync(app)) {
      return app;
    }
  }

  return undefined;
}

function currentConsoleUid() {
  if (process.env.SUDO_UID) {
    return Number(process.env.SUDO_UID);
  }
  const result = spawnSync("stat", ["-f", "%u", "/dev/console"], {
    encoding: "utf8",
    stdio: "pipe"
  });
  const parsed = Number(result.stdout.trim());
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe"
  });

  if (result.status !== 0 && !options.allowFailure) {
    const details = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    fail(`${command} ${args.join(" ")} failed${details ? `:\n${details}` : ""}`);
  }

  return result;
}

function runLaunchctlForUser(args, options = {}) {
  return run("launchctl", args, options);
}

function signInstalledApp(appPath) {
  const identityName = process.env.ECHO_CODESIGN_IDENTITY || LOCAL_CODESIGN_IDENTITY;
  const identities = run("security", ["find-identity", "-v", "-p", "codesigning"], { allowFailure: true });
  if (findIdentityHash(`${identities.stdout}\n${identities.stderr}`, identityName)) {
    run("codesign", codesignArgs(appPath, identityName));
    return;
  }

  const verify = run("codesign", ["--verify", "--deep", "--strict", appPath], { allowFailure: true });
  const details = run("codesign", ["-dv", "--verbose=4", appPath], { allowFailure: true });
  const detailsText = `${details.stdout}\n${details.stderr}`;
  if (verify.status === 0 && !hasAdhocSignature(detailsText)) return;

  fail(
    `No stable macOS signing identity named "${identityName}" was found. ` +
      "Run scripts/ensure-local-codesign-identity.mjs as the console user, rebuild, and reinstall."
  );
}

function fail(message) {
  console.error(message);
  if (process.getuid?.() !== 0) {
    console.error("For all-user autostart, run this installer with sudo.");
  }
  process.exit(1);
}
