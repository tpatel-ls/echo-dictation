export type BuildChannel = 'stable' | 'beta' | 'nightly' | 'development'

export interface BuildInfo {
  appVersion: string
  platform: string
  arch: string
  runtime: string
  osVersion: string
  channel: BuildChannel
}

export interface BuildInfoInput {
  appVersion: string
  platform: string
  arch: string
  runtimeVersion: string
  nodeVersion: string
  osVersion: string
  packaged: boolean
  channel?: string
}

export function createBuildInfo(input: BuildInfoInput): BuildInfo {
  const known = new Set<BuildChannel>(['stable', 'beta', 'nightly', 'development'])
  const requested = input.channel?.trim().toLowerCase() as BuildChannel | undefined
  const fallback: BuildChannel = input.packaged ? 'stable' : 'development'
  return {
    appVersion: input.appVersion,
    platform: input.platform,
    arch: input.arch,
    runtime: `Electron ${input.runtimeVersion} / Node ${input.nodeVersion}`,
    osVersion: input.osVersion,
    channel: requested && known.has(requested) ? requested : fallback
  }
}

export function formatBuildInfo(info: BuildInfo): string {
  return `Echo ${info.appVersion} · ${info.platform} ${info.osVersion} ${info.arch} · ${info.runtime} · ${info.channel}`
}
