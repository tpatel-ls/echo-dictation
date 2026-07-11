import AVFoundation
import Foundation
import Speech

enum HelperFailure: Error {
  case invalidRequest(String)
  case notAuthorized(String)
  case unavailable(String)
  case emptyResult
}

func jsonLine(_ fields: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: fields),
     let text = String(data: data, encoding: .utf8) {
    FileHandle.standardOutput.write(Data((text + "\n").utf8))
  }
}

func authorizationString(_ status: SFSpeechRecognizerAuthorizationStatus = SFSpeechRecognizer.authorizationStatus()) -> String {
  switch status {
  case .authorized:
    return "authorized"
  case .denied:
    return "denied"
  case .restricted:
    return "restricted"
  case .notDetermined:
    return "not-determined"
  @unknown default:
    return "unknown"
  }
}

func localeID(_ locale: Locale) -> String {
  locale.identifier
}

func legacyLocaleAvailable(_ localeIdentifier: String) -> Bool {
  let locale = Locale(identifier: localeIdentifier)
  guard SFSpeechRecognizer.supportedLocales().contains(locale) else { return false }
  return SFSpeechRecognizer(locale: locale)?.isAvailable ?? false
}

@available(macOS 26.0, *)
func speechAnalyzerStatus(localeIdentifier: String) async -> (available: Bool, localeAvailable: Bool, installedLocales: [String]) {
  let locale = Locale(identifier: localeIdentifier)
  let installed = await SpeechTranscriber.installedLocales.map(localeID)
  let equivalent = await SpeechTranscriber.supportedLocale(equivalentTo: locale)
  return (SpeechTranscriber.isAvailable, equivalent != nil, installed)
}

func statusPayload(type: String, localeIdentifier: String = "en-US") async -> [String: Any] {
  let authorization = authorizationString()
  var engine = "SFSpeechRecognizer"
  var analyzerAvailable = false
  var analyzerLocaleAvailable = false
  var installedLocales: [String] = []

  if #available(macOS 26.0, *) {
    let analyzer = await speechAnalyzerStatus(localeIdentifier: localeIdentifier)
    analyzerAvailable = analyzer.available
    analyzerLocaleAvailable = analyzer.localeAvailable
    installedLocales = analyzer.installedLocales
    if analyzer.available && analyzer.localeAvailable {
      engine = "SpeechAnalyzer"
    }
  }

  return [
    "type": type,
    "engine": engine,
    "authorization": authorization,
    "speechAnalyzerAvailable": analyzerAvailable,
    "localeAvailable": analyzerLocaleAvailable || legacyLocaleAvailable(localeIdentifier),
    "installedLocales": installedLocales
  ]
}

func requestAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
  await withCheckedContinuation { continuation in
    SFSpeechRecognizer.requestAuthorization { status in
      continuation.resume(returning: status)
    }
  }
}

func ensureAuthorized() throws {
  let status = SFSpeechRecognizer.authorizationStatus()
  guard status == .authorized else {
    throw HelperFailure.notAuthorized("Speech Recognition permission is \(authorizationString(status))")
  }
}

@available(macOS 26.0, *)
func transcribeWithSpeechAnalyzer(url: URL, localeIdentifier: String) async throws -> String {
  let locale = Locale(identifier: localeIdentifier)
  guard SpeechTranscriber.isAvailable,
        await SpeechTranscriber.supportedLocale(equivalentTo: locale) != nil else {
    throw HelperFailure.unavailable("SpeechAnalyzer is unavailable for \(localeIdentifier)")
  }

  let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
  let audioFile = try AVAudioFile(forReading: url)
  let analyzer = SpeechAnalyzer(modules: [transcriber])
  let resultTask = Task<String, Error> {
    var latest = ""
    for try await result in transcriber.results {
      let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
      if !text.isEmpty {
        latest = text
      }
    }
    return latest
  }

  do {
    try await analyzer.start(inputAudioFile: audioFile, finishAfterFile: true)
    let text = (try await resultTask.value).trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty {
      throw HelperFailure.emptyResult
    }
    return text
  } catch {
    resultTask.cancel()
    throw error
  }
}

func transcribeWithLegacyRecognizer(url: URL, localeIdentifier: String) async throws -> String {
  let locale = Locale(identifier: localeIdentifier)
  guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else {
    throw HelperFailure.unavailable("SFSpeechRecognizer is unavailable for \(localeIdentifier)")
  }

  let request = SFSpeechURLRecognitionRequest(url: url)
  request.shouldReportPartialResults = false
  request.taskHint = .dictation

  return try await withCheckedThrowingContinuation { continuation in
    let lock = NSLock()
    var finished = false
    var task: SFSpeechRecognitionTask?

    func finish(_ result: Result<String, Error>) {
      lock.lock()
      if finished {
        lock.unlock()
        return
      }
      finished = true
      lock.unlock()
      task?.cancel()
      continuation.resume(with: result)
    }

    task = recognizer.recognitionTask(with: request) { result, error in
      if let result, result.isFinal {
        let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
        finish(text.isEmpty ? .failure(HelperFailure.emptyResult) : .success(text))
      } else if let error {
        finish(.failure(error))
      }
    }

    DispatchQueue.global().asyncAfter(deadline: .now() + 55) {
      finish(.failure(HelperFailure.unavailable("SFSpeechRecognizer timed out")))
    }
  }
}

func transcribe(path: String, localeIdentifier: String) async throws -> (text: String, engine: String) {
  try ensureAuthorized()
  let url = URL(fileURLWithPath: path)
  guard FileManager.default.fileExists(atPath: url.path) else {
    throw HelperFailure.invalidRequest("Audio file does not exist")
  }

  if #available(macOS 26.0, *) {
    do {
      return (try await transcribeWithSpeechAnalyzer(url: url, localeIdentifier: localeIdentifier), "SpeechAnalyzer")
    } catch {
      // Fall through to the mature URL recognizer. Native speech is optional, so a
      // SpeechAnalyzer asset/runtime miss should not prevent a usable fallback.
    }
  }

  return (try await transcribeWithLegacyRecognizer(url: url, localeIdentifier: localeIdentifier), "SFSpeechRecognizer")
}

func errorFields(id: String?, error: Error) -> [String: Any] {
  let code: String
  let message: String
  switch error {
  case HelperFailure.invalidRequest(let detail):
    code = "invalid-request"
    message = detail
  case HelperFailure.notAuthorized(let detail):
    code = "not-authorized"
    message = detail
  case HelperFailure.unavailable(let detail):
    code = "unavailable"
    message = detail
  case HelperFailure.emptyResult:
    code = "empty"
    message = "Speech recognition returned no text"
  default:
    code = "recognition-failed"
    message = String(describing: error)
  }

  var fields: [String: Any] = ["type": "error", "code": code, "message": message]
  if let id {
    fields["id"] = id
  }
  return fields
}

func handle(_ object: [String: Any]) async {
  guard let type = object["type"] as? String else {
    jsonLine(errorFields(id: nil, error: HelperFailure.invalidRequest("Missing type")))
    return
  }

  if type == "check" {
    let locale = object["locale"] as? String ?? "en-US"
    jsonLine(await statusPayload(type: "check", localeIdentifier: locale))
    return
  }

  guard type == "transcribe" else {
    jsonLine(errorFields(id: nil, error: HelperFailure.invalidRequest("Unknown type \(type)")))
    return
  }
  guard let id = object["id"] as? String,
        let path = object["path"] as? String else {
    jsonLine(errorFields(id: object["id"] as? String, error: HelperFailure.invalidRequest("Missing id or path")))
    return
  }

  let locale = object["locale"] as? String ?? "en-US"
  let started = Date()
  do {
    let result = try await transcribe(path: path, localeIdentifier: locale)
    jsonLine([
      "type": "result",
      "id": id,
      "text": result.text,
      "elapsedMs": Int(Date().timeIntervalSince(started) * 1000),
      "engine": result.engine
    ])
  } catch {
    jsonLine(errorFields(id: id, error: error))
  }
}

func decodeLine(_ line: String) -> [String: Any]? {
  guard let data = line.data(using: .utf8),
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    return nil
  }
  return object
}

@main
struct EchoSpeechHelper {
  static func main() async {
    let args = CommandLine.arguments
    if args.contains("--prompt") {
      _ = await requestAuthorization()
      jsonLine(await statusPayload(type: "check"))
      return
    }
    if args.contains("--check") {
      let status = await statusPayload(type: "check")
      jsonLine(status)
      let authorized = (status["authorization"] as? String) == "authorized"
      let available = (status["localeAvailable"] as? Bool) == true
      exit(authorized && available ? 0 : 2)
    }
    if args.contains("--server") {
      jsonLine(await statusPayload(type: "ready"))
    }

    while let line = readLine() {
      guard let object = decodeLine(line) else {
        jsonLine(errorFields(id: nil, error: HelperFailure.invalidRequest("Malformed JSON")))
        continue
      }
      await handle(object)
    }
  }
}
