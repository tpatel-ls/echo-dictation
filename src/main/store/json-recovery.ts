import { existsSync, readFileSync, renameSync } from 'node:fs'

export interface JsonRecoveryOperations {
  exists(path: string): boolean
  read(path: string): string
  rename(from: string, to: string): void
  now(): Date
}

const nodeOperations: JsonRecoveryOperations = {
  exists: existsSync,
  read: (path) => readFileSync(path, 'utf8'),
  rename: renameSync,
  now: () => new Date()
}

export function readJsonWithRecovery<T>(
  path: string,
  operations: JsonRecoveryOperations = nodeOperations
): T | null {
  if (!operations.exists(path)) return null

  let raw: string
  try {
    raw = operations.read(path)
  } catch {
    return null
  }

  try {
    return JSON.parse(raw) as T
  } catch {
    const timestamp = operations.now().toISOString().replace(/[-:.]/g, '')
    try {
      operations.rename(path, `${path}.corrupt-${timestamp}`)
    } catch {
      // Defaults are still safer than aborting startup on an unreadable backup target.
    }
    return null
  }
}
