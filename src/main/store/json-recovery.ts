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

export interface JsonRecoveryResult<T> {
  value: T | null
  /** False when replacing the original could destroy the only recoverable copy. */
  replaceable: boolean
}

export function readJsonWithRecovery<T>(
  path: string,
  operations: JsonRecoveryOperations = nodeOperations
): T | null {
  return readJsonRecoveryResult<T>(path, operations).value
}

export function readJsonRecoveryResult<T>(
  path: string,
  operations: JsonRecoveryOperations = nodeOperations
): JsonRecoveryResult<T> {
  if (!operations.exists(path)) return { value: null, replaceable: true }

  let raw: string
  try {
    raw = operations.read(path)
  } catch {
    return { value: null, replaceable: false }
  }

  try {
    return { value: JSON.parse(raw) as T, replaceable: true }
  } catch {
    const timestamp = operations.now().toISOString().replace(/[-:.]/g, '')
    try {
      operations.rename(path, `${path}.corrupt-${timestamp}`)
    } catch {
      return { value: null, replaceable: false }
    }
    return { value: null, replaceable: true }
  }
}
