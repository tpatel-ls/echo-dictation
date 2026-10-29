import { describe, expect, it } from 'vitest'
import { authoritativeParticipants, meetParticipants, mergeParticipants, parseMeetControls } from '@shared/meet-controls'

describe('Google Meet controls', () => {
  it('reads joined state, mute, roster and explicit count without treating page text as names', () => {
    const call = parseMeetControls(10, 'chrome.exe', 'Meet - abc-defg-hij', [
      'Leave call (Ctrl + Alt + H)', 'Turn on microphone (ctrl + d)', 'Show everyone (2)',
      'More options for Alex Rivera', 'More options for You', 'More options for Alex Rivera',
      'More options', 'Send a message', 'More options for Alex Rivera presentation'
    ])
    expect(call).toMatchObject({ state: 'joined', micMuted: true, participants: ['Alex Rivera'], participantCount: 2 })
    expect(authoritativeParticipants(meetParticipants(call))).toHaveLength(1)
  })

  it('does not assign a single visible tile to all voices without a complete roster', () => {
    const partial = parseMeetControls(10, 'chrome.exe', 'Meet - abc-defg-hij', ['Leave call', 'More options for Alex Rivera'])
    expect(authoritativeParticipants(meetParticipants(partial))).toEqual([])
    const full = { ...partial, participantCount: 2 }
    expect(authoritativeParticipants(mergeParticipants(meetParticipants(full), meetParticipants(partial)))).toEqual([])
  })

  it('recognizes a left page and leaves unsupported or incomplete controls unknown', () => {
    expect(parseMeetControls(10, 'chrome.exe', 'Meet', ['Rejoin', 'Leave call']).state).toBe('left')
    expect(parseMeetControls(10, 'chrome.exe', 'Meet', ['Meeting details']).state).toBe('unknown')
  })
})
