import ApplicationServices
import Foundation

let prompt = CommandLine.arguments.contains("--prompt")
let check = CommandLine.arguments.contains("--check") || prompt
let copyMode = CommandLine.arguments.contains("--copy")

func jsonLine(_ fields: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: fields),
     let text = String(data: data, encoding: .utf8) {
    print(text)
    fflush(stdout)
  }
}

func accessibilityTrusted(prompt: Bool) -> Bool {
  let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
  return AXIsProcessTrustedWithOptions([key: prompt] as CFDictionary)
}

if check {
  let trusted = accessibilityTrusted(prompt: prompt)
  jsonLine(["type": "check", "trusted": trusted])
  exit(trusted ? 0 : 2)
}

guard accessibilityTrusted(prompt: false) else {
  jsonLine(["type": "error", "message": "Accessibility permission is not granted"])
  exit(2)
}

let source = CGEventSource(stateID: .hidSystemState)
let commandKey: CGKeyCode = 55
let cKey: CGKeyCode = 8
let vKey: CGKeyCode = 9

func post(_ keyCode: CGKeyCode, down: Bool, flags: CGEventFlags = []) {
  let event = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: down)
  event?.flags = flags
  event?.post(tap: .cghidEventTap)
}

let actionKey = copyMode ? cKey : vKey
post(commandKey, down: true, flags: .maskCommand)
post(actionKey, down: true, flags: .maskCommand)
post(actionKey, down: false, flags: .maskCommand)
post(commandKey, down: false)
jsonLine(["type": copyMode ? "copy" : "paste", "ok": true])
