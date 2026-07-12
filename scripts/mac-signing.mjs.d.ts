export const LOCAL_CODESIGN_IDENTITY: string
export function findIdentityHash(securityOutput: string, identityName?: string): string | null
export function codesignArgs(appPath: string, identityName?: string): string[]
export function hasAdhocSignature(codesignDetailsOutput: string): boolean
