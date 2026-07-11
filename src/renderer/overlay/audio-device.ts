export interface AudioInputDevice {
  deviceId: string
  label: string
}

export interface ResolvedAudioDevice {
  deviceId: string | undefined
  fellBack: boolean
}

export function resolveAudioDevice(
  preferredDeviceId: string,
  devices: AudioInputDevice[]
): ResolvedAudioDevice {
  if (!preferredDeviceId) return { deviceId: undefined, fellBack: false }
  if (devices.some((device) => device.deviceId === preferredDeviceId)) {
    return { deviceId: preferredDeviceId, fellBack: false }
  }
  return { deviceId: undefined, fellBack: true }
}
