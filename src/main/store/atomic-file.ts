import { renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

export interface AtomicFileOperations {
  writeFile(path: string, data: string, options?: { mode: number }): void
  rename(from: string, to: string): void
  remove(path: string): void
  createSuffix(): string
}

const nodeOperations: AtomicFileOperations = {
  writeFile: (path, data, options) => writeFileSync(path, data, options),
  rename: (from, to) => renameSync(from, to),
  remove: (path) => unlinkSync(path),
  createSuffix: randomUUID
}

export function writeFileAtomic(
  path: string,
  data: string,
  options: { mode?: number } = {},
  operations: AtomicFileOperations = nodeOperations
): void {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${operations.createSuffix()}.tmp`)
  const writeOptions = options.mode === undefined ? undefined : { mode: options.mode }

  try {
    operations.writeFile(temporaryPath, data, writeOptions)
    operations.rename(temporaryPath, path)
  } catch (error) {
    try {
      operations.remove(temporaryPath)
    } catch {
      // The write may have failed before creating the temporary file.
    }
    throw error
  }
}
