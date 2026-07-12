import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { findIdentityHash, LOCAL_CODESIGN_IDENTITY } from "./mac-signing.mjs";

const identityName = process.env.ECHO_CODESIGN_IDENTITY || LOCAL_CODESIGN_IDENTITY;
const workDir = join(process.env.HOME || process.cwd(), ".echo-codesign");
const p12Password = process.env.ECHO_CODESIGN_P12_PASSWORD || "echo-local-codesign";
const keychain = join(process.env.HOME || "", "Library/Keychains/login.keychain-db");

if (process.platform !== "darwin") process.exit(0);

if (findIdentityHash(findIdentities(), identityName)) {
  console.log(`Using existing macOS signing identity: ${identityName}`);
  process.exit(0);
}

mkdirSync(workDir, { recursive: true, mode: 0o700 });

const configPath = join(workDir, "openssl.cnf");
const keyPath = join(workDir, "key.pem");
const certPath = join(workDir, "cert.pem");
const p12Path = join(workDir, "cert.p12");

writeFileSync(
  configPath,
  [
    "[req]",
    "prompt = no",
    "distinguished_name = dn",
    "x509_extensions = v3_req",
    "",
    "[dn]",
    `CN = ${identityName}`,
    "O = Echo Local",
    "",
    "[v3_req]",
    "basicConstraints = critical, CA:false",
    "keyUsage = critical, digitalSignature",
    "extendedKeyUsage = codeSigning",
    "subjectKeyIdentifier = hash",
    ""
  ].join("\n"),
  { mode: 0o600 }
);

if (!existsSync(keyPath)) run("openssl", ["genrsa", "-out", keyPath, "2048"]);
run("openssl", ["req", "-new", "-x509", "-days", "3650", "-key", keyPath, "-out", certPath, "-config", configPath]);
run("openssl", [
  "pkcs12",
  "-export",
  "-legacy",
  "-inkey",
  keyPath,
  "-in",
  certPath,
  "-name",
  identityName,
  "-out",
  p12Path,
  "-passout",
  `pass:${p12Password}`
]);
run("security", ["import", p12Path, "-k", keychain, "-P", p12Password, "-T", "/usr/bin/codesign", "-T", "/usr/bin/security"]);

if (!findIdentityHash(findIdentities(), identityName)) {
  fail(`Imported "${identityName}", but security find-identity still does not list it.`);
}
console.log(`Created macOS signing identity: ${identityName}`);

function findIdentities() {
  const result = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
  return `${result.stdout}\n${result.stderr}`;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    const details = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    fail(`${command} ${args.join(" ")} failed${details ? `:\n${details}` : ""}`);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
