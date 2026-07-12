import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs'

export interface RotatingLogOperations {
  exists(path: string): boolean
  size(path: string): number
  append(path: string, data: string): void
  rename(from: string, to: string): void
  remove(path: string): void
}

export interface RotatingLogOptions {
  maxBytes?: number
  backups?: number
}

const nodeOperations: RotatingLogOperations = {
  exists: existsSync,
  size: (path) => statSync(path).size,
  append: appendFileSync,
  rename: renameSync,
  remove: unlinkSync
}

export function appendRotatingLog(
  path: string,
  data: string,
  options: RotatingLogOptions = {},
  operations: RotatingLogOperations = nodeOperations
): void {
  try {
    const maxBytes = Math.max(1, options.maxBytes ?? 64 * 1024)
    const backups = Math.max(0, Math.floor(options.backups ?? 2))
    const bytes = Buffer.from(data)
    const bounded = bytes.length > maxBytes ? bytes.subarray(bytes.length - maxBytes).toString() : data

    if (operations.exists(path) && operations.size(path) + Buffer.byteLength(bounded) > maxBytes) {
      if (backups === 0) {
        operations.remove(path)
      } else {
        const oldest = `${path}.${backups}`
        if (operations.exists(oldest)) operations.remove(oldest)
        for (let index = backups - 1; index >= 1; index--) {
          const source = `${path}.${index}`
          if (operations.exists(source)) operations.rename(source, `${path}.${index + 1}`)
        }
        operations.rename(path, `${path}.1`)
      }
    }
    operations.append(path, bounded)
  } catch {
    // Diagnostics must never affect dictation or startup.
  }
}
