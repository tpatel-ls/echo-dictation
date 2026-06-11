import type { EchoApi } from '@shared/types'

declare global {
  interface Window {
    api: EchoApi
  }
}

export {}
