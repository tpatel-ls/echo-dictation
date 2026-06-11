// ─────────────────────────────────────────────────────────────────────────────
// Pure push-to-talk state machine. Maps raw key events (+ injected timestamps) to
// dictation commands. No real clock, no real keyboard — fully unit-testable.
// ─────────────────────────────────────────────────────────────────────────────

export type KeyEvent =
  | { type: 'trigger-down'; t: number }
  | { type: 'trigger-up'; t: number }
  | { type: 'other-key'; t: number }

export type DictationCommand =
  | { type: 'start'; t: number }
  | { type: 'stop'; t: number; durationMs: number }
  | { type: 'cancel'; t: number; reason: 'too-short' | 'other-key' }

export interface MachineOptions {
  minHoldMs: number
  cancelOnOtherKey: boolean
}

export class HotkeyMachine {
  private active = false
  private canceled = false
  private startedAt = 0

  constructor(private opts: MachineOptions) {}

  setOptions(opts: MachineOptions): void {
    this.opts = opts
  }

  handle(ev: KeyEvent): DictationCommand | null {
    switch (ev.type) {
      case 'trigger-down':
        if (this.active) return null // auto-repeat while held
        this.active = true
        this.canceled = false
        this.startedAt = ev.t
        return { type: 'start', t: ev.t }

      case 'other-key':
        if (!this.active || this.canceled) return null
        if (!this.opts.cancelOnOtherKey) return null
        this.canceled = true
        this.active = false
        return { type: 'cancel', t: ev.t, reason: 'other-key' }

      case 'trigger-up': {
        if (!this.active) return null
        const durationMs = ev.t - this.startedAt
        this.active = false
        if (this.canceled) return null
        if (durationMs < this.opts.minHoldMs) {
          return { type: 'cancel', t: ev.t, reason: 'too-short' }
        }
        return { type: 'stop', t: ev.t, durationMs }
      }
    }
  }

  get isActive(): boolean {
    return this.active
  }
}
