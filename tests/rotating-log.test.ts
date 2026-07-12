import { describe, expect, it, vi } from 'vitest'
import { appendRotatingLog, type RotatingLogOperations } from '../src/main/diagnostic-log'

function operations(existing: Record<string, number> = {}): RotatingLogOperations {
  return {
    exists: (path) => path in existing,
    size: (path) => existing[path],
    append: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn()
  }
}

describe('appendRotatingLog', () => {
  it('appends without rotation while the file is below its limit', () => {
    const fs = operations({ '/logs/echo.log': 10 })
    appendRotatingLog('/logs/echo.log', 'next\n', { maxBytes: 100, backups: 2 }, fs)
    expect(fs.append).toHaveBeenCalledWith('/logs/echo.log', 'next\n')
    expect(fs.rename).not.toHaveBeenCalled()
  })

  it('rotates old files before an append would exceed the limit', () => {
    const fs = operations({
      '/logs/echo.log': 98,
      '/logs/echo.log.1': 80,
      '/logs/echo.log.2': 70
    })
    appendRotatingLog('/logs/echo.log', 'next\n', { maxBytes: 100, backups: 2 }, fs)

    expect(fs.remove).toHaveBeenCalledWith('/logs/echo.log.2')
    expect(fs.rename).toHaveBeenNthCalledWith(1, '/logs/echo.log.1', '/logs/echo.log.2')
    expect(fs.rename).toHaveBeenNthCalledWith(2, '/logs/echo.log', '/logs/echo.log.1')
    expect(fs.append).toHaveBeenCalledWith('/logs/echo.log', 'next\n')
  })

  it('bounds a single oversized diagnostic entry', () => {
    const fs = operations()
    appendRotatingLog('/logs/echo.log', '0123456789', { maxBytes: 5, backups: 1 }, fs)
    expect(fs.append).toHaveBeenCalledWith('/logs/echo.log', '56789')
  })

  it('never lets a logging failure affect the app', () => {
    const fs = operations()
    fs.append = vi.fn(() => { throw new Error('disk full') })
    expect(() => appendRotatingLog('/logs/echo.log', 'line', {}, fs)).not.toThrow()
  })
})
