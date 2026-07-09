export const LOCAL_CODESIGN_IDENTITY = "Echo Local Code Signing";

export function findIdentityHash(securityOutput, identityName = LOCAL_CODESIGN_IDENTITY) {
  const escaped = identityName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = securityOutput.match(new RegExp(`\\b([A-Fa-f0-9]{10,})\\s+"${escaped}"`));
  return match?.[1] ?? null;
}

export function codesignArgs(appPath, identityName = LOCAL_CODESIGN_IDENTITY) {
  return ["--force", "--deep", "--options", "runtime", "--sign", identityName, appPath];
}

export function hasAdhocSignature(codesignDetailsOutput) {
  return /\bSignature=adhoc\b/.test(codesignDetailsOutput);
}
