export interface ToolchainVersions {
  node: string
  npm: string
}

export function checkToolchain(actual: ToolchainVersions): string[]
