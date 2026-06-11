import { uIOhook, UiohookKey } from 'uiohook-napi'
import { HotkeyMachine, type MachineOptions } from './machine'
import type { TriggerKey } from '@shared/types'

const KEYCODES: Record<TriggerKey, number> = {
  RightControl: UiohookKey.CtrlRight,
  LeftControl: UiohookKey.Ctrl,
  CapsLock: UiohookKey.CapsLock,
  F8: UiohookKey.F8
}

export interface HotkeyCallbacks {
  onStart: () => void
  onStop: (durationMs: number) => void
  onCancel: (reason: 'too-short' | 'other-key') => void
}

interface UiohookKeyEvent {
  keycode: number
}

/**
 * Bridges the global low-level keyboard hook to the pure HotkeyMachine and fires
 * dictation callbacks. Distinguishes the configured trigger key from every other key.
 */
export class HotkeyListener {
  private machine: HotkeyMachine
  private triggerCode: number
  private running = false

  constructor(
    opts: MachineOptions,
    private triggerKey: TriggerKey,
    private cb: HotkeyCallbacks
  ) {
    this.machine = new HotkeyMachine(opts)
    this.triggerCode = KEYCODES[triggerKey]
  }

  get isRunning(): boolean {
    return this.running
  }

  start(): void {
    if (this.running) return
    uIOhook.on('keydown', this.onKeyDown)
    uIOhook.on('keyup', this.onKeyUp)
    uIOhook.start()
    this.running = true
  }

  stop(): void {
    if (!this.running) return
    uIOhook.off('keydown', this.onKeyDown)
    uIOhook.off('keyup', this.onKeyUp)
    try {
      uIOhook.stop()
    } catch {
      /* ignore */
    }
    this.running = false
  }

  update(opts: MachineOptions, triggerKey: TriggerKey): void {
    this.triggerKey = triggerKey
    this.triggerCode = KEYCODES[triggerKey]
    this.machine.setOptions(opts)
  }

  private onKeyDown = (e: UiohookKeyEvent): void => {
    const t = Date.now()
    if (e.keycode === this.triggerCode) {
      this.dispatch(this.machine.handle({ type: 'trigger-down', t }))
    } else if (this.machine.isActive) {
      this.dispatch(this.machine.handle({ type: 'other-key', t }))
    }
  }

  private onKeyUp = (e: UiohookKeyEvent): void => {
    if (e.keycode !== this.triggerCode) return
    this.dispatch(this.machine.handle({ type: 'trigger-up', t: Date.now() }))
  }

  private dispatch(cmd: ReturnType<HotkeyMachine['handle']>): void {
    if (!cmd) return
    if (cmd.type === 'start') this.cb.onStart()
    else if (cmd.type === 'stop') this.cb.onStop(cmd.durationMs)
    else if (cmd.type === 'cancel') this.cb.onCancel(cmd.reason)
  }
}
