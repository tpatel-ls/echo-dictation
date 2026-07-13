import { describe, expect, it, vi } from 'vitest'
import { basename, dirname, join } from 'node:path'
import { writeFileAtomic, type AtomicFileOperations } from '../src/main/store/atomic-file'

function operations(overrides: Partial<AtomicFileOperations> = {}): AtomicFileOperations {
  return {
    writeFile: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
    createSuffix: () => 'test-write',
    ...overrides
  }
}

function temporaryPath(path: string): string {
  return join(dirname(path), `.${basename(path)}.test-write.tmp`)
}

describe('writeFileAtomic', () => {
  it('writes beside the destination before atomically replacing it', () => {
    const fs = operations()

    writeFileAtomic('/data/echo/settings.json', '{"ok":true}', {}, fs)

    expect(fs.writeFile).toHaveBeenCalledWith(
      temporaryPath('/data/echo/settings.json'),
      '{"ok":true}',
      undefined
    )
    expect(fs.rename).toHaveBeenCalledWith(
      temporaryPath('/data/echo/settings.json'),
      '/data/echo/settings.json'
    )
    expect(fs.remove).not.toHaveBeenCalled()
  })

  it('forwards restrictive file modes', () => {
    const fs = operations()

    writeFileAtomic('/data/secrets.bin', 'secret', { mode: 0o600 }, fs)

    expect(fs.writeFile).toHaveBeenCalledWith(
      temporaryPath('/data/secrets.bin'),
      'secret',
      { mode: 0o600 }
    )
  })

  it('removes the temporary file and preserves the error when replacement fails', () => {
    const failure = new Error('disk full')
    const fs = operations({ rename: vi.fn(() => { throw failure }) })

    expect(() => writeFileAtomic('/data/settings.json', '{}', {}, fs)).toThrow(failure)
    expect(fs.remove).toHaveBeenCalledWith(temporaryPath('/data/settings.json'))
  })

  it('does not hide the original error when temporary cleanup also fails', () => {
    const failure = new Error('rename denied')
    const fs = operations({
      rename: vi.fn(() => { throw failure }),
      remove: vi.fn(() => { throw new Error('cleanup denied') })
    })

    expect(() => writeFileAtomic('/data/settings.json', '{}', {}, fs)).toThrow(failure)
  })
})
