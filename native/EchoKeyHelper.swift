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

func emitKey(_ key: String, down: Bool, anyOption: Bool) {
  jsonLine([
    "type": "key",
    "key": key,
    "down": down,
    "anyOption": anyOption
  ])
}

jsonLine(["type": "ready"])

let leftOptionCode = CGKeyCode(58)
let rightOptionCode = CGKeyCode(61)
var leftOptionDown = false
var rightOptionDown = false
var eventTap: CFMachPort?

let callback: CGEventTapCallBack = { _, type, event, _ in
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    if let eventTap {
      CGEvent.tapEnable(tap: eventTap, enable: true)
    }
    return Unmanaged.passUnretained(event)
  }

  let keyCode = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
  guard keyCode == leftOptionCode || keyCode == rightOptionCode else {
    return Unmanaged.passUnretained(event)
  }

  let anyOptionFlag = event.flags.contains(.maskAlternate)
  let down: Bool
  if !anyOptionFlag {
    leftOptionDown = false
    rightOptionDown = false
    down = false
  } else if keyCode == leftOptionCode {
    leftOptionDown.toggle()
    down = leftOptionDown
  } else {
    rightOptionDown.toggle()
    down = rightOptionDown
  }
  let anyOption = leftOptionDown || rightOptionDown
  emitKey(keyCode == leftOptionCode ? "leftOption" : "rightOption", down: down, anyOption: anyOption)
  return Unmanaged.passUnretained(event)
}

let mask = CGEventMask(1 << CGEventType.flagsChanged.rawValue)
eventTap = CGEvent.tapCreate(
  tap: .cgSessionEventTap,
  place: .headInsertEventTap,
  options: .listenOnly,
  eventsOfInterest: mask,
  callback: callback,
  userInfo: nil
)

guard let eventTap else {
  jsonLine(["type": "error", "message": "Unable to create keyboard event tap"])
  exit(2)
}

let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: eventTap, enable: true)
CFRunLoopRun()
