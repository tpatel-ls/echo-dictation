import ApplicationServices
import AppKit
import Foundation

let prompt = CommandLine.arguments.contains("--prompt")
let check = CommandLine.arguments.contains("--check") || prompt

func jsonLine(_ fields: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: fields),
     let text = String(data: data, encoding: .utf8) {
    print(text)
    fflush(stdout)
  }
}

func inputMonitoringTrusted(prompt: Bool) -> Bool {
  if prompt {
    return CGRequestListenEventAccess()
  }

  return CGPreflightListenEventAccess()
}

if check {
  let trusted = inputMonitoringTrusted(prompt: prompt)
  jsonLine(["type": "check", "trusted": trusted, "inputMonitoringTrusted": trusted])
  exit(trusted ? 0 : 2)
}

_ = inputMonitoringTrusted(prompt: false)

var optionDown = false

func emitKey(_ key: String, down: Bool, anyOption: Bool) {
  jsonLine([
    "type": "key",
    "key": key,
    "down": down,
    "anyOption": anyOption
  ])
}

jsonLine(["type": "ready"])

while true {
  let down = CGEventSource.flagsState(.hidSystemState).contains(.maskAlternate)
  if down != optionDown {
    optionDown = down
    // The app defaults to "Either Option"; emit a stable key name so the Electron
    // state machine receives the same down/up shape regardless of keyboard side.
    emitKey("rightOption", down: down, anyOption: down)
  }
  usleep(10_000)
}
